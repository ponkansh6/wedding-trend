import { HATENA_BOOKMARK_TAGS, SOURCE_ITEM_LIMIT } from "@/lib/constants";
import { fetchRssText } from "./base/rss-fetcher";
import { parseFeed, type FeedEntry } from "./base/feed-parser";

export type HatenaBookmarkItem = FeedEntry;

/**
 * はてなブックマークのタグ検索 RSS。
 * URL 形式は実リクエストで動作確認済み: https://b.hatena.ne.jp/search/tag?q={tag}&mode=rss&sort=recent
 * （301 で https://b.hatena.ne.jp/q/{tag}?sort=recent&mode=rss へリダイレクトされる。
 *  fetch はリダイレクトを自動で追従するのでこのままで良い）。
 * レスポンスは RSS 1.0 (RDF) 形式。feed-parser.ts の RDF 対応で吸収する。
 */
function buildTagRssUrl(tag: string): string {
  return `https://b.hatena.ne.jp/search/tag?q=${encodeURIComponent(tag)}&mode=rss&sort=recent`;
}

export async function fetchHatenaBookmark(
  limit = SOURCE_ITEM_LIMIT,
): Promise<HatenaBookmarkItem[]> {
  const results = await Promise.all(
    HATENA_BOOKMARK_TAGS.map(async (tag) => {
      const xml = await fetchRssText(buildTagRssUrl(tag), "hatena-bookmark");
      if (!xml) return [] as HatenaBookmarkItem[];
      return parseFeed(xml);
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
