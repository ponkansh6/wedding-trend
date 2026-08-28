import { createHash } from "crypto";
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "./index";
import {
  config,
  posts,
  postUsefulnessCriteria,
  postRationales,
  postPublications,
  postPublicationKinds,
  postRemovals,
  discoverySeen,
  discoveryRun,
  sourcePolicy,
  hostGateState,
  postRetryQueue,
  discoveryHostMetrics,
  evidenceSignalObservations,
} from "./schema";
import type {
  BodyHashKind,
  Category,
  DropReason,
  EmbedProvider,
  HostMetricsBaseline,
  PostStatus,
  RetractionReason,
  RetryLane,
  RetryQueueEntry,
  SourceType,
  TrendTag,
} from "@/lib/types";
import type { UsefulnessCriteria } from "@/lib/scoring/usefulness";

/** `getSourcePolicy` / `upsertSourcePolicy` の行の型（schema から導出）。 */
export type SourcePolicyRow = typeof sourcePolicy.$inferSelect;

/**
 * ingest（RSS クロール）または submit-url（SNS 単発投稿）が渡す、
 * キュレーション前のクロール由来フィールド。
 */
export interface PostUpsertInput {
  url: string;
  sourceType: SourceType;
  sourceId: string;
  sourceName: string;
  originalTitle: string;
  originalExcerpt: string | null;
  author: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  /**
   * 新規挿入時のみ有効（省略時はスキーマ既定の "published"）。
   * submit-url が LLM キュレーションに失敗した投稿を "pending"（要確認）として
   * 保存する場合などに使う。既存行の更新では触らない。
   */
  status?: PostStatus;
}

/** 新規挿入時の values。status は指定があるときだけ含める（省略時はスキーマ既定値を使わせる）。 */
function buildInsertValues(data: PostUpsertInput) {
  return {
    url: data.url,
    sourceType: data.sourceType,
    sourceId: data.sourceId,
    sourceName: data.sourceName,
    originalTitle: data.originalTitle,
    originalExcerpt: data.originalExcerpt,
    author: data.author,
    thumbnailUrl: data.thumbnailUrl,
    publishedAt: data.publishedAt,
    ...(data.status ? { status: data.status } : {}),
  };
}

/**
 * 既存行の再クロール時に上書きするクロール由来フィールドのみ。
 * aiTitle / aiSummary / category / tag / status / embed* / contentHash /
 * curationSignature はここでは触らない（既存のキュレーション・埋め込み状態を保持する）。
 */
