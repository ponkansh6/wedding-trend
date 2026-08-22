import { eq, inArray, lte } from "drizzle-orm";
import { db } from "./index";
import { config, posts } from "./schema";
import type { Category, EmbedProvider, PostStatus, SourceType, TrendTag } from "@/lib/types";

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
  aiTitle: string;
  aiSummary: string;
  category: Category;
  tag: TrendTag;
  contentHash: string;
  curationSignature: string;
  /** 指定があれば status も一緒に更新する（例: submit-url でのキュレーション失敗 → "pending"）。 */
  status?: PostStatus;
}

/** キュレーション結果を書き込む。バッチ→個別フォールバック。 */
export async function markCurated(
  updates: CurationUpdate[],
): Promise<{ succeeded: string[]; failed: string[] }> {
  if (updates.length === 0) return { succeeded: [], failed: [] };

  const buildSet = (u: CurationUpdate) => ({
    aiTitle: u.aiTitle,
    aiSummary: u.aiSummary,
    category: u.category,
    tag: u.tag,
    contentHash: u.contentHash,
    curationSignature: u.curationSignature,
    updatedAt: new Date().toISOString(),
    ...(u.status ? { status: u.status } : {}),
  });

  try {
    const statements = updates.map((u) =>
      db.update(posts).set(buildSet(u)).where(eq(posts.url, u.url)),
    );
    await db.batch(statements as unknown as Parameters<typeof db.batch>[0]);
    return { succeeded: updates.map((u) => u.url), failed: [] };
  } catch (batchErr) {
    console.warn("[db] batch markCurated failed, falling back to individual updates:", batchErr);
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const u of updates) {
      try {
        await db.update(posts).set(buildSet(u)).where(eq(posts.url, u.url));
        succeeded.push(u.url);
      } catch (err) {
        console.error(`[db] failed to markCurated url="${u.url}":`, err);
        failed.push(u.url);
      }
    }
    return { succeeded, failed };
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

// ── config テーブル（収集トリガーの排他ロック・グローバルクールダウン）──
// 業務ロジック（4時間/10分という時間幅・cooldownUntil の算出）は
// `src/lib/pipeline/cooldown.ts` に置き、ここでは DB アクセスのみを担う。
//
// 2 つの key を持つ:
// - "last_ingest_at": グローバルクールダウン（公開ボタン経路のみが評価する）
// - "ingest_lease_until": 実行排他ロック（全経路が必ず取得する）
// 両方とも「原子的な条件付き書き込み」と「無条件上書き」の 2 操作を
// `writeConfigValue` という単一のヘルパーに集約している（詳細はその JSDoc）。

const LAST_INGEST_AT_KEY = "last_ingest_at";
const INGEST_LEASE_KEY = "ingest_lease_until";

/**
 * `writeConfigValue` に渡す `value` / `nowISO` / `cutoff` が
 * `Date#toISOString()` と同じ ISO8601 形式であることを強制する。
 *
 * ⚠️ なぜこの検証が必須か: `config.value` は cooldown / lease の期限判定で
 * **文字列（辞書順）比較**される（`WHERE config.value <= ?`）。ISO8601 以外の
 * 形式――特に SQLite の `datetime('now')` が返す空白区切り形式
 * （`"YYYY-MM-DD HH:MM:SS"`）――が紛れ込むと、空白 (`0x20`) は `"T"` (`0x54`)
 * より辞書順で小さいため、あらゆる `cutoff` に対して常に「期限切れ」と
 * 判定されてしまい、cooldown・lease のいずれも恒久的に無効化される
 * （＝濫用防止が黙って壊れる）。
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
 * `config` テーブルへの**唯一の書き込み経路**。cooldown（"last_ingest_at"）と
 * lease（"ingest_lease_until"）の両方の書き込みがこの関数を経由する。
 *
 * - `cutoff` を省略すると無条件上書き（常に成功、戻り値は常に true）。
 * - `cutoff` を指定すると、`INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE
 *   config.value <= cutoff` という単一の SQL 文で原子的な条件付き書き込みを行う
 *   （drizzle の `onConflictDoUpdate({ setWhere })`）。「読んでから書く」の
 *   2 段構えでは複数リクエストが同時に「まだ有効ではない」と読み取ってから
 *   両方とも書き込んでしまう TOCTOU 競合を避けられないため、読み取りと
 *   書き込みを 1 文に閉じ込めている。SQLite（libsql）は単一の SQL 文の実行中
 *   書き込みロックを保持するため、同時に複数呼ばれても書き込みに成功するのは
 *   高々 1 件に限られる。
 *   - 行が存在しない初回は ON CONFLICT が発火せず通常の INSERT として成功する
 *     （`rowsAffected` = 1 → true）。
 *   - 保存済みの `value` が `cutoff` 以下（＝期限切れ）なら UPDATE が発火する
 *     （`rowsAffected` = 1 → true）。
 *   - 保存済みの `value` が `cutoff` より新しい（＝まだ有効）なら WHERE 条件が
 *     偽になり UPDATE は発火しない（`rowsAffected` = 0 → false）。
 *
 * ISO8601 形式の強制については `assertIso8601` を参照。
 *
 * ⚠️ **この関数（＝すべての書き込み経路）は意図的に fail-closed のままにする。
 * クエリ失敗（例: `config` テーブルが存在しない）を握りつぶして `true` や
 * 成功扱いにフォールバックしないこと。** 例外はそのまま呼び出し元に伝播させる
 * （`claimLastIngestAt` / `claimIngestLease` / `setLastIngestAt` /
 * `releaseIngestLease` いずれもここで catch しない）。テーブルが無い環境で
 * 「クールダウン/lease の取得（＝書き込み）に成功した」と誤認すると、
 * レートリミット・排他ロックという濫用防止機構そのものが丸ごと無効化される
 * ため。これは読み取り専用の `getLastIngestAt()` が意図的にフェイルソフト
 * （テーブルが無ければ `null` を返す）にしているのとは非対称であり、その
 * 非対称性は意図的である（詳細は `getLastIngestAt` の JSDoc を参照）。
 */
async function writeConfigValue(
  key: string,
  value: string,
  nowISO: string,
  cutoff?: string,
): Promise<boolean> {
  assertIso8601(value, key);
  assertIso8601(nowISO, key);
  if (cutoff !== undefined) assertIso8601(cutoff, key);

  const result = await db
    .insert(config)
    .values({ key, value, updatedAt: nowISO })
    .onConflictDoUpdate({
      target: config.key,
      set: { value, updatedAt: nowISO },
      ...(cutoff !== undefined ? { setWhere: lte(config.value, cutoff) } : {}),
    });
  return cutoff !== undefined ? (result.rowsAffected ?? 0) > 0 : true;
}

/**
 * `last_ingest_at` の原子的な奪取（Compare-And-Swap 相当）。
 * クールダウン判定用。詳細は `writeConfigValue` を参照。
 *
 * @param nowISO 現在時刻（この呼び出しが奪取に成功した場合に保存する値）。
 * @param cutoffISO `now - INGEST_COOLDOWN_MS` の ISO8601 文字列。
 * @returns 奪取に成功したら true。
 */
export async function claimLastIngestAt(nowISO: string, cutoffISO: string): Promise<boolean> {
  return writeConfigValue(LAST_INGEST_AT_KEY, nowISO, nowISO, cutoffISO);
}

/**
 * `last_ingest_at` を条件なしで上書きする。
 * 収集の実行開始時刻を記録するために、公開ボタン・Cron の両経路から使う
 * （起点を「実行開始時刻」に統一するため。詳細は `src/lib/pipeline/cooldown.ts`）。
 */
export async function setLastIngestAt(nowISO: string): Promise<void> {
  await writeConfigValue(LAST_INGEST_AT_KEY, nowISO, nowISO);
}

/**
 * 保存されている `last_ingest_at`（ISO8601 文字列）。未実行なら null。
 *
 * **読み取り経路はフェイルソフト**（`src/lib/db/query.ts` の `getFeedCards` と
 * 同じパターン: `try/catch` + `console.warn` + 安全側デフォルトを返す）。
 * マイグレーション未適用の環境（`config` テーブルが存在しない）でもトップ
 * ページの初期描画（`getIngestCooldown()` 経由）がクラッシュしないようにする
 * ための意図的な設計。テーブルが無い＝一度も実行されていない、と解釈するのは
 * 意味的にも妥当（`null` は「クールダウンなし＝ボタンが押せる」を表す）。
 *
 * ⚠️ この読み取り経路のフェイルソフトは、**書き込み経路
 * （`claimLastIngestAt` / `claimIngestLease` / `writeConfigValue`）には適用しない**
 * （それらのコメントを参照）。読み取りだけを緩めるのは、失敗時に「実行して
 * よい」と誤認させず、単に「クールダウン情報が不明＝実行可能とみなしても実害
 * がない読み取り専用の初期表示」に限定して安全側に倒しているため。書き込み
 * 側まで握りつぶすと、`config` テーブルが無い環境で「クールダウン/lease の
 * 取得に成功した」と誤認し、濫用防止（レートリミット・排他ロック）が丸ごと
 * 無効化されてしまう。
 */
export async function getLastIngestAt(): Promise<string | null> {
  try {
    const rows = await db
      .select({ value: config.value })
      .from(config)
      .where(eq(config.key, LAST_INGEST_AT_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn("[db] getLastIngestAt query error:", err);
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
  return writeConfigValue(INGEST_LEASE_KEY, leaseUntilISO, nowISO, nowISO);
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
