import { XMLParser } from "fast-xml-parser";
import { RSS_USER_AGENT, LASTMOD_DIFF_ALERT_THRESHOLD, HOST_ALLOWLIST } from "@/lib/constants";
import {
  startDiscoveryRun,
  finishDiscoveryRun,
  getKnownDiscoveryUrls,
  seedDiscoverySeen,
  countDiscoverySeenByStatus,
  getDiscoveryCursor,
  setDiscoveryCursor,
} from "@/lib/db/repository";

export interface DiscoveryOutcome {
  outcome: "seeded" | "completed" | "completed_lastmod_distrusted" | "failed";
  sitemapsFetched: number;
  urlsNew: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function getText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["#text"] ?? "");
  }
  return "";
}

interface SitemapItem {
  loc: string;
  lastmod: string | null;
}

interface ParsedSitemapContent {
  sitemaps: SitemapItem[];
  urls: SitemapItem[];
}

function parseXmlContent(xmlText: string): ParsedSitemapContent {
  const result = parser.parse(xmlText);
  const sitemaps: SitemapItem[] = [];
  const urls: SitemapItem[] = [];

  const root = result.sitemapindex ?? result.urlset ?? result.feed ?? result;

  const rawSitemaps = root?.sitemap;
  if (rawSitemaps) {
    const list = Array.isArray(rawSitemaps) ? rawSitemaps : [rawSitemaps];
    for (const item of list) {
      if (item && typeof item === "object") {
        const loc = getText((item as Record<string, unknown>).loc).trim();
        const lastmod = getText((item as Record<string, unknown>).lastmod).trim() || null;
        if (loc) {
          sitemaps.push({ loc, lastmod });
        }
      }
    }
  }

  const rawUrls = root?.url ?? root?.entry;
  if (rawUrls) {
    const list = Array.isArray(rawUrls) ? rawUrls : [rawUrls];
    for (const item of list) {
      if (item && typeof item === "object") {
        const loc = getText(
          (item as Record<string, unknown>).loc ?? (item as Record<string, unknown>).link,
        ).trim();
        const lastmod =
          getText(
            (item as Record<string, unknown>).lastmod ?? (item as Record<string, unknown>).updated,
          ).trim() || null;
        if (loc) {
          urls.push({ loc, lastmod });
        }
      }
    }
  }

  return { sitemaps, urls };
}

/**
 * `host` が `HOST_ALLOWLIST` に登録されているホストの場合のみ、記事パスの
 * ホワイトリスト（`articlePathPatterns`）で `url` を検査する。
 * `HOST_ALLOWLIST` 未登録のホスト（本番では discovery-ingest 側の Q3 で
 * 別途弾かれる。テスト用の任意ホスト等）はここではパス制約を持たないため
 * 素通しする——このモジュールは seed 段階の多層防御の一枚目に過ぎず、
 * 最終防衛線は discovery-ingest.ts の取得直前チェック。
 */
function isAllowedForSeeding(host: string, url: string): boolean {
  const entry = HOST_ALLOWLIST.find((h) => h.host === host);
  if (!entry) return true;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return entry.articlePathPatterns.some((pattern) => pattern.test(pathname));
}

function isPathologicalLastmod(lastmod: string | null, allLastmods: string[]): boolean {
  if (!lastmod) return false;
  const time = new Date(lastmod).getTime();
  if (Number.isNaN(time)) return true;

  // Future date > 1 day ahead
  if (time > Date.now() + 24 * 60 * 60 * 1000) {
    return true;
  }

  // All-identical across entries
  if (allLastmods.length > 1 && allLastmods.every((m) => m === lastmod)) {
    return true;
  }

  return false;
}