function updatableCrawlFields(data: PostUpsertInput) {
  return {
    sourceName: data.sourceName,
    originalTitle: data.originalTitle,
    originalExcerpt: data.originalExcerpt,
    author: data.author,
    thumbnailUrl: data.thumbnailUrl,
    publishedAt: data.publishedAt,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * URL で insert-or-update。まずバッチ実行を試み、失敗したら 1 件ずつにフォールバックする
 * （libsql のバッチ制約や一時的な接続エラーに対する保険）。
 */
export async function upsertPosts(
  items: PostUpsertInput[],
): Promise<{ succeeded: string[]; failed: string[] }> {
  if (items.length === 0) return { succeeded: [], failed: [] };

  try {
    const statements = items.map((data) =>
      db
        .insert(posts)
        .values(buildInsertValues(data))
        .onConflictDoUpdate({
          target: posts.url,
          set: updatableCrawlFields(data),
        }),
    );
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    return { succeeded: items.map((d) => d.url), failed: [] };
  } catch (batchErr) {
    console.warn("[db] batch upsertPosts failed, falling back to individual upserts:", batchErr);
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const data of items) {
      try {
        await db
          .insert(posts)
          .values(buildInsertValues(data))
          .onConflictDoUpdate({ target: posts.url, set: updatableCrawlFields(data) });
        succeeded.push(data.url);
      } catch (err) {
        console.error(`[db] failed to upsert post url="${data.url}":`, err);
        failed.push(data.url);
      }
    }
    return { succeeded, failed };
  }
}

/** キュレーション要否判定・submit-url のレスポンス組み立てに必要な最小限の状態。 */
export interface PostCurationState {
  id: number;
  url: string;
  originalTitle: string;
  originalExcerpt: string | null;
  aiTitle: string | null;
  contentHash: string | null;
  curationSignature: string | null;
  status: PostStatus;
  publishedAt: string | null;
  createdAt: string;
}

/** 指定 URL 群の現在の状態を取得する（キュレーション対象の選定に使う）。 */
export async function getPostsByUrls(urls: string[]): Promise<Map<string, PostCurationState>> {
  const map = new Map<string, PostCurationState>();
  if (urls.length === 0) return map;
  try {
    const CHUNK = 200;
    for (let i = 0; i < urls.length; i += CHUNK) {
      const chunk = urls.slice(i, i + CHUNK);
      const rows = await db
        .select({
          id: posts.id,
          url: posts.url,
          originalTitle: posts.originalTitle,
          originalExcerpt: posts.originalExcerpt,
          aiTitle: posts.aiTitle,
          contentHash: posts.contentHash,
          curationSignature: posts.curationSignature,
          status: posts.status,
          publishedAt: posts.publishedAt,
          createdAt: posts.createdAt,
        })
        .from(posts)
        .where(inArray(posts.url, chunk));
      for (const row of rows) map.set(row.url, row);
    }
    return map;
  } catch (err) {
    console.warn("[db] getPostsByUrls error:", err);
    return map;
  }
}

/** LLM キュレーション結果。markCurated で contentHash / curationSignature も一緒に確定させる。 */
export interface CurationUpdate {
  url: string;
  aiTitle?: string | null;
  aiSummary: string;
  category: Category;
  tag: TrendTag;
  contentHash: string;
  curationSignature: string;
  /** 指定があれば status も一緒に更新する（例: submit-url でのキュレーション失敗 → "pending"）。 */
  status?: PostStatus;
  /**
   * 有用度採点結果（`post_usefulness`）の永続化に必要な追加情報。
   *
   * 省略した場合は `post_usefulness` への書き込みをスキップし、`posts` のみ
   * 更新する。`post_usefulness` は体験談レーン（`sourceType: "blog"`）の掲載順
   * にのみ使う設計（openspec/specs/wedding-trend/spec.md §9.6）のため、
   * SNS 単発投稿（`src/lib/pipeline/submit-url.ts`）はこれを渡さない。
   * また `postId` を解決できなかった投稿（`src/lib/pipeline/ingest.ts` 参照）も
   * 省略し、`posts` 側の更新だけは安全側で行う。
   */
  usefulness?: {
    postId: number;
    criteria: UsefulnessCriteria;
    modelId: string;
  };
  rationale?: {
    postId: number;
    topicAnchor: string | null;
    rationaleText: string | null;
    evidenceSufficient: boolean;
    modelId: string;
    promptVersion: string;
  };
}

/** キュレーション結果を書き込む。バッチ→個別フォールバック。 */
export async function markCurated(
  updates: CurationUpdate[],
): Promise<{ succeeded: string[]; failed: string[] }> {
  if (updates.length === 0) return { succeeded: [], failed: [] };

  // sticky 性の保証点（plan 07 §5-M4 / §7）: `post_removals` に行がある post は
  // 何が起きても status を上書きしない。これが読み取り側フェイルセーフ
  // （`posts.status`）を書き戻しうる唯一の公開系エントリポイントであるため、
  // ここに一箇所だけガードを置く（`isRemoved` / `filterRemoved` の JSDoc 参照）。
  // aiSummary 等の内容更新自体は妨げない（`getFeedCards` が status で弾くため
  // 可視性には影響しない）。
  const urlToId = new Map<string, number>();
  try {
    const idRows = await db
      .select({ id: posts.id, url: posts.url })
      .from(posts)
      .where(
        inArray(
          posts.url,
          updates.map((u) => u.url),
        ),
      );
    for (const row of idRows) urlToId.set(row.url, row.id);
  } catch (err) {
    console.warn("[db] markCurated: url->id resolution for removal-guard failed:", err);
  }
  const removedIds = await filterRemoved([...urlToId.values()]);

  const buildPostSet = (u: CurationUpdate, now: string) => {
    const id = urlToId.get(u.url);
    const isRemovedPost = id !== undefined && removedIds.has(id);
    return {
      ...(u.aiTitle !== undefined ? { aiTitle: u.aiTitle } : {}),
      aiSummary: u.aiSummary,
      category: u.category,
      tag: u.tag,
      contentHash: u.contentHash,
      curationSignature: u.curationSignature,
      updatedAt: now,
      ...(u.status && !isRemovedPost ? { status: u.status } : {}),
    };
  };

  const buildUsefulnessValues = (u: CurationUpdate, now: string) => {
    if (!u.usefulness) return null;
    const { postId, criteria, modelId } = u.usefulness;
    return {
      postId,
      criteriaJson: JSON.stringify(criteria),
      // posts.curationSignature と同じ値を保存する。両者は必ず一致させる
      // （getStaleCurationCandidates は posts.curationSignature だけを見て
      // 再スコア対象を判定するため、ここがズレると検出漏れになる）。
      signature: u.curationSignature,
      modelId,
      scoredAt: now,
    };
  };

  /**
   * 1 件分の posts 更新（＋あれば post_usefulness_criteria upsert）を 1 つの
   * ステートメント配列にまとめる。`posts` の更新と `post_usefulness_criteria` の更新が
   * 食い違わないよう（例: signature だけ更新されて有用度だけ古いまま残る）、
   * この 2 つは常にペアで `db.batch()` に渡し、フォールバック（個別実行）時も
   * ペアのまま実行する。
   */
  const buildStatements = (u: CurationUpdate): unknown[] => {
    const now = new Date().toISOString();
    // posts の update 文と post_usefulness_criteria の insert/upsert 文はビルダーの型が
    // 異なる（drizzle の SQLiteUpdateBase / SQLiteInsertBase）ため、この配列は
    // `unknown[]` として扱う。呼び出し側でどのみち `db.batch()` に渡す直前に
    // `Parameters<typeof db.batch>[0]` へキャストしているため実害はない。
    const stmts: unknown[] = [
      db.update(posts).set(buildPostSet(u, now)).where(eq(posts.url, u.url)),
    ];
    const usefulnessValues = buildUsefulnessValues(u, now);
    if (usefulnessValues) {
      stmts.push(
        db
          .insert(postUsefulnessCriteria)
          .values(usefulnessValues)
          .onConflictDoUpdate({ target: postUsefulnessCriteria.postId, set: usefulnessValues }),
      );
    }
    const rationaleValues =
      u.rationale &&
      u.rationale.evidenceSufficient &&
      u.rationale.topicAnchor !== null &&
      u.rationale.rationaleText !== null
        ? {
            postId: u.rationale.postId,
            topicAnchor: u.rationale.topicAnchor,
            rationaleText: u.rationale.rationaleText,
            evidenceSufficient: u.rationale.evidenceSufficient,
            modelId: u.rationale.modelId,
            promptVersion: u.rationale.promptVersion,
            createdAt: now,
          }
        : null;

    if (rationaleValues) {
      stmts.push(
        db
          .insert(postRationales)
          .values(rationaleValues)
          .onConflictDoUpdate({ target: postRationales.postId, set: rationaleValues }),
      );
    }
    return stmts;
  };

  try {
    const statements = updates.flatMap(buildStatements);
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    return { succeeded: updates.map((u) => u.url), failed: [] };
  } catch (batchErr) {
    console.warn("[db] batch markCurated failed, falling back to individual updates:", batchErr);
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const u of updates) {
      try {
        const stmts = buildStatements(u);
        if (stmts.length > 1) {
          await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
        } else {
          await stmts[0];
        }
        succeeded.push(u.url);
      } catch (err) {
        console.error(`[db] failed to markCurated url="${u.url}":`, err);
        failed.push(u.url);
      }
    }
    return { succeeded, failed };
  }
}

