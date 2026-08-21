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
    it("fetches and parses Hatena Bookmark RSS tags", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => RSS_FIXTURE,
      } as Response);

      const items = await fetchHatenaBookmark(5);
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
    it("fetches and parses ameblo RSS", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => RSS_FIXTURE,
      } as Response);

      const items = await fetchAmeblo(5);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].title).toBe("Test Post 1");
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
