import { AMEBLO_BLOG_IDS, SOURCE_ITEM_LIMIT } from "@/lib/constants";
import { fetchRssText } from "./base/rss-fetcher";
import { parseFeed, type FeedEntry } from "./base/feed-parser";

export type AmebloItem = FeedEntry;

/**
 * アメーバブログの個別ブログ RSS。
 * https://rssblog.ameba.jp/{blogId}/rss.html は実リクエストで動作確認済み
 * （RSS 1.0 / RDF 形式で返る。feed-parser.ts の RDF 対応で吸収する）。
 * AMEBLO_BLOG_IDS は管理者が編集する対象ブログ ID のリスト（constants.ts 参照）。
 */
function buildBlogRssUrl(blogId: string): string {
  return `https://rssblog.ameba.jp/${encodeURIComponent(blogId)}/rss.html`;
}

export async function fetchAmeblo(limit = SOURCE_ITEM_LIMIT): Promise<AmebloItem[]> {
  const results = await Promise.all(
    AMEBLO_BLOG_IDS.map(async (blogId) => {
      const xml = await fetchRssText(buildBlogRssUrl(blogId), "ameblo");
      if (!xml) return [] as AmebloItem[];
      // 1 ブログあたり最大 10 件（アメーバブログの RSS は元々件数が少なく、
      // 直近投稿のみが対象のため）。
      return parseFeed(xml).slice(0, 10);
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
