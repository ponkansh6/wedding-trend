/**
 * Purpose: Publication history, removals, retractions, retry queue, evidence observations, host metrics.
 * When called: Publication pipeline, revalidation, retraction crawler, metrics recording.
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "./index";
import {
  posts,
  postPublications,
  postPublicationKinds,
  postRemovals,
  postRetryQueue,
  discoveryHostMetrics,
  evidenceSignalObservations,
} from "./schema";
import type {
  BodyHashKind,
  DropReason,
  HostMetricsBaseline,
  PostStatus,
  RetractionReason,
  RetryLane,
  RetryQueueEntry,
} from "@/lib/types";
export async function enqueueRetry(entry: RetryQueueEntry): Promise<void> {
  await db
    .insert(postRetryQueue)
    .values({
      urlHash: entry.urlHash,
      url: entry.url,
      host: entry.host,
      lane: entry.lane,
      reason: entry.reason,
      attempts: entry.attempts,
      firstQueuedAt: entry.firstQueuedAt,
      nextAttemptAt: entry.nextAttemptAt,
      expiresAt: entry.expiresAt,
    })
    .onConflictDoUpdate({
      target: postRetryQueue.urlHash,
      set: {
        url: entry.url,
        host: entry.host,
        lane: entry.lane,
        reason: entry.reason,
        attempts: entry.attempts,
        nextAttemptAt: entry.nextAttemptAt,
        expiresAt: entry.expiresAt,
      },
    });
}

/** 再試行時刻が到来した（`nextAttemptAt <= now`）キューエントリを古い順に取得する。 */
export async function dueRetries(now: string, limit: number): Promise<RetryQueueEntry[]> {
  if (limit <= 0) return [];
  try {
    const rows = await db
      .select()
      .from(postRetryQueue)
      .where(lte(postRetryQueue.nextAttemptAt, now))
      .orderBy(postRetryQueue.nextAttemptAt)
      .limit(limit);
    return rows;
  } catch (err) {
    console.warn("[db] dueRetries query error:", err);
    return [];
  }
}

/** 再試行の成功（あるいは再試行を要さない終端処理）でキューから除去する。 */
export async function completeRetry(urlHash: string): Promise<void> {
  await db.delete(postRetryQueue).where(eq(postRetryQueue.urlHash, urlHash));
}

/**
 * TTL（`expires_at <= now`）を超過したキューエントリを削除し、削除した行
 * （`RetryQueueEntry[]`）を返す。`urlHash` だけでは呼び出し元が「どの post を
 * 終端させるか」を解決できない（plan 07 D2 是正）ため、`url` / `host` / `lane`
 * を含む完全な行を返す契約にしている。呼び出し元はこれを使って対応する投稿を
 * `markDropped(id, "retry_exhausted", now)` で終端棄却する（§7）。
 *
 * `lanes` を渡すと、その `lane` に属する行だけを削除・返却する（plan 07 D5）。
 * discovery レーンの消費者（`discovery-ingest.ts`）と rss/evergreen/submit
 * レーンの消費者（`ingest.ts`）は別々のトリガ（ホスト別 discovery ラン /
 * RSS cron）から独立に呼ばれるため、`lanes` を指定せずに両方が呼ぶと、
 * 先に呼ばれた側が他レーンの期限切れ行まで削除してしまい、そのレーンの
 * 消費者が二度と終端化の機会を得られなくなる（D2 と同種の欠陥の再発）。
 * 省略時は従来どおり全レーンを対象にする。
 */
export async function expireRetries(now: string, lanes?: RetryLane[]): Promise<RetryQueueEntry[]> {
  try {
    const condition =
      lanes && lanes.length > 0
        ? and(lte(postRetryQueue.expiresAt, now), inArray(postRetryQueue.lane, lanes))
        : lte(postRetryQueue.expiresAt, now);
    const expired = await db.select().from(postRetryQueue).where(condition);
    if (expired.length > 0) {
      await db.delete(postRetryQueue).where(
        inArray(
          postRetryQueue.urlHash,
          expired.map((row) => row.urlHash),
        ),
      );
    }
    return expired;
  } catch (err) {
    console.warn("[db] expireRetries query error:", err);
    return [];
  }
}