/**
 * LLM キュレーション対象 1 件分の最小限の情報。`src/lib/pipeline/ingest.ts` は
 * 今回の巡回で取得できた投稿（fresh candidates）と、DB から検出した再スコア
 * 対象（stale candidates、`getStaleCurationCandidates` 参照）の両方をこの
 * 共通の形に正規化して扱う。
 *
 * `id` は `post_usefulness` への書き込みに使う `posts.id`。fresh candidates
 * 側で解決できない場合（upsert 失敗・状態読み取り失敗等）は `null` になり得る
 * （その場合 `markCurated` の呼び出し元は `usefulness` を省略し、`posts` 側の
 * 更新のみ安全側で行う）。
 */
export interface CurationCandidate {
  id: number | null;
  url: string;
  originalTitle: string;
  originalExcerpt: string | null;
  publishedAt: string | null;
}

/**
 * 体験談レーン（`sourceType: "blog"`）のうち、`posts.curationSignature` が
 * 最新のプロンプト/モデル（`currentSignature`）と不一致、または一度も
 * キュレーションされていない（`curationSignature` が null）投稿を
 * `publishedAt` 降順で取得する。バックフィル対象（再スコア対象）の選定に使う。
 *
 * ここでの「不一致」は `posts.curationSignature` のみを見ればよく、
 * `post_usefulness.signature` を別途確認する必要はない。`markCurated()` が
 * `posts` と `post_usefulness` を常に同一の `now` ペアで（フォールバック時も
 * 2 文をまとめて）書き込むため、`posts.curationSignature` が最新であれば
 * `post_usefulness.signature` も必ず最新のはずだからである。
 *
 * `sourceType: "blog"` に絞っているのは、有用度スコアが体験談レーンの掲載順
 * にしか使われないため（spec.md §9.6）。SNS 単発投稿を対象に含めても
 * 表示には使われず、Gemini 予算を無駄に消費するだけになる。
 *
 * `publishedAt` は元記事側の情報が欠けている場合に null になり得る。SQLite は
 * ORDER BY ... DESC で NULL を最後に並べるため、公開日不明の投稿はバックフィル
 * の優先順位としては最後に回る（不明な新しさより既知の新しさを優先する）。
 *
 * `runIngest()`（新着優先の上に予算の余りをバックフィルへ回す経路）と
 * `scripts/backfill-usefulness.mjs`（全件強制バックフィル）の両方から
 * 再利用される。読み取り専用のためフェイルソフト（`getFeedCards` と同じ
 * パターン: 例外を投げず空配列を返す）。
 */
export async function getStaleCurationCandidates(params: {
  currentSignature: string;
  limit: number;
  /**
   * 署名に関わらず全ブログ投稿を再スコア対象にする（バックフィル修復用）。
   * 通常運用（ingest のバックフィル）では渡さない。
   */
  force?: boolean;
}): Promise<CurationCandidate[]> {
  if (params.limit <= 0) return [];
  try {
    const whereClause = params.force
      ? eq(posts.sourceType, "blog")
      : and(
          eq(posts.sourceType, "blog"),
          or(isNull(posts.curationSignature), ne(posts.curationSignature, params.currentSignature)),
        );
    const rows = await db
      .select({
        id: posts.id,
        url: posts.url,
        originalTitle: posts.originalTitle,
        originalExcerpt: posts.originalExcerpt,
        publishedAt: posts.publishedAt,
      })
      .from(posts)
      .where(whereClause)
      .orderBy(desc(posts.publishedAt))
      .limit(params.limit);
    return rows;
  } catch (err) {
    console.warn("[db] getStaleCurationCandidates query error:", err);
    return [];
  }
}

export interface EmbedResult {
  embedProvider: EmbedProvider;
  embedHtml: string | null;
  embedFetchedAt: string;
}

