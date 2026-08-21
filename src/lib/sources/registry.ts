import type { PostUpsertInput } from "@/lib/db/repository";
import type { SourceType } from "@/lib/types";
import { fetchHatenaBookmark, type HatenaBookmarkItem } from "./hatena-bookmark";
import { fetchGoogleNews, type GoogleNewsItem } from "./google-news";
import { fetchNote, type NoteItem } from "./note";
import { fetchAmeblo, type AmebloItem } from "./ameblo";

/**
 * ブログレーン（自動 RSS クロール）のソースアダプタ共通インターフェース。
 * T はソースごとの生アイテム型（多くは FeedEntry か、それを拡張したもの）。
 */
export interface SourceAdapter<T> {
  id: string;
  name: string;
  displayName: string;
  sourceType: SourceType;
  fetch: (limit?: number) => Promise<T[]>;
  toPost: (item: T) => PostUpsertInput;
}

export const SOURCE_REGISTRY = {
  "hatena-bookmark": {
    id: "hatena-bookmark",
    name: "Hatena Bookmark",
    displayName: "はてなブックマーク",
    sourceType: "blog",
    fetch: fetchHatenaBookmark,
    toPost: (item: HatenaBookmarkItem): PostUpsertInput => ({
      url: item.link,
      sourceType: "blog",
      sourceId: "hatena-bookmark",
      sourceName: "はてなブックマーク",
      originalTitle: item.title,
      originalExcerpt: item.excerpt,
      author: item.author,
      thumbnailUrl: item.thumbnailUrl,
      publishedAt: item.publishedAt,
    }),
  },
  "google-news": {
    id: "google-news",
    name: "Google News",
    displayName: "Google ニュース",
    sourceType: "blog",
    fetch: fetchGoogleNews,
    toPost: (item: GoogleNewsItem): PostUpsertInput => ({
      url: item.link,
      sourceType: "blog",
      sourceId: "google-news",
      sourceName: "Google ニュース",
      originalTitle: item.title,
      originalExcerpt: item.excerpt,
      author: item.sourceName,
      thumbnailUrl: null,
      publishedAt: item.publishedAt,
    }),
  },
  note: {
    id: "note",
    name: "note",
    displayName: "note",
    sourceType: "blog",
    fetch: fetchNote,
    toPost: (item: NoteItem): PostUpsertInput => ({
      url: item.link,
      sourceType: "blog",
      sourceId: "note",
      sourceName: "note",
      originalTitle: item.title,
      originalExcerpt: item.excerpt,
      author: item.author,
      thumbnailUrl: item.thumbnailUrl,
      publishedAt: item.publishedAt,
    }),
  },
  ameblo: {
    id: "ameblo",
    name: "Ameba Blog",
    displayName: "アメーバブログ",
    sourceType: "blog",
    fetch: fetchAmeblo,
    toPost: (item: AmebloItem): PostUpsertInput => ({
      url: item.link,
      sourceType: "blog",
      sourceId: "ameblo",
      sourceName: "アメーバブログ",
      originalTitle: item.title,
      originalExcerpt: item.excerpt,
      author: item.author,
      thumbnailUrl: item.thumbnailUrl,
      publishedAt: item.publishedAt,
    }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} satisfies Record<string, SourceAdapter<any>>;

export type SourceId = keyof typeof SOURCE_REGISTRY;
export const SOURCE_IDS = Object.keys(SOURCE_REGISTRY) as SourceId[];