/**
 * `hashKind` は `bodyHash` が実際に取得した記事本文由来（`"body"`）か、
 * 本文を取得しないレーンの代替値（`"surrogate"`）かを必ず明示させる
 * （plan 07 D3 是正）。呼び出し忘れによる暗黙の意味の取り違えを型で防ぐため
 * 省略不可にしている。
 */
export async function recordPublication(
  postId: number,
  publishedAt: string,
  bodyHash: string,
  hashKind: BodyHashKind,
  textLength?: number,
  linkDensity?: number,
  paragraphCount?: number,
): Promise<void> {
  await db
    .insert(postPublications)
    .values({
      postId,
      publishedAt,
      bodyHash,
      ...(textLength !== undefined ? { textLength } : {}),
      ...(linkDensity !== undefined ? { linkDensity } : {}),
      ...(paragraphCount !== undefined ? { paragraphCount } : {}),
    })
    .onConflictDoUpdate({
      target: postPublications.postId,
      set: {
        publishedAt,
        bodyHash,
        ...(textLength !== undefined ? { textLength } : {}),
        ...(linkDensity !== undefined ? { linkDensity } : {}),
        ...(paragraphCount !== undefined ? { paragraphCount } : {}),
      },
    });
  await db.insert(postPublicationKinds).values({ postId, hashKind }).onConflictDoUpdate({
    target: postPublicationKinds.postId,
    set: { hashKind },
  });
}

/**
 * `post_removals` への書き込み共通処理。**`ON CONFLICT DO UPDATE` を書かない**
 * （`INSERT OR IGNORE` 相当）。既に行があれば新しい呼び出しは無視され、
 * 「最初の終端理由が勝つ」という不可逆性・排他性（1 post につき dropped/
 * retracted のどちらか一方のみ）を PK 制約にエンジン側で担保させる。
 *
 * その後 `posts.status` を、実際に勝った（＝現在 `post_removals` にある）
 * `kind` に同期させる。これにより、たとえば先に `retracted` が確定した post に
 * 対して後から `markDropped` が呼ばれても、`posts.status` は "retracted" の
 * ままになる（呼び出し順序に関わらず `post_removals` が真実の源であることを
 * `posts.status` 側にも一貫させるため）。
 */
async function upsertRemovalAndSyncStatus(
  postId: number,
  kind: "dropped" | "retracted",
  reason: string,
  at: string,
): Promise<void> {
  await db
    .insert(postRemovals)
    .values({ postId, kind, reason, removedAt: at })
    .onConflictDoNothing();

  const rows = await db
    .select({ kind: postRemovals.kind })
    .from(postRemovals)
    .where(eq(postRemovals.postId, postId))
    .limit(1);
  const winningKind = rows[0]?.kind ?? kind;

  await db
    .update(posts)
    .set({
      status: winningKind === "retracted" ? "retracted" : "rejected",
      updatedAt: at,
    })
    .where(eq(posts.id, postId));
}

/**
 * 客観トリガ（404/410・robots 不許可・K3・本文ハッシュドリフト）による自動撤回。
 * `post_removals` に kind="retracted" の行を書き（既に行があれば無視）、
 * `posts.status` を実際に勝った kind に同期させる。撤回は sticky
 * （自動復帰しない。plan 07 §5-M4・§10）——sticky 性の保証点は
 * `isRemoved` / `filterRemoved`（公開経路の入口ガード）と、`markCurated` 内の
 * ガード（`post_removals` にある post の status を上書きしない）に集約している。
 */
export async function markRetracted(
  postId: number,
  reason: RetractionReason,
  at: string,
): Promise<void> {
  await upsertRemovalAndSyncStatus(postId, "retracted", reason, at);
}

/**
 * 終端棄却（plan 07 §7）。`post_removals` に kind="dropped" の行を書き
 * （既に行があれば無視）、`posts.status` を実際に勝った kind に同期させる。
 * `DropReason` 型により理由コード必須がコンパイル時に強制される。
 */
export async function markDropped(postId: number, reason: DropReason, at: string): Promise<void> {
  await upsertRemovalAndSyncStatus(postId, "dropped", reason, at);
}

