import { describe, expect, it, vi, beforeEach } from "vitest";

const { fetchOgpMetadataMock } = vi.hoisted(() => ({
  fetchOgpMetadataMock: vi.fn(),
}));
const { curateSingleMock } = vi.hoisted(() => ({
  curateSingleMock: vi.fn(),
}));
const { upsertPostsMock, markCuratedMock, getPostsByUrlsMock } = vi.hoisted(() => ({
  upsertPostsMock: vi.fn(),
  markCuratedMock: vi.fn(),
  getPostsByUrlsMock: vi.fn(),
}));

vi.mock("@/lib/sources/ogp", () => ({
  fetchOgpMetadata: fetchOgpMetadataMock,
}));

vi.mock("@/lib/llm/batch", () => ({
  curateSingle: curateSingleMock,
}));

vi.mock("@/lib/db/repository", () => ({
  upsertPosts: upsertPostsMock,
  markCurated: markCuratedMock,
  getPostsByUrls: getPostsByUrlsMock,
}));

import { curateEvergreenUrl } from "@/lib/pipeline/evergreen";
import { LLM_MODEL } from "@/lib/constants";

describe("curateEvergreenUrl (src/lib/pipeline/evergreen.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchOgpMetadataMock.mockResolvedValue({
      title: "Evergreen Article Title",
      description: "Evergreen Article Description",
      image: "https://example.com/image.jpg",
      siteName: "Example Wedding Site",
      author: "Test Author",
      datePublished: "2026-01-01T00:00:00.000Z",
    });
    curateSingleMock.mockResolvedValue({
      title: "AI Curated Title",
      summary: "AI Curated Summary",
      category: "費用・節約",
      tag: "classic",
      firsthand: true,
      ceremonyDecision: false,
      specific: true,
      tradeoff: true,
      promotional: false,
      preDecisionOrPhotoShoot: false,
    });
    upsertPostsMock.mockResolvedValue({
      succeeded: ["https://example.com/article"],
      failed: [],
    });
    markCuratedMock.mockResolvedValue({
      succeeded: ["https://example.com/article"],
      failed: [],
    });
    getPostsByUrlsMock.mockResolvedValue(
      new Map([
        [
          "https://example.com/article",
          {
            id: 7,
            url: "https://example.com/article",
            originalTitle: "Evergreen Article Title",
            originalExcerpt: "Evergreen Article Description",
            aiTitle: "AI Curated Title",
            contentHash: "hash",
            curationSignature: "sig",
            status: "published",
            publishedAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );
  });

  it("returns reason 'invalid_url' and does not touch DB or LLM for an invalid URL", async () => {
    const outcome = await curateEvergreenUrl("not-a-url");
    expect(outcome).toEqual({ ok: false, reason: "invalid_url", card: null });
    expect(fetchOgpMetadataMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  it("happy path: fetches OGP, curates via LLM, saves to DB with classic tag and usefulness criteria", async () => {
    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.card?.aiTitle).toBe("AI Curated Title");
    expect(outcome.card?.tag).toBe("classic");
    expect(outcome.card?.sourceId).toBe("evergreen");

    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://example.com/article",
        sourceType: "blog",
        sourceId: "evergreen",
        status: "published",
      }),
    ]);

    expect(markCuratedMock).toHaveBeenCalledWith([
      expect.objectContaining({
        url: "https://example.com/article",
        tag: "classic",
        status: "published",
        usefulness: expect.objectContaining({
          postId: 7,
          modelId: LLM_MODEL,
          criteria: expect.objectContaining({
            firsthand: true,
            tradeoff: true,
          }),
        }),
      }),
    ]);
  });

  it("returns reason 'no_metadata' if fetchOgpMetadata returns null or no title", async () => {
    fetchOgpMetadataMock.mockResolvedValueOnce(null);
    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: false, reason: "no_metadata", card: null });
    expect(curateSingleMock).not.toHaveBeenCalled();
    expect(upsertPostsMock).not.toHaveBeenCalled();
  });

  it("handles LLM failure gracefully by falling back to pending status and false criteria", async () => {
    curateSingleMock.mockResolvedValueOnce(null);

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("needs_review");
    expect(outcome.card?.aiTitle).toBe("Evergreen Article Title");

    expect(upsertPostsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "pending",
      }),
    ]);

    expect(markCuratedMock).toHaveBeenCalledWith([
      expect.objectContaining({
        status: "pending",
        usefulness: expect.objectContaining({
          criteria: expect.objectContaining({
            firsthand: false,
            tradeoff: false,
          }),
        }),
      }),
    ]);
  });

  it("returns reason 'save_failed' if upsertPosts fails", async () => {
    upsertPostsMock.mockResolvedValueOnce({
      succeeded: [],
      failed: ["https://example.com/article"],
    });

    const outcome = await curateEvergreenUrl("https://example.com/article");

    expect(outcome).toEqual({ ok: false, reason: "save_failed", card: null });
    expect(markCuratedMock).not.toHaveBeenCalled();
  });
});
