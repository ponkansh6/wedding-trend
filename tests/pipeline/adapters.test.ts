/**
 * Purpose: Stage 6 (S2) Commit 4 のフォローアップ。削除した diff テスト5本が
 * 担保していた「再試行候補構築の正しさ」（`buildRetryCandidate` /
 * `fetchDueRetries`）を、3アダプタ（Rss/Evergreen/Submit）それぞれについて
 * 絶対値テストとして取り戻す。tombstone-post.test.ts と同じ流儀
 * （実 DB の setupTestDb を使い、外部取得系関数をモックする）に倣う。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { RssAdapter } from "@/lib/pipeline/adapters/rss-adapter";
import { EvergreenAdapter } from "@/lib/pipeline/adapters/evergreen-adapter";
import { SubmitAdapter } from "@/lib/pipeline/adapters/submit-adapter";
import { db } from "@/lib/db";
import { posts, postRetryQueue } from "@/lib/db/schema";
import { EVERGREEN_SOURCE_ID } from "@/lib/constants";
import type { RetryQueueEntry } from "@/lib/types";

const { fetchOgpMetadataMock } = vi.hoisted(() => ({
  fetchOgpMetadataMock: vi.fn(),
}));
vi.mock("@/lib/sources/ogp", () => ({
  fetchOgpMetadata: fetchOgpMetadataMock,
}));

const { fetchOEmbedMock } = vi.hoisted(() => ({
  fetchOEmbedMock: vi.fn(),
}));
vi.mock("@/lib/embed/oembed", () => ({
  fetchOEmbed: fetchOEmbedMock,
}));

function makeRetryEntry(overrides: Partial<RetryQueueEntry>): RetryQueueEntry {
  return {
    urlHash: "hash-default",
    url: "https://example.com/default",
    host: "example.com",
    lane: "evergreen",
    reason: "fetch_transient",
    attempts: 1,
    firstQueuedAt: "2026-01-01T00:00:00.000Z",
    nextAttemptAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

async function insertRetryRow(entry: RetryQueueEntry): Promise<void> {
  await db.insert(postRetryQueue).values(entry);
}

describe("adapter buildRetryCandidate / fetchDueRetries", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("EvergreenAdapter", () => {
    it("buildRetryCandidate returns a candidate carrying RetryContext when OGP resolves", async () => {
      fetchOgpMetadataMock.mockResolvedValue({
        title: "Evergreen Retry Title",
        description: "excerpt",
        author: "Author",
        image: "https://example.com/img.jpg",
        datePublished: "2026-01-01T00:00:00.000Z",
      });

      const entry = makeRetryEntry({
        urlHash: "ever-hash-1",
        url: "https://example.com/ever-retry",
        lane: "evergreen",
        attempts: 2,
        firstQueuedAt: "2026-01-05T00:00:00.000Z",
      });

      const adapter = new EvergreenAdapter();
      const candidate = await adapter.buildRetryCandidate(entry);

      expect(candidate).not.toBeNull();
      expect(candidate!.originalTitle).toBe("Evergreen Retry Title");
      expect(candidate!.sourceId).toBe(EVERGREEN_SOURCE_ID);
      expect(candidate!.retry).toEqual({
        urlHash: "ever-hash-1",
        attempts: 2,
        firstQueuedAt: "2026-01-05T00:00:00.000Z",
      });
    });

    it("buildRetryCandidate returns null when OGP metadata has no title", async () => {
      fetchOgpMetadataMock.mockResolvedValue(null);
      const entry = makeRetryEntry({ urlHash: "ever-hash-2", url: "https://example.com/no-ogp" });

      const adapter = new EvergreenAdapter();
      const candidate = await adapter.buildRetryCandidate(entry);
      expect(candidate).toBeNull();
    });

    it("fetchDueRetries filters to the evergreen lane and builds candidates via buildRetryCandidate", async () => {
      fetchOgpMetadataMock.mockResolvedValue({
        title: "Evergreen Due Title",
        description: null,
        author: null,
        image: null,
        datePublished: null,
      });

      await insertRetryRow(
        makeRetryEntry({
          urlHash: "ever-due-1",
          url: "https://example.com/ever-due-1",
          lane: "evergreen",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      // 他レーンのエントリ（同じ due 時刻）は拾わないこと
      await insertRetryRow(
        makeRetryEntry({
          urlHash: "rss-due-1",
          url: "https://example.com/rss-due-1",
          lane: "rss",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const adapter = new EvergreenAdapter();
      const candidates = await adapter.fetchDueRetries("2026-01-02T00:00:00.000Z");

      expect(candidates).toHaveLength(1);
      expect(candidates[0].url).toBe("https://example.com/ever-due-1");
      expect(candidates[0].retry?.urlHash).toBe("ever-due-1");
      expect(fetchOgpMetadataMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("SubmitAdapter", () => {
    it("buildRetryCandidate uses oEmbed title when available and carries RetryContext", async () => {
      fetchOEmbedMock.mockResolvedValue({
        provider: "instagram",
        title: "Retry Embed Title",
        authorName: "Someone",
        thumbnailUrl: "https://example.com/thumb.jpg",
        html: "<blockquote>embed</blockquote>",
      });

      const entry = makeRetryEntry({
        urlHash: "sub-hash-1",
        url: "https://www.instagram.com/p/retry1",
        lane: "submit",
        attempts: 1,
        firstQueuedAt: "2026-01-03T00:00:00.000Z",
      });

      const adapter = new SubmitAdapter();
      const candidate = await adapter.buildRetryCandidate(entry);

      expect(candidate).not.toBeNull();
      expect(candidate!.originalTitle).toBe("Retry Embed Title");
      expect(candidate!.originalExcerpt).toBe("Retry Embed Title");
      expect(candidate!.embedProvider).toBe("instagram");
      expect(candidate!.retry).toEqual({
        urlHash: "sub-hash-1",
        attempts: 1,
        firstQueuedAt: "2026-01-03T00:00:00.000Z",
      });
    });

    it("buildRetryCandidate falls back to placeholder title when no embed title (note not persisted on retry)", async () => {
      fetchOEmbedMock.mockResolvedValue(null);
      const entry = makeRetryEntry({
        urlHash: "sub-hash-2",
        url: "https://www.instagram.com/p/retry2",
        lane: "submit",
      });

      const adapter = new SubmitAdapter();
      const candidate = await adapter.buildRetryCandidate(entry);

      // SubmitAdapter never returns null for buildRetryCandidate (no invalid-canonical path
      // reachable via retry queue entries, which are already canonicalized on enqueue).
      expect(candidate).not.toBeNull();
      expect(candidate!.originalTitle).toBe("SNS 投稿");
      expect(candidate!.originalExcerpt).toBeNull();
    });

    it("fetchDueRetries filters to the submit lane only", async () => {
      fetchOEmbedMock.mockResolvedValue(null);

      await insertRetryRow(
        makeRetryEntry({
          urlHash: "sub-due-1",
          url: "https://www.instagram.com/p/due1",
          lane: "submit",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await insertRetryRow(
        makeRetryEntry({
          urlHash: "ever-due-2",
          url: "https://example.com/ever-due-2",
          lane: "evergreen",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const adapter = new SubmitAdapter();
      const candidates = await adapter.fetchDueRetries("2026-01-02T00:00:00.000Z");

      expect(candidates).toHaveLength(1);
      expect(candidates[0].url).toBe("https://www.instagram.com/p/due1");
      expect(candidates[0].retry?.urlHash).toBe("sub-due-1");
    });
  });

  describe("RssAdapter", () => {
    it("buildRetryCandidate returns null and completes the retry when the post row is missing", async () => {
      const entry = makeRetryEntry({
        urlHash: "rss-hash-1",
        url: "https://example.com/rss-missing-post",
        lane: "rss",
      });

      const adapter = new RssAdapter();
      const candidate = await adapter.buildRetryCandidate(entry);

      expect(candidate).toBeNull();
      // completeRetry should have removed the (never-inserted) queue row without error;
      // verify no row remains under this urlHash.
      const rows = await db.select().from(postRetryQueue);
      expect(rows.find((r) => r.urlHash === "rss-hash-1")).toBeUndefined();
    });

    it("buildRetryCandidate builds a candidate carrying RetryContext when the post row exists", async () => {
      await db.insert(posts).values({
        url: "https://example.com/rss-existing",
        sourceType: "blog",
        sourceId: "hatena-bookmark",
        sourceName: "はてなブックマーク",
        originalTitle: "RSS Existing Title",
        originalExcerpt: "RSS excerpt",
      });

      const entry = makeRetryEntry({
        urlHash: "rss-hash-2",
        url: "https://example.com/rss-existing",
        lane: "rss",
        attempts: 3,
        firstQueuedAt: "2026-01-06T00:00:00.000Z",
      });

      const adapter = new RssAdapter();
      const candidate = await adapter.buildRetryCandidate(entry);

      expect(candidate).not.toBeNull();
      expect(candidate!.originalTitle).toBe("RSS Existing Title");
      expect(candidate!.retry).toEqual({
        urlHash: "rss-hash-2",
        attempts: 3,
        firstQueuedAt: "2026-01-06T00:00:00.000Z",
      });
    });

    it("fetchDueRetries filters to the rss lane only", async () => {
      await db.insert(posts).values({
        url: "https://example.com/rss-due-existing",
        sourceType: "blog",
        sourceId: "hatena-bookmark",
        sourceName: "はてなブックマーク",
        originalTitle: "RSS Due Title",
        originalExcerpt: null,
      });

      await insertRetryRow(
        makeRetryEntry({
          urlHash: "rss-due-a",
          url: "https://example.com/rss-due-existing",
          lane: "rss",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await insertRetryRow(
        makeRetryEntry({
          urlHash: "sub-due-b",
          url: "https://www.instagram.com/p/other",
          lane: "submit",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const adapter = new RssAdapter();
      const candidates = await adapter.fetchDueRetries("2026-01-02T00:00:00.000Z");

      expect(candidates).toHaveLength(1);
      expect(candidates[0].url).toBe("https://example.com/rss-due-existing");
      expect(candidates[0].retry?.urlHash).toBe("rss-due-a");
    });
  });
});