/**
 * `post_removals` に行があるか（sticky 性の保証点）。公開経路はこれを見て
 * 公開を拒否する。単発の判定用。バッチには `filterRemoved` を使う。
 */
export async function isRemoved(postId: number): Promise<boolean> {
  try {
    const rows = await db
      .select({ postId: postRemovals.postId })
      .from(postRemovals)
      .where(eq(postRemovals.postId, postId))
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    console.warn(`[db] isRemoved query error for postId=${postId}:`, err);
    return false;
  }
}

/** `isRemoved` の複数件版（公開バッチ用）。`post_removals` にある postId の集合を返す。 */
export async function filterRemoved(postIds: number[]): Promise<Set<number>> {
  const removed = new Set<number>();
  if (postIds.length === 0) return removed;
  try {
    const rows = await db
      .select({ postId: postRemovals.postId })
      .from(postRemovals)
      .where(inArray(postRemovals.postId, postIds));
    for (const row of rows) removed.add(row.postId);
  } catch (err) {
    console.warn("[db] filterRemoved query error:", err);
  }
  return removed;
}

/**
 * M4 の再検証対象（本文ハッシュドリフト・404/410・robots 変化のチェック用）を
 * 公開中の投稿から取得する。`post_publications` に行の無い公開済み post
 * （この表を追加する前に公開された post）も `LEFT JOIN` で拾う——M4 のジョブが
 * これを自己修復シード対象として検出し、ハッシュを計算して
 * `recordPublication` で行を作る（その回はドリフト判定をしない。結線は
 * 別レーンが行う）。`host` は `url` から導出する（`posts` は host 列を持たない
 * ため）。不正 URL は host を空文字として返す（呼び出し側で除外可能）。
 */
export async function listPublishedForRevalidation(limit: number): Promise<
  Array<{
    id: number;
    url: string;
    host: string;
    bodyHash: string | null;
    /**
     * `null` = `post_publication_kind` に行が無い（この表の導入前に公開された
     * post、または過渡期の未タグ行）。呼び出し側はこれを "body" と断定せず、
     * `HOST_ALLOWLIST` によるホスト判定と併用すること（D3: 本文ドリフト判定は
     * `hashKind === "body"` かつ allowlist ホストの場合のみ適用する）。
     */
    hashKind: BodyHashKind | null;
    publishedAt: string | null;
  }>
> {
  if (limit <= 0) return [];
  try {
    const rows = await db
      .select({
        id: posts.id,
        url: posts.url,
        bodyHash: postPublications.bodyHash,
        hashKind: postPublicationKinds.hashKind,
        publishedAt: postPublications.publishedAt,
      })
      .from(posts)
      .leftJoin(postPublications, eq(posts.id, postPublications.postId))
      .leftJoin(postPublicationKinds, eq(posts.id, postPublicationKinds.postId))
      .where(eq(posts.status, "published"))
      .orderBy(desc(posts.updatedAt))
      .limit(limit);
    return rows.map((row) => {
      let host = "";
      try {
        host = new URL(row.url).host;
      } catch {
        host = "";
      }
      return {
        id: row.id,
        url: row.url,
        host,
        bodyHash: row.bodyHash ?? null,
        hashKind: row.hashKind ?? null,
        publishedAt: row.publishedAt ?? null,
      };
    });
  } catch (err) {
    console.warn("[db] listPublishedForRevalidation query error:", err);
    return [];
  }
}

/** 撤回対象 1 件分の表示用情報（`scripts/retract.mjs` 向け）。 */
export type RetractionCandidate = {
  id: number;
  url: string;
  host: string;
  originalTitle: string;
  status: PostStatus;
};

/**
 * 指定 URL の post を撤回対象候補として取得する（`scripts/retract.mjs` の
 * URL 指定モード用）。`posts.status` が何であっても返す（既に retracted/rejected
 * でも人間が状況確認できるよう隠さない。冪等性の判断は呼び出し側が行う）。
 */
export async function findPostByUrlForRetraction(url: string): Promise<RetractionCandidate | null> {
  try {
    const rows = await db
      .select({
        id: posts.id,
        url: posts.url,
        originalTitle: posts.originalTitle,
        status: posts.status,
      })
      .from(posts)
      .where(eq(posts.url, url))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let host = "";
    try {
      host = new URL(row.url).host;
    } catch {
      host = "";
    }
    return { id: row.id, url: row.url, host, originalTitle: row.originalTitle, status: row.status };
  } catch (err) {
    console.warn(`[db] findPostByUrlForRetraction query error for url="${url}":`, err);
    return null;
  }
}

