import { eq, inArray } from "drizzle-orm";
import { db } from "./index";
import { posts } from "./schema";
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
