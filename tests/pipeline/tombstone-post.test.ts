/**
 * Purpose: Stage 6 (S2) Commit 2 の墓標パス（`ensureTombstonePost`）テスト。
 * 3 アダプタ（Rss/Evergreen/Submit）それぞれについて、既存 post 行がある
 * 場合に id を返しフィールドを一切上書きしないこと（旧 `terminate*Retry` の
 * `originalTitle` 上書きバグを塞いだこと）、無い場合の挙動（Rss は null、
 * Evergreen/Submit は最小行を作成すること）、OGP/oEmbed を再取得しない
 * ことを検証する。まだどこからも配線されていない新設パスなので、
 * 既存の呼び出し経路（`terminateEvergreenRetry` 等）は変更しない。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setupTestDb } from "../../tests/helpers/test-db";
import { RssAdapter } from "@/lib/pipeline/adapters/rss-adapter";
import { EvergreenAdapter } from "@/lib/pipeline/adapters/evergreen-adapter";
import { SubmitAdapter } from "@/lib/pipeline/adapters/submit-adapter";
import { db } from "@/lib/db";
import { posts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { EVERGREEN_SOURCE_ID } from "@/lib/constants";

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

describe("ensureTombstonePost (tombstone path)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("RssAdapter", () => {
    it("returns existing post id and does not touch fields", async () => {
      const [inserted] = await db
        .insert(posts)
        .values({
          url: "https://example.com/rss1",
          sourceType: "blog",
          sourceId: "hatena-bookmark",
          sourceName: "はてなブックマーク",
          originalTitle: "Original RSS Title",
          originalExcerpt: "Original excerpt",
        })
        .returning();

      const adapter = new RssAdapter();
      const id = await adapter.ensureTombstonePost("https://example.com/rss1");
      expect(id).toBe(inserted.id);

      const [row] = await db.select().from(posts).where(eq(posts.id, inserted.id));
      expect(row.originalTitle).toBe("Original RSS Title");
      expect(row.originalExcerpt).toBe("Original excerpt");
    });

    it("returns null when no existing post row (does not create one)", async () => {
      const adapter = new RssAdapter();
      const id = await adapter.ensureTombstonePost("https://example.com/rss-missing");
      expect(id).toBeNull();

      const rows = await db
        .select()
        .from(posts)
        .where(eq(posts.url, "https://example.com/rss-missing"));
      expect(rows.length).toBe(0);
    });
  });

  describe("EvergreenAdapter", () => {
    it("returns existing post id and does not overwrite originalTitle (bug fix vs legacy terminateEvergreenRetry)", async () => {
      const [inserted] = await db
        .insert(posts)
        .values({
          url: "https://example.com/ever1",
          sourceType: "blog",
          sourceId: EVERGREEN_SOURCE_ID,
          sourceName: "Example Ever",
          originalTitle: "Real Evergreen Title",
          originalExcerpt: "Real excerpt",
          author: "Real Author",
          thumbnailUrl: "https://example.com/thumb.jpg",
          publishedAt: "2024-01-01T00:00:00.000Z",
        })
        .returning();

      const adapter = new EvergreenAdapter();
      const id = await adapter.ensureTombstonePost("https://example.com/ever1");
      expect(id).toBe(inserted.id);

      const [row] = await db.select().from(posts).where(eq(posts.id, inserted.id));
      // 旧 terminateEvergreenRetry は originalTitle を canonical URL で上書きしたが、
      // ensureTombstonePost はまず既存行を取得し、無い場合にのみ作成するためこれを踏まない。
      expect(row.originalTitle).toBe("Real Evergreen Title");
      expect(row.originalExcerpt).toBe("Real excerpt");
      expect(row.author).toBe("Real Author");
      expect(row.thumbnailUrl).toBe("https://example.com/thumb.jpg");

      // OGP を再取得しない。
      expect(fetchOgpMetadataMock).not.toHaveBeenCalled();
    });

    it("creates a minimal tombstone row when no existing post exists", async () => {
      const adapter = new EvergreenAdapter();
      const id = await adapter.ensureTombstonePost("https://sub.example-new.com/path?x=1");
      expect(id).not.toBeNull();

      const [row] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, id as number));
      expect(row.originalTitle).toBe("https://sub.example-new.com/path?x=1");
      expect(row.sourceName).toBe("sub.example-new.com");
      expect(row.originalExcerpt).toBeNull();
      expect(row.author).toBeNull();
      expect(row.thumbnailUrl).toBeNull();
      expect(row.publishedAt).toBeNull();

      // OGP を再取得しない。
      expect(fetchOgpMetadataMock).not.toHaveBeenCalled();
    });
  });

  describe("SubmitAdapter", () => {
    it("returns existing post id and does not overwrite originalTitle (bug fix vs legacy terminateSubmitRetry)", async () => {
      const [inserted] = await db
        .insert(posts)
        .values({
          url: "https://www.instagram.com/p/abc123",
          sourceType: "sns",
          sourceId: "instagram",
          sourceName: "Instagram",
          originalTitle: "Real SNS Title",
          originalExcerpt: "Real SNS excerpt",
          author: "Real SNS Author",
          thumbnailUrl: "https://example.com/sns-thumb.jpg",
        })
        .returning();

      const adapter = new SubmitAdapter();
      const id = await adapter.ensureTombstonePost("https://www.instagram.com/p/abc123");
      expect(id).toBe(inserted.id);

      const [row] = await db.select().from(posts).where(eq(posts.id, inserted.id));
      expect(row.originalTitle).toBe("Real SNS Title");
      expect(row.originalExcerpt).toBe("Real SNS excerpt");
      expect(row.author).toBe("Real SNS Author");

      // oEmbed を再取得しない。
      expect(fetchOEmbedMock).not.toHaveBeenCalled();
    });

    it("creates a minimal tombstone row with embed provider when no existing post exists", async () => {
      const adapter = new SubmitAdapter();
      const id = await adapter.ensureTombstonePost("https://www.instagram.com/p/newone/");
      expect(id).not.toBeNull();

      const [row] = await db
        .select()
        .from(posts)
        .where(eq(posts.id, id as number));
      expect(row.originalTitle).toBe("https://www.instagram.com/p/newone");
      expect(row.sourceId).toBe("instagram");
      expect(row.sourceName).toBe("Instagram");
      expect(row.originalExcerpt).toBeNull();
      expect(row.author).toBeNull();
      expect(row.thumbnailUrl).toBeNull();

      // oEmbed を再取得しない。
      expect(fetchOEmbedMock).not.toHaveBeenCalled();
    });
  });
});