/**
 * 指定ホストの公開中（`status: "published"`）post を一覧取得する
 * （`scripts/retract.mjs` のホスト指定一括撤回モード用）。`posts` は host 列を
 * 持たないため、全公開中 post を取得してから `url` 由来の host で絞り込む。
 */
export async function listPublishedByHostForRetraction(
  host: string,
): Promise<RetractionCandidate[]> {
  try {
    const rows = await db
      .select({
        id: posts.id,
        url: posts.url,
        originalTitle: posts.originalTitle,
        status: posts.status,
      })
      .from(posts)
      .where(eq(posts.status, "published"));
    const result: RetractionCandidate[] = [];
    for (const row of rows) {
      let rowHost = "";
      try {
        rowHost = new URL(row.url).host;
      } catch {
        rowHost = "";
      }
      if (rowHost === host) {
        result.push({
          id: row.id,
          url: row.url,
          host: rowHost,
          originalTitle: row.originalTitle,
          status: row.status,
        });
      }
    }
    return result;
  } catch (err) {
    console.warn(`[db] listPublishedByHostForRetraction query error for host="${host}":`, err);
    return [];
  }
}

/**
 * 期限を超えて非終端状態（"pending" 等、既知の終端状態
 * published/rejected/retracted 以外）に留まっている post を終端させる（§7）。
 * `posts.createdAt`（取り込み時刻）が `now - staleAfterHours` より前の対象行を
 * status="rejected" + `post_removals`(kind="dropped", reason="stale_pending")
 * に収束させる。
 *
 * applier（`scripts/apply-migrations-remote.mjs`）が縛るのは DDL であって
 * アプリのランタイムではないため、本番に残る legacy な 'pending' 行は
 * マイグレーションの UPDATE ではなく、この定常処理（§7 が元々必要とする reaper）
 * に自然に吸収させる。読み取り時に旧 'pending' を読み替える案は、全読み取り
 * 経路が歴史を永久に知る必要がある恒久的負債になるため採らない。
 *
 * @returns 終端させた件数
 */
export async function reapStaleNonTerminal(now: string, staleAfterHours: number): Promise<number> {
  const cutoff = new Date(new Date(now).getTime() - staleAfterHours * 60 * 60 * 1000).toISOString();
  try {
    const rows = await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          sql`${posts.status} NOT IN ('published', 'rejected', 'retracted')`,
          lte(posts.createdAt, cutoff),
        ),
      );
    for (const row of rows) {
      await upsertRemovalAndSyncStatus(row.id, "dropped", "stale_pending", now);
    }
    return rows.length;
  } catch (err) {
    console.warn("[db] reapStaleNonTerminal query error:", err);
    return 0;
  }
}

/**
 * Q4（日次公開上限）: `post_publications.publishedAt >= sinceIso` の件数。
 * `posts` と JOIN するのは、削除済み・非公開に転じた post をカウントに含めない
 * ため（`post_publications` に行があっても、その後 `retracted` になった post は
 * "現在の公開状況" の上限計算には数えない）。
 */
export async function countPublishedSince(sinceIso: string): Promise<number> {
  try {
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(postPublications)
      .innerJoin(posts, eq(posts.id, postPublications.postId))
      .where(and(eq(posts.status, "published"), gte(postPublications.publishedAt, sinceIso)));
    return Number(rows[0]?.count ?? 0);
  } catch (err) {
    console.warn("[db] countPublishedSince query error:", err);
    return 0;
  }
}

/**
 * Q4（ホストシェア上限）: `post_publications.publishedAt >= sinceIso` の件数を
 * ホスト別に集計する。`posts` は host 列を持たないため `url` から導出する。
 */
