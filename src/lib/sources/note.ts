import { NOTE_HASHTAGS, SOURCE_ITEM_LIMIT } from "@/lib/constants";
import { fetchRssText } from "./base/rss-fetcher";
import { parseFeed, type FeedEntry } from "./base/feed-parser";

export type NoteItem = FeedEntry;

/**
 * note.com のハッシュタグ RSS。
 * https://note.com/hashtag/{tag}/rss は実リクエストで動作確認済み（RSS 2.0 を返す）。
 * サムネイルは <media:thumbnail>、投稿者名は <note:creatorName> に入っており、
 * feed-parser.ts の汎用パーサーがどちらも吸収する。
 */
function buildHashtagRssUrl(tag: string): string {
  return `https://note.com/hashtag/${encodeURIComponent(tag)}/rss`;
}

export async function fetchNote(limit = SOURCE_ITEM_LIMIT): Promise<NoteItem[]> {
  const results = await Promise.all(
    NOTE_HASHTAGS.map(async (tag) => {
      const xml = await fetchRssText(buildHashtagRssUrl(tag), "note");
      if (!xml) return [] as NoteItem[];
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