async function fetchXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": RSS_USER_AGENT,
        Accept: "application/xml,text/xml,application/rss+xml,*/*",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch sitemap ${url}: status ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function discoverNewUrls(
  host: string,
  sitemapUrls: string[],
): Promise<DiscoveryOutcome> {
  const runId = await startDiscoveryRun(host);
  let sitemapsFetched = 0;

  try {
    const knownUrls = await getKnownDiscoveryUrls(host);
    const isSeeding = knownUrls.size === 0;

    const cursor = await getDiscoveryCursor(host);
    const cursorTime = cursor ? new Date(cursor).getTime() : null;

    let allDiscovered: { url: string; sitemapLastmod: string | null }[] = [];
    let usedOptimization = false;

    async function processSitemapUrl(url: string): Promise<{
      childSitemaps: SitemapItem[];
      urlEntries: SitemapItem[];
    }> {
      const xml = await fetchXml(url);
      sitemapsFetched++;
      const parsed = parseXmlContent(xml);
      return { childSitemaps: parsed.sitemaps, urlEntries: parsed.urls };
    }

    const initialFetchResults: {
      url: string;
      childSitemaps: SitemapItem[];
      urlEntries: SitemapItem[];
    }[] = [];

    for (const rootUrl of sitemapUrls) {
      const { childSitemaps, urlEntries } = await processSitemapUrl(rootUrl);
      initialFetchResults.push({ url: rootUrl, childSitemaps, urlEntries });
    }

    const allChildSitemapItems: { loc: string; lastmod: string | null }[] = [];
    for (const r of initialFetchResults) {
      if (r.childSitemaps.length > 0) {
        const childLastmods = r.childSitemaps.map((c) => c.lastmod).filter(Boolean) as string[];
        for (const child of r.childSitemaps) {
          let skip = false;
          const pathological = isPathologicalLastmod(child.lastmod, childLastmods);
          if (!isSeeding && !pathological && child.lastmod && cursorTime) {
            const childTime = new Date(child.lastmod).getTime();
            if (!Number.isNaN(childTime) && childTime <= cursorTime) {
              skip = true;
              usedOptimization = true;
            }
          }
          if (!skip) {
            allChildSitemapItems.push({ loc: child.loc, lastmod: child.lastmod });
          }
        }
      } else {
        for (const u of r.urlEntries) {
          allDiscovered.push({ url: u.loc, sitemapLastmod: u.lastmod });
        }
      }
    }

    for (const child of allChildSitemapItems) {
      const { urlEntries } = await processSitemapUrl(child.loc);
      for (const u of urlEntries) {
        allDiscovered.push({ url: u.loc, sitemapLastmod: u.lastmod });
      }
    }

    const candidateMap = new Map<string, string | null>();
    for (const item of allDiscovered) {
      if (item.url && isAllowedForSeeding(host, item.url)) {
        candidateMap.set(item.url, item.sitemapLastmod);
      }
    }

    let newItems: { url: string; sitemapLastmod: string | null }[] = [];
    for (const [url, lastmod] of candidateMap.entries()) {
      if (!knownUrls.has(url)) {
        newItems.push({ url, sitemapLastmod: lastmod });
      }
    }

    let outcome: DiscoveryOutcome["outcome"] = "completed";

    if (isSeeding) {
      const allToSeed = Array.from(candidateMap.entries()).map(([url, sitemapLastmod]) => ({
        url,
        sitemapLastmod,
      }));
      await seedDiscoverySeen(host, allToSeed);
      outcome = "seeded";
      newItems = [];
    } else {
      if (usedOptimization && newItems.length > LASTMOD_DIFF_ALERT_THRESHOLD) {
        // Redo without optimization (fetch all child sitemaps ignoring cursor)
        sitemapsFetched = 0;
        allDiscovered = [];
        const fullChildSitemapItems: { loc: string; lastmod: string | null }[] = [];

        for (const rootUrl of sitemapUrls) {
          const { childSitemaps, urlEntries } = await processSitemapUrl(rootUrl);
          for (const c of childSitemaps) {
            fullChildSitemapItems.push({ loc: c.loc, lastmod: c.lastmod });
          }
          for (const u of urlEntries) {
            allDiscovered.push({ url: u.loc, sitemapLastmod: u.lastmod });
          }
        }

        for (const child of fullChildSitemapItems) {
          const { urlEntries } = await processSitemapUrl(child.loc);
          for (const u of urlEntries) {
            allDiscovered.push({ url: u.loc, sitemapLastmod: u.lastmod });
          }
        }

        const fullCandidateMap = new Map<string, string | null>();
        for (const item of allDiscovered) {
          if (item.url && isAllowedForSeeding(host, item.url)) {
            fullCandidateMap.set(item.url, item.sitemapLastmod);
          }
        }

        newItems = [];
        for (const [url, lastmod] of fullCandidateMap.entries()) {
          if (!knownUrls.has(url)) {
            newItems.push({ url, sitemapLastmod: lastmod });
          }
        }

        outcome = "completed_lastmod_distrusted";
      }

      if (newItems.length > 0) {
        await seedDiscoverySeen(host, newItems);
      }
    }

    const statusCounts = await countDiscoverySeenByStatus(host);
    await finishDiscoveryRun(runId, {
      sitemapsFetched,
      urlsNew: isSeeding ? 0 : newItems.length,
      urlsFetched: 0,
      statusCounts,
      outcome,
    });

    await setDiscoveryCursor(host, new Date().toISOString());

    return {
      outcome,
      sitemapsFetched,
      urlsNew: isSeeding ? 0 : newItems.length,
    };
  } catch (err) {
    // 無人運転では「失敗した」だけでは原因が追えないため、理由をログに残す
    // （plan 07 §9 Stage 2 の運用確認は理由の分布を前提にしている）。
    console.error(
      `[sitemap-discovery] discovery run failed for host=${host}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    const statusCounts = await countDiscoverySeenByStatus(host);
    await finishDiscoveryRun(runId, {
      sitemapsFetched,
      urlsNew: 0,
      urlsFetched: 0,
      statusCounts,
      outcome: "failed",
    });
    return {
      outcome: "failed",
      sitemapsFetched,
      urlsNew: 0,
    };
  }
}
