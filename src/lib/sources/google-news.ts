import { XMLParser } from "fast-xml-parser";
import { GOOGLE_NEWS_QUERIES, SOURCE_ITEM_LIMIT } from "@/lib/constants";
import { fetchRssText } from "./base/rss-fetcher";
import { decodeEntities, normalizeTitle } from "./base/feed-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface GoogleNewsItem {
  title: string;
  link: string;
  /**
   * Google News RSS の <description> はタイトルへのリンク＋発行元名を再掲した
   * HTML の断片で、原文の実質的な抜粋にはならないため使わない（常に null）。
   */
  excerpt: string | null;
  /** <source> タグの発行元名。著作権上のクレジット表示に使う。 */
  sourceName: string | null;
  publishedAt: string | null;
}

function buildGoogleNewsUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Google News の記事タイトルは "{タイトル} - {発行元}" という形式で返る。
 * <source> タグの発行元名と一致する末尾の " - {発行元}" を取り除き、
 * 元記事本来のタイトルに近づける。
 */
function stripSourceSuffix(title: string, sourceName: string | null): string {
  if (!sourceName) return title;
  const suffix = ` - ${sourceName}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

function parseGoogleNewsItem(raw: unknown): GoogleNewsItem {
  const item = raw as Record<string, unknown>;
  const sourceNode = item.source as Record<string, unknown> | string | undefined;
  const sourceName =
    typeof sourceNode === "string"
      ? decodeEntities(sourceNode)
      : sourceNode && typeof sourceNode === "object" && "#text" in sourceNode
        ? decodeEntities((sourceNode as Record<string, unknown>)["#text"])
        : null;

  const rawTitle = normalizeTitle(item.title);

  return {
    title: stripSourceSuffix(rawTitle, sourceName),
    // news.google.com/rss/articles/... は Google 側のリダイレクトリンクで、
    // ブラウザで開くと元記事へ転送される。原文の直接 URL は RSS からは得られない。
    link: typeof item.link === "string" ? item.link : "",
    excerpt: null,
    sourceName,
    publishedAt: toIsoDate(typeof item.pubDate === "string" ? item.pubDate : undefined),
  };
}

export async function fetchGoogleNews(limit = SOURCE_ITEM_LIMIT): Promise<GoogleNewsItem[]> {
  const results = await Promise.all(
    GOOGLE_NEWS_QUERIES.map(async (query) => {
      const xml = await fetchRssText(buildGoogleNewsUrl(query), "google-news");
      if (!xml) return [] as GoogleNewsItem[];
      try {
        const parsed = parser.parse(xml);
        const rawItems = parsed?.rss?.channel?.item;
        if (!rawItems) return [] as GoogleNewsItem[];
        const items = Array.isArray(rawItems) ? rawItems : [rawItems];
        return items.map(parseGoogleNewsItem);
      } catch (err) {
        console.warn("[google-news] parse error:", err);
        return [] as GoogleNewsItem[];
      }
    }),
  );

  const seen = new Set<string>();
  const deduped = results.flat().filter((item) => {
    if (!item.link || seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });

  return deduped.slice(0, limit);
}
