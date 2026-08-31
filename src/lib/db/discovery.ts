/**
 * Purpose: Discovery ledger database operations (discoverySeen, discoveryRun, hashUrl, discovery metrics).
 * When called: Discovery crawler, host crawling ledger.
 */
import { createHash } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { discoverySeen, discoveryRun } from "./schema";
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