export async function countPublishedSinceByHost(sinceIso: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  try {
    const rows = await db
      .select({ url: posts.url })
      .from(postPublications)
      .innerJoin(posts, eq(posts.id, postPublications.postId))
      .where(and(eq(posts.status, "published"), gte(postPublications.publishedAt, sinceIso)));
    for (const row of rows) {
      let host: string;
      try {
        host = new URL(row.url).host;
      } catch {
        continue;
      }
      counts[host] = (counts[host] ?? 0) + 1;
    }
    return counts;
  } catch (err) {
    console.warn("[db] countPublishedSinceByHost query error:", err);
    return counts;
  }
}

/**
 * plan 10 I2: シャドウ記録（オブザーベーション・モード）用のエビデンスシグナル観測データを追加する。
 */
export async function recordEvidenceObservation(data: {
  urlHash: string;
  host: string;
  textLength: number;
  linkDensity: number;
  paragraphCount: number;
  passedGate: boolean;
  failedConditions: string | null;
  observedAt: string;
}): Promise<void> {
  try {
    await db.insert(evidenceSignalObservations).values({
      urlHash: data.urlHash,
      host: data.host,
      textLength: data.textLength,
      linkDensity: data.linkDensity,
      paragraphCount: data.paragraphCount,
      passedGate: data.passedGate,
      failedConditions: data.failedConditions,
      observedAt: data.observedAt,
    });
  } catch (err) {
    console.warn(`[db] recordEvidenceObservation error for urlHash=${data.urlHash}:`, err);
  }
}

/**
 * Q2（K8 yield 崩壊検知）用のホスト×日テレメテレメトリを加算する。既存行が無ければ
 * 0 起点で作成する。`delta` の未指定フィールドは 0 として扱う（加算なし）。
 */
export async function recordHostMetrics(
  host: string,
  day: string,
  delta: {
    processed?: number;
    published?: number;
    dropped?: number;
    promotional?: number;
    authorPresent?: number;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const d = {
    processed: delta.processed ?? 0,
    published: delta.published ?? 0,
    dropped: delta.dropped ?? 0,
    promotional: delta.promotional ?? 0,
    authorPresent: delta.authorPresent ?? 0,
  };
  try {
    await db
      .insert(discoveryHostMetrics)
      .values({ host, day, ...d, updatedAt: now })
      .onConflictDoUpdate({
        target: [discoveryHostMetrics.host, discoveryHostMetrics.day],
        set: {
          processed: sql`${discoveryHostMetrics.processed} + ${d.processed}`,
          published: sql`${discoveryHostMetrics.published} + ${d.published}`,
          dropped: sql`${discoveryHostMetrics.dropped} + ${d.dropped}`,
          promotional: sql`${discoveryHostMetrics.promotional} + ${d.promotional}`,
          authorPresent: sql`${discoveryHostMetrics.authorPresent} + ${d.authorPresent}`,
          updatedAt: now,
        },
      });
  } catch (err) {
    console.warn(`[db] recordHostMetrics error for host=${host}:`, err);
  }
}

/**
 * ホストの直近 `days` 日分のテレメトリを合算し、Q2 のベースライン率を計算する。
 * データが1行も無ければ `null`（呼び出し側は `YIELD_BASELINE_MIN_DAYS` 未満の
 * 実データしかない場合の判断も別途行うこと。ここでは純粋な集計のみを行う）。
 * `days` フィールドには実際に見つかった行数（サンプル数）を返す。
 */
export async function getHostMetricsBaseline(
  host: string,
  days: number,
): Promise<HostMetricsBaseline | null> {
  if (days <= 0) return null;
  try {
    const rows = await db
      .select()
      .from(discoveryHostMetrics)
      .where(eq(discoveryHostMetrics.host, host))
      .orderBy(desc(discoveryHostMetrics.day))
      .limit(days);
    if (rows.length === 0) return null;

    let processed = 0;
    let published = 0;
    let promotional = 0;
    let authorPresent = 0;
    for (const row of rows) {
      processed += row.processed;
      published += row.published;
      promotional += row.promotional;
      authorPresent += row.authorPresent;
    }

    return {
      host,
      days: rows.length,
      publishRate: processed > 0 ? published / processed : 0,
      promotionalRate: processed > 0 ? promotional / processed : 0,
      authorCoverageRate: published > 0 ? authorPresent / published : 0,
    };
  } catch (err) {
    console.warn(`[db] getHostMetricsBaseline query error for host=${host}:`, err);
    return null;
  }
}
