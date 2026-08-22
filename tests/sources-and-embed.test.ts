import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchRssText } from "@/lib/sources/base/rss-fetcher";
import { fetchHatenaBookmark } from "@/lib/sources/hatena-bookmark";
import { fetchGoogleNews } from "@/lib/sources/google-news";
import { fetchNote } from "@/lib/sources/note";
import { fetchAmeblo } from "@/lib/sources/ameblo";
import { fetchOEmbed } from "@/lib/embed/oembed";

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Test Feed</title>
<item>
<title>Test Post 1</title>
<link>https://example.com/post1</link>
<description>Excerpt 1</description>
<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
<author>Author 1</author>
</item>
</channel>
</rss>`;

const GOOGLE_NEWS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Google News</title>
<item>
<title>結婚式トレンド情報 - Wedding News</title>
<link>https://news.google.com/rss/articles/Cnd...</link>
<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
<source url="https://example.com">Wedding News</source>
</item>
</channel>
</rss>`;

describe("Sources and Embed", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("rss-fetcher", () => {
    it("fetches and returns text on 200 OK", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => RSS_FIXTURE,
      } as Response);

      const text = await fetchRssText("https://example.com/rss", "test");
      expect(text).toBe(RSS_FIXTURE);
    });

    it("returns null on non-200 HTTP status", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const text = await fetchRssText("https://example.com/rss", "test");
      expect(text).toBeNull();
    });

    it("returns null on fetch error or timeout", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const text = await fetchRssText("https://example.com/rss", "test");
      expect(text).toBeNull();
    });
  });

  describe("hatena-bookmark adapter", () => {
    // HATENA_BOOKMARK_TAGS は現在空（constants.ts 参照: 内容が議論・炎上寄りの
    // ため一旦停止中）。解析経路の検証にはタグを注入する。
    it("fetches and parses Hatena Bookmark RSS when tags are configured", async () => {
      vi.resetModules();
      vi.doMock("@/lib/constants", async () => {
        const actual = await vi.importActual<typeof import("@/lib/constants")>("@/lib/constants");
        return { ...actual, HATENA_BOOKMARK_TAGS: ["結婚式"] };
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => RSS_FIXTURE,
      } as Response);

      const { fetchHatenaBookmark: fetchWithTags } = await import("@/lib/sources/hatena-bookmark");
      const items = await fetchWithTags(5);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].title).toBe("Test Post 1");
      expect(items[0].link).toBe("https://example.com/post1");
    });

    it("handles fetch failure gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      const items = await fetchHatenaBookmark(5);
      expect(items).toEqual([]);
    });
  });

  describe("google-news adapter", () => {
    it("fetches and parses Google News RSS items and strips source suffix", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => GOOGLE_NEWS_FIXTURE,
      } as Response);

      const items = await fetchGoogleNews(5);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].title).toBe("結婚式トレンド情報");
      expect(items[0].sourceName).toBe("Wedding News");
    });

    it("handles invalid XML or fetch failure gracefully", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "not xml",
      } as Response);

      const items = await fetchGoogleNews(5);
      expect(items).toEqual([]);
    });
  });

  describe("note adapter", () => {
    it("fetches and parses note hashtag RSS", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => RSS_FIXTURE,
      } as Response);

      const items = await fetchNote(5);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].title).toBe("Test Post 1");
    });
  });

  describe("ameblo adapter", () => {
    // AMEBLO_BLOG_IDS は既定で空（constants.ts のコメント参照: ジャンル経由で
    // 発見できるブログは内容が卒花レポではなく実用に耐えないため意図的に空）。
    // アダプタ本体の解析経路を検証するため、ここでは ID を注入する。
    it("fetches and parses ameblo RSS when blog IDs are configured", async () => {
      // 静的 import 済みのモジュールはキャッシュされているため、
      // doMock を効かせるにはレジストリをリセットしてから再 import する。
      vi.resetModules();
      vi.doMock("@/lib/constants", async () => {
        const actual = await vi.importActual<typeof import("@/lib/constants")>("@/lib/constants");
        return { ...actual, AMEBLO_BLOG_IDS: ["some-blog"] };
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => RSS_FIXTURE,
      } as Response);

      const { fetchAmeblo: fetchWithIds } = await import("@/lib/sources/ameblo");
      const items = await fetchWithIds(5);

      expect(items.length).toBeGreaterThan(0);
      expect(items[0].title).toBe("Test Post 1");
      vi.doUnmock("@/lib/constants");
      vi.resetModules();
    });

    // 空リスト時にネットワークを叩かずに [] を返すことは、現在の既定動作その
    // ものなので固定しておく。ここが壊れると死活監視が誤報する。
    it("returns an empty array without any network call when no blog IDs are configured", async () => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const items = await fetchAmeblo(5);

      expect(items).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("oembed", () => {
    it("returns null for unsupported provider", async () => {
      const res = await fetchOEmbed("https://example.com/post");
      expect(res).toBeNull();
    });

    it("fetches oEmbed data successfully for Instagram/TikTok/YouTube", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          html: "<blockquote>embed</blockquote>",
          thumbnail_url: "https://example.com/thumb.jpg",
          author_name: "Author",
          title: "Title",
        }),
      } as Response);

      const res = await fetchOEmbed("https://www.instagram.com/p/ABC123xyz/");
      expect(res).not.toBeNull();
      expect(res?.provider).toBe("instagram");
      expect(res?.title).toBe("Title");
      expect(res?.html).toBe("<blockquote>embed</blockquote>");
    });

    it("returns null on oEmbed HTTP error or exception", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const res = await fetchOEmbed("https://www.tiktok.com/@user/video/123");
      expect(res).toBeNull();
    });
  });
});