/** SNS 埋め込み（oEmbed）結果を保存する。失敗しても呼び出し側は "none" で表示を継続できる。 */
export async function saveEmbed(url: string, embed: EmbedResult): Promise<boolean> {
  try {
    await db
      .update(posts)
      .set({
        embedProvider: embed.embedProvider,
        embedHtml: embed.embedHtml,
        embedFetchedAt: embed.embedFetchedAt,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(posts.url, url));
    return true;
  } catch (err) {
    console.error(`[db] saveEmbed failed for url="${url}":`, err);
    return false;
  }
}

// ── config テーブル（収集トリガーの排他ロック・クールダウン・テレメトリ）──
// 業務ロジック（クールダウン幅・claim/extend の使い分けなど）は
// `src/lib/pipeline/cooldown.ts` / `src/lib/pipeline/ingest.ts` に置き、
// ここでは DB アクセスのみを担う。
//
// 4 つの key を持つ:
// - "ingest_cooldown_until": クールダウンの**期限そのもの**（起点時刻ではなく
//   絶対的な満了時刻の ISO8601 文字列）を保持する。claim（原子的な条件付き
//   確保）と extend（CAS による延長）の 2 段階で書き込まれる。
// - "ingest_lease_until": 実行排他ロック（全経路が必ず取得する）
// - "last_cron_ingest_at": Cron 経路の実行時刻を記録する観測用の値。
//   cooldown・lease とは独立しており、何の判定にも使われない。
// - "last_run_summary": 直近の収集ランの結果を保持する JSON 文字列
//   （`src/lib/pipeline/ingest.ts` の `LastRunSummary` 参照）。テレメトリ用途で、
//   他の 3 キーとは異なり値が ISO8601 ではない（`assertIso8601` を通さない）。
//
// 「原子的な条件付き書き込み」と「無条件上書き」の全操作を `writeConfigValue`
// という単一のヘルパーに集約している（詳細はその JSDoc）。

const INGEST_COOLDOWN_KEY = "ingest_cooldown_until";
const INGEST_LEASE_KEY = "ingest_lease_until";
const LAST_CRON_INGEST_AT_KEY = "last_cron_ingest_at";
const LAST_RUN_SUMMARY_KEY = "last_run_summary";

/**
 * `writeConfigValue` に渡す ISO8601 系の値（`value` / `nowISO` / 条件に含まれる
 * 時刻文字列）が `Date#toISOString()` と同じ形式であることを強制する。
 *
 * ⚠️ なぜこの検証が必須か: `config.value` は cooldown / lease の期限判定で
 * **文字列（辞書順）比較**される（`WHERE config.value <= ?` 等）。ISO8601 以外の
 * 形式――特に SQLite の `datetime('now')` が返す空白区切り形式
 * （`"YYYY-MM-DD HH:MM:SS"`）――が紛れ込むと、空白 (`0x20`) は `"T"` (`0x54`)
 * より辞書順で小さいため、あらゆる `cutoff` に対して常に「期限切れ」と
 * 判定されてしまい、cooldown・lease のいずれも恒久的に無効化される
 * （＝濫用防止が黙って壊れる）。
 *
 * `last_run_summary`（JSON 文字列）はそもそも時刻ではないため、この検証を
 * 通さない（`writeConfigValue` の `validateValue: false` を参照）。
 */
function assertIso8601(value: string, context: string): void {
  const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (!ISO_8601_RE.test(value)) {
    throw new Error(
      `[db] config value for "${context}" must be an ISO8601 string in Date#toISOString() format; got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * 条件付き書き込みの種類。`writeConfigValue` の `options.condition` に渡す。
 *
 * - `"cutoff"`: 保存済みの `value` が `cutoff` **以下**（＝期限切れ、または
 *   行が存在しない）ときのみ書き込む。claim（cooldown の確保）・lease の
 *   取得の両方がこの形。
 * - `"cas"`: 保存済みの `value` が `expected` と**完全一致**し、かつ新しい
 *   `value` の方が辞書順で**後**（＝時系列で後）のときのみ書き込む。
 *   cooldown の延長（extend）専用。「一致」と「単調増加」を単一の WHERE に
 *   畳み込むことで、(a) 自分が確保した期限とは異なる値（＝他の書き手が
 *   新たに確保した期限）を静かに上書きしてしまう事故と、(b) 期限を短縮する
 *   方向への書き込みの両方を同時に防ぐ。
 */
type WriteCondition = { type: "cutoff"; cutoff: string } | { type: "cas"; expected: string };

/**
 * `config` テーブルへの**唯一の書き込み経路**。cooldown（"ingest_cooldown_until"）・
 * lease（"ingest_lease_until"）・観測用キー（"last_cron_ingest_at" /
 * "last_run_summary"）のすべての書き込みがこの関数を経由する。
 *
 * - `options.condition` を省略すると無条件上書き（常に成功、戻り値は常に true）。
 * - `condition` を指定すると、`INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE ...`
 *   という単一の SQL 文で原子的な条件付き書き込みを行う
 *   （drizzle の `onConflictDoUpdate({ setWhere })`）。「読んでから書く」の
 *   2 段構えでは複数リクエストが同時に「まだ有効ではない」と読み取ってから
 *   両方とも書き込んでしまう TOCTOU 競合を避けられないため、読み取りと
 *   書き込みを 1 文に閉じ込めている。SQLite（libsql）は単一の SQL 文の実行中
 *   書き込みロックを保持するため、同時に複数呼ばれても書き込みに成功するのは
 *   高々 1 件に限られる。
 *   - 行が存在しない初回は ON CONFLICT が発火せず通常の INSERT として成功する
 *     （`rowsAffected` = 1 → true）。
 *   - WHERE 条件（`cutoff` 以下、または `cas` の一致＋単調増加）を満たせば
 *     UPDATE が発火する（`rowsAffected` = 1 → true）。
 *   - 満たさなければ WHERE 条件が偽になり UPDATE は発火しない
 *     （`rowsAffected` = 0 → false）。
 * - `options.validateValue: false` を指定すると `value` への `assertIso8601`
 *   検証をスキップする（`last_run_summary` の JSON 値専用。`nowISO` と
 *   `condition` に含まれる時刻文字列は種類によらず常に検証する）。
 *
 * ⚠️ **この関数（＝すべての書き込み経路）は意図的に fail-closed のままにする。
 * クエリ失敗（例: `config` テーブルが存在しない）を握りつぶして `true` や
 * 成功扱いにフォールバックしないこと。** 例外はそのまま呼び出し元に伝播させる
 * （`claimIngestCooldown` / `extendIngestCooldown` / `claimIngestLease` /
 * `releaseIngestLease` いずれもここで catch しない）。テーブルが無い環境で
 * 「クールダウン/lease の取得（＝書き込み）に成功した」と誤認すると、
 * レートリミット・排他ロックという濫用防止機構そのものが丸ごと無効化される
 * ため。これは読み取り専用の `getIngestCooldownValue()` が意図的にフェイルソフト
 * （テーブルが無ければ `null` を返す）にしているのとは非対称であり、その
 * 非対称性は意図的である（詳細は `getIngestCooldownValue` の JSDoc を参照）。
 *
 * `last_run_summary`（`saveLastRunSummary`）はこの原則の例外ではない
 * ――この関数自体は同じく fail-closed（例外を投げる）のままだが、
 * その**呼び出し元**（`src/lib/pipeline/ingest.ts`）がテレメトリ用途として
 * 意図的に catch して握りつぶす。書き込みが本処理（収集ラン）を落としては
 * ならないため。
 */
async function writeConfigValue(
  key: string,
  value: string,
  nowISO: string,
  options?: { condition?: WriteCondition; validateValue?: boolean },
): Promise<boolean> {
  const validateValue = options?.validateValue ?? true;
  if (validateValue) assertIso8601(value, key);
  assertIso8601(nowISO, key);

  const condition = options?.condition;
  let setWhere: ReturnType<typeof lte> | ReturnType<typeof and> | undefined;
  if (condition?.type === "cutoff") {
    assertIso8601(condition.cutoff, key);
    setWhere = lte(config.value, condition.cutoff);
  } else if (condition?.type === "cas") {
    assertIso8601(condition.expected, key);
    setWhere = and(eq(config.value, condition.expected), lt(config.value, value));
  }

  const result = await db
    .insert(config)
    .values({ key, value, updatedAt: nowISO })
    .onConflictDoUpdate({
      target: config.key,
      set: { value, updatedAt: nowISO },
      ...(setWhere ? { setWhere } : {}),
    });
  return condition ? (result.rowsAffected ?? 0) > 0 : true;
}

/**
 * `ingest_cooldown_until` の原子的な確保（claim）。
 *
 * 以前は「起点時刻」（`last_ingest_at`）を保存して都度クールダウン幅を
 * 加算していたが、この関数は**期限そのもの**（`deadlineISO`）を保存する。
 * 保存済みの値が `nowISO` 以下（＝期限切れ、または行が存在しない）のときだけ
 * `deadlineISO` を書き込んで奪取に成功する。詳細は `writeConfigValue` を参照。
 *
 * @param nowISO 現在時刻（＝期限切れ判定のカットオフ）。
 * @param deadlineISO 奪取に成功した場合に保存する新しい期限
 *   （呼び出し元が `now + INGEST_BASE_COOLDOWN_MS` として計算する）。
 * @returns 奪取に成功したら true。
 */
export async function claimIngestCooldown(nowISO: string, deadlineISO: string): Promise<boolean> {
  return writeConfigValue(INGEST_COOLDOWN_KEY, deadlineISO, nowISO, {
    condition: { type: "cutoff", cutoff: nowISO },
  });
}

/**
 * `ingest_cooldown_until` の延長（CAS）。ラン完了後、Gemini を実際に呼んだ
 * 場合のみ呼び出し元（`src/lib/pipeline/cooldown.ts`）から呼ばれる。
 *
 * 保存済みの値が `claimedDeadlineISO`（自分が claim 時点で確保した期限）と
 * **完全一致**し、かつ `newDeadlineISO` の方が新しい（時系列で後）ときのみ
 * 書き換える。CAS にしている理由: 自分の claim 後に他の書き手が新たに
 * cooldown を確保していた場合、その新しい期限を無条件延長で静かに上書きして
 * しまうため。単調増加のみを許すのは、既に確保済みの期限を短縮する方向へ
 * 書き込んでしまう事故（例: 呼び出し順序の入れ替わり）を防ぐため。
 * 詳細は `writeConfigValue` の `WriteCondition["cas"]` を参照。
 *
 * @returns 延長に成功したら true（CAS が一致しなかった場合は false）。
 */
export async function extendIngestCooldown(
  nowISO: string,
  claimedDeadlineISO: string,
  newDeadlineISO: string,
): Promise<boolean> {
  return writeConfigValue(INGEST_COOLDOWN_KEY, newDeadlineISO, nowISO, {
    condition: { type: "cas", expected: claimedDeadlineISO },
  });
}

/**
 * 保存されている `ingest_cooldown_until`（ISO8601 文字列、期限そのもの）。
 * 未設定なら null。**算術（時刻の加算）は一切行わない生の読み取り**であり、
 * 「クールダウン中かどうか」の判定は呼び出し元（`getCooldownUntil`）が
 * `value > now` を比較して行う。
 *
 * **読み取り経路はフェイルソフト**（`src/lib/db/query.ts` の `getFeedCards` と
 * 同じパターン: `try/catch` + `console.warn` + 安全側デフォルトを返す）。
 * マイグレーション未適用の環境（`config` テーブルが存在しない）でもトップ
 * ページの初期描画（`getIngestCooldown()` 経由）がクラッシュしないようにする
 * ための意図的な設計。テーブルが無い＝一度も実行されていない、と解釈するのは
 * 意味的にも妥当（`null` は「クールダウンなし＝ボタンが押せる」を表す）。
 *
 * ⚠️ この読み取り経路のフェイルソフトは、**書き込み経路
 * （`claimIngestCooldown` / `extendIngestCooldown` / `claimIngestLease` /
 * `writeConfigValue`）には適用しない**（それらのコメントを参照）。読み取り
 * だけを緩めるのは、失敗時に「実行してよい」と誤認させず、単に「クールダウン
 * 情報が不明＝実行可能とみなしても実害がない読み取り専用の初期表示」に
 * 限定して安全側に倒しているため。書き込み側まで握りつぶすと、`config`
 * テーブルが無い環境で「クールダウン/lease の取得に成功した」と誤認し、
 * レートリミット・排他ロックが丸ごと無効化されてしまう。
 */
export async function getIngestCooldownValue(): Promise<string | null> {
  try {
    const rows = await db
      .select({ value: config.value })
      .from(config)
      .where(eq(config.key, INGEST_COOLDOWN_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn("[db] getIngestCooldownValue query error:", err);
    return null;
  }
}

/**
 * `ingest_lease_until` の原子的な奪取（Compare-And-Swap 相当）。
 * 収集パイプラインの実行排他（同時実行禁止）専用。詳細は `writeConfigValue`
 * を参照。保存されている `value` は「このリースがいつまで有効か」を表す
 * ISO8601 文字列であり、それが `nowISO` 以下（＝期限切れ）の場合にのみ
 * 新しいリース（`leaseUntilISO`）で上書きして奪取に成功する。
 *
 * @param nowISO 現在時刻（＝期限切れ判定のカットオフ）。
 * @param leaseUntilISO 奪取に成功した場合に保存する新しいリース期限
 *   （`now + INGEST_LEASE_TTL_MS`）。
 * @returns 奪取に成功したら true。
 */
export async function claimIngestLease(nowISO: string, leaseUntilISO: string): Promise<boolean> {
  return writeConfigValue(INGEST_LEASE_KEY, leaseUntilISO, nowISO, {
    condition: { type: "cutoff", cutoff: nowISO },
  });
}

/**
 * `ingest_lease_until` を条件なしで「常に期限切れ」な過去日時に上書きし、
 * リースを即座に解放する。実行完了時（成功・失敗いずれも）に `finally` から
 * 呼ばれる想定（詳細は `src/lib/pipeline/cooldown.ts` の `releaseIngestLease`）。
 */
export async function releaseIngestLease(nowISO: string): Promise<void> {
  const EXPIRED = "1970-01-01T00:00:00.000Z";
  await writeConfigValue(INGEST_LEASE_KEY, EXPIRED, nowISO);
}

/**
 * `last_cron_ingest_at` を条件なしで上書きする。Cron 経路（`/api/ingest`）が
 * 実行時刻を記録する観測用の値であり、`ingest_cooldown_until` とは完全に
 * 独立している（Cron はクールダウンの評価も更新も一切行わない。詳細は
 * `src/app/api/ingest/route.ts` の JSDoc を参照）。cooldown・lease のような
 * 排他制御ではなく、単なる「最後にいつ Cron が動いたか」の記録のため無条件
 * 上書きでよい。
 */
export async function recordCronIngestAt(nowISO: string): Promise<void> {
  await writeConfigValue(LAST_CRON_INGEST_AT_KEY, nowISO, nowISO);
}

/**
 * `last_run_summary` に直近の収集ラン結果を JSON 文字列として無条件保存する。
 * 排他制御の対象ではない（最後に書いたランの結果を常に上書きするだけでよい）
 * ため条件なし。`value` は ISO8601 ではなく JSON なので `validateValue: false`
 * で `assertIso8601` をスキップする。
 *
 * この関数自体は他の書き込み経路と同様に fail-closed（例外を投げる）だが、
 * 呼び出し元（`src/lib/pipeline/ingest.ts`）はテレメトリ用途としてこれを
 * 意図的に catch し、保存失敗で収集ラン自体を失敗させない。
 */
export async function saveLastRunSummary(json: string, nowISO: string): Promise<void> {
  await writeConfigValue(LAST_RUN_SUMMARY_KEY, json, nowISO, { validateValue: false });
}

/**
 * `last_run_summary` の生 JSON 文字列。未保存なら null。
 * JSON としてのパース・スキーマ検証は呼び出し元（`getLastRunSummary`）が行う
 * （ここでは文字列をそのまま返すだけ）。読み取り専用のためフェイルソフト
 * （`getIngestCooldownValue` と同じ方針。詳細はそちらの JSDoc を参照）。
 */
export async function readLastRunSummary(): Promise<string | null> {
  try {
    const rows = await db
      .select({ value: config.value })
      .from(config)
      .where(eq(config.key, LAST_RUN_SUMMARY_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn("[db] readLastRunSummary query error:", err);
    return null;
  }
}

export interface PostRationaleInput {
  topicAnchor: string;
  rationaleText: string;
  evidenceSufficient?: boolean;
  modelId: string;
  promptVersion: string;
}

export async function savePostRationale(postId: number, input: PostRationaleInput): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(postRationales)
    .values({
      postId,
      topicAnchor: input.topicAnchor,
      rationaleText: input.rationaleText,
      evidenceSufficient: input.evidenceSufficient ?? true,
      modelId: input.modelId,
      promptVersion: input.promptVersion,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: postRationales.postId,
      set: {
        topicAnchor: input.topicAnchor,
        rationaleText: input.rationaleText,
        evidenceSufficient: input.evidenceSufficient ?? true,
        modelId: input.modelId,
        promptVersion: input.promptVersion,
      },
    });
}

export async function getRationaleByPostId(postId: number) {
  try {
    const rows = await db
      .select()
      .from(postRationales)
      .where(eq(postRationales.postId, postId))
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[db] getRationaleByPostId error:", err);
    return null;
  }
}

export type DiscoverySeenStatus = "pending" | "fetched" | "skipped";

export function hashUrl(url: string): string {
  const normalized = url.trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

export async function seedDiscoverySeen(
  host: string,
  urls: { url: string; sitemapLastmod?: string | null }[],
): Promise<number> {
  if (urls.length === 0) return 0;
  let insertedCount = 0;
  const now = new Date().toISOString();

  for (const item of urls) {
    const urlHash = hashUrl(item.url);
    try {
      const result = await db.run(
        sql`INSERT OR IGNORE INTO discovery_seen (host, url_hash, url, first_seen_at, sitemap_lastmod, status) VALUES (${host}, ${urlHash}, ${item.url}, ${now}, ${item.sitemapLastmod ?? null}, 'pending')`,
      );
      if (result.rowsAffected && result.rowsAffected > 0) {
        insertedCount++;
      }
    } catch (err) {
      console.warn(`[db] seedDiscoverySeen error for url=${item.url}:`, err);
    }
  }

  return insertedCount;
}

export async function getKnownDiscoveryUrls(host: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const rows = await db
      .select({ url: discoverySeen.url })
      .from(discoverySeen)
      .where(eq(discoverySeen.host, host));
    for (const row of rows) {
      set.add(row.url);
    }
  } catch (err) {
    console.warn("[db] getKnownDiscoveryUrls error:", err);
  }
  return set;
}

export async function setDiscoverySeenStatus(
  host: string,
  url: string,
  status: DiscoverySeenStatus,
): Promise<void> {
  const urlHash = hashUrl(url);
  try {
    await db
      .update(discoverySeen)
      .set({ status })
      .where(and(eq(discoverySeen.host, host), eq(discoverySeen.urlHash, urlHash)));
  } catch (err) {
    console.warn("[db] setDiscoverySeenStatus error:", err);
  }
}

export async function countDiscoverySeenByStatus(
  host: string,
): Promise<{ pending: number; fetched: number; skipped: number }> {
  const counts = { pending: 0, fetched: 0, skipped: 0 };
  try {
    const rows = await db
      .select({
        status: discoverySeen.status,
        count: sql<number>`count(*)`,
      })
      .from(discoverySeen)
      .where(eq(discoverySeen.host, host))
      .groupBy(discoverySeen.status);

    for (const row of rows) {
      if (row.status === "pending" || row.status === "fetched" || row.status === "skipped") {
        counts[row.status] = Number(row.count);
      }
    }
  } catch (err) {
    console.warn("[db] countDiscoverySeenByStatus error:", err);
  }
  return counts;
}

/** 指定ホストの指定ステータスの URL 一覧を返す（発見ランナーの処理対象取得用）。 */
export async function getDiscoveryUrlsByStatus(
  host: string,
  status: DiscoverySeenStatus,
): Promise<string[]> {
  try {
    const rows = await db
      .select({ url: discoverySeen.url })
      .from(discoverySeen)
      .where(and(eq(discoverySeen.host, host), eq(discoverySeen.status, status)));
    return rows.map((row) => row.url);
  } catch (err) {
    console.warn(`[db] getDiscoveryUrlsByStatus error for host=${host}:`, err);
    return [];
  }
}

export async function startDiscoveryRun(host: string): Promise<number> {
  const startedAt = new Date().toISOString();
  try {
    const result = await db.insert(discoveryRun).values({
      host,
      startedAt,
      finishedAt: null,
      sitemapsFetched: 0,
      urlsNew: 0,
      urlsFetched: 0,
      statusCounts: JSON.stringify({ pending: 0, fetched: 0, skipped: 0 }),
      outcome: "running",
    });
    // result.lastInsertRowid or similar in libsql/better-sqlite3
    if (result && typeof result.lastInsertRowid === "number") {
      return Number(result.lastInsertRowid);
    }
    // Fallback: query max id for host
    const latest = await db
      .select({ id: discoveryRun.id })
      .from(discoveryRun)
      .where(eq(discoveryRun.host, host))
      .orderBy(desc(discoveryRun.id))
      .limit(1);
    return latest[0]?.id ?? 0;
  } catch (err) {
    console.warn("[db] startDiscoveryRun error:", err);
    return 0;
  }
}

export async function finishDiscoveryRun(
  id: number,
  patch: {
    sitemapsFetched: number;
    urlsNew: number;
    urlsFetched: number;
    statusCounts: { pending: number; fetched: number; skipped: number };
    outcome: "seeded" | "completed" | "completed_lastmod_distrusted" | "aborted" | "failed";
  },
): Promise<void> {
  const finishedAt = new Date().toISOString();
  try {
    await db
      .update(discoveryRun)
      .set({
        finishedAt,
        sitemapsFetched: patch.sitemapsFetched,
        urlsNew: patch.urlsNew,
        urlsFetched: patch.urlsFetched,
        statusCounts: JSON.stringify(patch.statusCounts),
        outcome: patch.outcome,
      })
      .where(eq(discoveryRun.id, id));
  } catch (err) {
    console.warn("[db] finishDiscoveryRun error:", err);
  }
}

/**
 * discovery_run の最終実行開始時刻（全ホスト横断・最新1件）を返す。
 * GitHub Actions の schedule は 60日 inactivity で自動停止するため、
 * その検知（週次監視）に使う（plan 06 §5.5）。読み取り専用。
 */
export async function getLatestDiscoveryRunStartedAt(): Promise<string | null> {
  try {
    const rows = await db
      .select({ startedAt: discoveryRun.startedAt })
      .from(discoveryRun)
      .orderBy(desc(discoveryRun.startedAt))
      .limit(1);
    return rows[0]?.startedAt ?? null;
  } catch (err) {
    console.warn("[db] getLatestDiscoveryRunStartedAt error:", err);
    return null;
  }
}

/** ホストの robots / 規約ポリシー行を取得する（M3 / K2）。 */
export async function getSourcePolicy(host: string): Promise<SourcePolicyRow | null> {
  try {
    const rows = await db.select().from(sourcePolicy).where(eq(sourcePolicy.host, host)).limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.warn("[db] getSourcePolicy error:", err);
    return null;
  }
}

/**
 * ホストの robots / 規約ポリシー行を upsert する（M3 / K2）。
 * `tosUrl` / `tosHash` を必須（`string | null`）にしているのは、K2（規約変更検知）
 * の実装で `tos_hash` が「休眠カラムのまま残る」状態（plan 07 §5-M3 の禁止事項）
 * を構造的に避けるため。規約 URL/ハッシュが無いホストは呼び出し側が明示的に
 * `null` を渡す。
 */
export async function upsertSourcePolicy(row: {
  host: string;
  robotsHash: string;
  robotsBody: string;
  tosUrl: string | null;
  tosHash: string | null;
  checkedAt: string;
}): Promise<void> {
  try {
    await db
      .insert(sourcePolicy)
      .values({
        host: row.host,
        robotsHash: row.robotsHash,
        robotsBody: row.robotsBody,
        tosUrl: row.tosUrl,
        tosHash: row.tosHash,
        checkedAt: row.checkedAt,
      })
      .onConflictDoUpdate({
        target: sourcePolicy.host,
        set: {
          robotsHash: row.robotsHash,
          robotsBody: row.robotsBody,
          tosUrl: row.tosUrl,
          tosHash: row.tosHash,
          checkedAt: row.checkedAt,
        },
      });
  } catch (err) {
    console.warn("[db] upsertSourcePolicy error:", err);
  }
}

export async function getDiscoveryCursor(host: string): Promise<string | null> {
  const key = `discovery:cursor:${host}`;
  try {
    const rows = await db
      .select({ value: config.value })
      .from(config)
      .where(eq(config.key, key))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn(`[db] getDiscoveryCursor query error for host=${host}:`, err);
    return null;
  }
}

export async function setDiscoveryCursor(host: string, cursorISO: string): Promise<void> {
  const key = `discovery:cursor:${host}`;
  await writeConfigValue(key, cursorISO, new Date().toISOString());
}

/** ホスト単位のアクセス規律（kill gate）状態。 */
export interface HostGateState {
  host: string;
  /** 最後に状態を変えた gate の識別子（K1/K3/K4/K5/K6…）。稼働中は null。 */
  gateId: string | null;
  /** null=稼働中 / "cooloff"=一時停止（untilAt まで）/ "stopped"=K1 由来の人手復帰待ち / "permanent"=恒久停止 */
  stateKind: string | null;
  /** cooloff の有効期限（ISO 8601）。permanent/stopped では null。 */
  untilAt: string | null;
  /** K4（記事 403）の連続ストライク数。 */
  k4Strikes: number;
  /** 直近の 429 発生時刻（ISO 8601）。K6 の 24h 判定に使う。 */
  last429At: string | null;
  /** B1 日次カウンタの UTC 日付キー（YYYY-MM-DD）。 */
  countDay: string;
  /** B1 日次カウンタの値。 */
  countValue: number;
}

/**
 * ホスト単位の kill gate 状態を取得する（行が無ければ `null`）。
 *
 * `config` KV が ISO 8601 カーソル専用であるため、gate 識別子やストライク数
 * といった非 ISO の状態値は `host_gate_state` テーブルに永続化する
 * （plan 06 §6 の「config KV はカーソルだけ」の純粋性を維持する）。
 */
export async function getHostGateState(host: string): Promise<HostGateState | null> {
  try {
    const rows = await db.select().from(hostGateState).where(eq(hostGateState.host, host)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      host: row.host,
      gateId: row.gateId,
      stateKind: row.stateKind,
      untilAt: row.untilAt,
      k4Strikes: row.k4Strikes,
      last429At: row.last429At,
      countDay: row.countDay,
      countValue: row.countValue,
    };
  } catch (err) {
    console.warn(`[db] getHostGateState query error for host=${host}:`, err);
    return null;
  }
}

/**
 * ホスト単位の kill gate 状態を行ごと upsert する（read-modify-write 前提）。
 *
 * 書き込み失敗時は例外を握りつぶす（fail-open）。kill gate は実レスポンスから
 * 決定的に再誘発されるため、永続化漏れは次回の同レスポンスで再適用され、
 * 収集ラン全体を落とすより被害が小さい。ただし B1 日次カウンタのみ
 * 再構成不能なため、失敗時は警告ログで検知可能にしておく。
 */
export async function saveHostGateState(state: HostGateState): Promise<void> {
  const updatedAt = new Date().toISOString();
  try {
    await db
      .insert(hostGateState)
      .values({ ...state, updatedAt })
      .onConflictDoUpdate({
        target: hostGateState.host,
        set: {
          gateId: state.gateId,
          stateKind: state.stateKind,
          untilAt: state.untilAt,
          k4Strikes: state.k4Strikes,
          last429At: state.last429At,
          countDay: state.countDay,
          countValue: state.countValue,
          updatedAt,
        },
      });
  } catch (err) {
    console.warn(`[db] saveHostGateState error for host=${state.host}:`, err);
  }
}

// ── plan 07: 無人運転のデータ層契約（副表方式）────────────────────
// posts への ALTER を全廃し、公開判断の副表 `post_publications`（M4/Q4）と
// 終端理由の真実の源 `post_removals`（§7/M4）に分離する
// （`scripts/apply-migrations-remote.mjs` が共有本番 DB に対して CREATE TABLE /
// CREATE INDEX 以外を許可しないため。`post_usefulness_criteria` と同じ理由・
// 同じパターン）。`posts.status` は読み取り側のフェイルセーフとして併用する
// （`markRetracted` / `markDropped` の JSDoc 参照）。

/**
 * `post_publications` への upsert。M4 のジョブが以下の 2 通りで呼ぶ:
 * - 新規公開時: `publishedAt` = 本システムが公開した時刻、`bodyHash` = 判定時点の
 *   正規化本文ハッシュ。
 * - 自己修復シード時（`listPublishedForRevalidation` が行の無い公開済み post を
 *   返した場合）: `publishedAt` には **`posts.createdAt`（本システムが取り込んだ
 *   時刻）を使うこと**。ここで現在時刻や元記事側の `publishedAt` を入れると、
 *   本来ずっと前に公開されていた post が「たった今公開された」ものとして
 *   Q4（日次公開上限・ホストシェア上限）のレート計算に混入し、偽のバーストを
 *   引き起こす（結線・実際のシード呼び出しは別レーンが行う）。
 *
 * 「最初の理由が勝つ」不可逆性を要求する `post_removals` とは異なり、こちらは
 * 再検証のたびに `bodyHash` を更新してよいテーブルのため `onConflictDoUpdate`
 * を使う。
 */
/**
 * TTL 付き再試行キューへの投入（upsert）。一時的技術障害
 * （fetch_transient / llm_transient / rate_capped）のみを対象とする
 * （§7・§10: 抽出不足・接地失敗・判定不一致の再試行は明示的に禁止）。
 */
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
