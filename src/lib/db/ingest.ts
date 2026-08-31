async function filterRemoved(postIds: number[]): Promise<Set<number>> {
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
 * Purpose: Ingest write & curation database operations (upsertPosts, markCurated, candidates, config, embed, rationales).
 * When called: Ingest pipeline, LLM curation worker, submit-url, cron tasks.
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "./index";
import {
  posts,
  postUsefulnessCriteria,
  postRationales,
  config,
  postRemovals,
  sourcePolicy,
} from "./schema";
import type {
  BodyHashKind,
  Category,
  DropReason,
  EmbedProvider,
  PostStatus,
  SourceType,
  TrendTag,
} from "@/lib/types";
import type { UsefulnessCriteria } from "@/lib/scoring/usefulness";
import type { NonEphemeralString } from "@/lib/types/judgment";
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
  originalExcerpt: NonEphemeralString | null;
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
  originalExcerpt: NonEphemeralString | null;
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
  /**
   * `undefined` を渡すと SET 句から除外され、`posts` の既存値を保持する
   * （`aiTitle` と同じ「防御的 undefined ガード」。`scripts/backfill-usefulness.mjs`
   * の preflight スキップ経路が既存の非 NULL 値を誤って NULL 上書きしていた
   * 退行の再発防止。詳細は `buildPostSet` を参照）。
   * ingest / evergreen / submit-url / discovery-ingest の通常経路は常に
   * 実値を渡すため挙動は変わらない。
   *
   * ⚠️ **このガードは唯一の防御線ではない**: Drizzle の `.set()` はそもそも
   * `undefined` のプロパティを無視する（値を渡さなければ SET 句に載らない）ため、
   * `undefined` を渡す限りこのガードを削除しても実害は出ない
   * （`tests/db.test.ts` の characterization テスト参照）。真の防御線は
   * `scripts/backfill-usefulness.mjs` 側にある: preflight でスキップした候補を
   * `markCurated()` に渡す `updates` 配列にそもそも含めないこと
   * （`scripts/lib/backfill-plan.mjs` の `buildBackfillUpdates` /
   * `tests/backfill-plan.test.ts` が固定している不変条件）。ここのガードは
   * 「`undefined` を渡せば既存値が保持される」という契約を型・コードとして
   * 明示するための defense-in-depth（意図の明示）に過ぎない。
   */
  aiSummary?: string | null;
  category?: Category | null;
  tag?: TrendTag | null;
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
    /** 有用度計算時の curation signature。省略時は `curationSignature` にフォールバック。 */
    signature?: string;
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
      ...(u.aiSummary !== undefined ? { aiSummary: u.aiSummary } : {}),
      ...(u.category !== undefined ? { category: u.category } : {}),
      ...(u.tag !== undefined ? { tag: u.tag } : {}),
      contentHash: u.contentHash,
      curationSignature: u.curationSignature,
      updatedAt: now,
      ...(u.status && !isRemovedPost ? { status: u.status } : {}),
    };
  };

  const buildUsefulnessValues = (u: CurationUpdate, now: string) => {
    if (!u.usefulness) return null;
    const { postId, criteria, modelId, signature } = u.usefulness;
    return {
      postId,
      criteriaJson: JSON.stringify(criteria),
      // 有用度計算時の curation signature を保存する（`u.usefulness.signature` 優先、
      // 無ければ `u.curationSignature`）。通常のキュレーションでは両者は一致する。
      // バックフィルの gate_degrade（アンカー不採用）では posts.curation_signature を
      // 据え置きつつ有用度だけ前進させることがあるため、この signature は
      // posts.curationSignature 以上（単調増加）となり得る。getStaleCurationCandidates は
      // posts.curationSignature だけを見るため、検出漏れは発生しない。
      signature: signature ?? u.curationSignature,
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
  originalExcerpt: NonEphemeralString | null;
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

/**
 * discovery 経路（`originalExcerpt` が常に null。§10-5）で公開済みの blog 投稿の
 * うち、`curationSignature` が最新（`currentSignature`）と不一致・または未設定の
 * ものを `publishedAt` 降順で取得する。
 *
 * `getStaleCurationCandidates()` との違いは 2 点:
 * - `status = "published"` に限定する（フィード表示中の記事だけを修復対象にし、
 *   `rejected` / `retracted` は触らない）。
 * - `originalExcerpt` が空（null / 空白 / 文字列 "null"）のものに限定する。
 *   通常のバックフィル（`scripts/backfill-usefulness.mjs`）はプレフライト
 *   `shouldRegenerateAnchor()` が本文の無い候補を一律スキップするため、
 *   discovery 経路の投稿は署名を更新できず旧基準のトピックアンカーのまま
 *   固定される。この SELECT はその救済（`scripts/backfill-mwed-anchors.mjs`
 *   が本文を規律付き再取得して判定スライスを復元し、再キュレーションする）
 *   専用の候補選定である。判定スライスは §10-5 のとおり DB へは書き戻さない。
 *
 * 読み取り専用のためフェイルソフト（例外を投げず空配列を返す）。
 */
export async function getPublishedSlicelessCurationCandidates(params: {
  currentSignature: string;
  limit: number;
}): Promise<CurationCandidate[]> {
  if (params.limit <= 0) return [];
  try {
    const rows = await db
      .select({
        id: posts.id,
        url: posts.url,
        originalTitle: posts.originalTitle,
        originalExcerpt: posts.originalExcerpt,
        publishedAt: posts.publishedAt,
      })
      .from(posts)
      .where(
        and(
          eq(posts.sourceType, "blog"),
          eq(posts.status, "published"),
          or(isNull(posts.curationSignature), ne(posts.curationSignature, params.currentSignature)),
          or(
            isNull(posts.originalExcerpt),
            eq(sql`trim(coalesce(${posts.originalExcerpt}, ''))`, ""),
            eq(sql`trim(${posts.originalExcerpt})`, "null"),
          ),
        ),
      )
      .orderBy(desc(posts.publishedAt))
      .limit(params.limit);
    return rows;
  } catch (err) {
    console.warn("[db] getPublishedSlicelessCurationCandidates query error:", err);
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
export async function writeConfigValue(
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
