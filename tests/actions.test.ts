import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock ファクトリより先に評価される必要があるため vi.hoisted() で宣言する
// （通常の const 宣言だと vi.mock 側の巻き上げより後に実行され参照エラーになる）。
const { runIngestMock, runSubmitUrlMock } = vi.hoisted(() => ({
  runIngestMock: vi.fn(),
  runSubmitUrlMock: vi.fn(),
}));

vi.mock("@/lib/pipeline/ingest", () => ({
  runIngest: runIngestMock,
}));

vi.mock("@/lib/pipeline/submit-url", () => ({
  runSubmitUrl: runSubmitUrlMock,
}));

import { adminControlsEnabled, submitSnsUrl, triggerIngest } from "@/app/actions";

const JAPANESE_CHAR = /[ぁ-んァ-ヶ一-龠]/;

describe("adminControlsEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is enabled outside production regardless of the flag", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_ADMIN_CONTROLS", undefined);
    await expect(adminControlsEnabled()).resolves.toBe(true);
  });

  it("is disabled in production when the flag is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_CONTROLS", undefined);
    await expect(adminControlsEnabled()).resolves.toBe(false);
  });

  it('is enabled in production when the flag is exactly "1"', async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_CONTROLS", "1");
    await expect(adminControlsEnabled()).resolves.toBe(true);
  });
});

describe("triggerIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run and returns ok:false when admin controls are disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_CONTROLS", undefined);

    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(JAPANESE_CHAR);
    expect(runIngestMock).not.toHaveBeenCalled();
  });

  it("wraps runIngest's summary into an IngestResult with ok:true on success", async () => {
    vi.stubEnv("NODE_ENV", "development");
    runIngestMock.mockResolvedValue({
      fetched: 3,
      inserted: 2,
      curated: 2,
      skipped: 1,
      errors: [],
    });

    const result = await triggerIngest();

    expect(result).toEqual({
      ok: true,
      fetched: 3,
      inserted: 2,
      curated: 2,
      skipped: 1,
      errors: [],
    });
  });

  it("never throws: catches an error from runIngest and returns ok:false", async () => {
    vi.stubEnv("NODE_ENV", "development");
    runIngestMock.mockRejectedValue(new Error("db unreachable"));

    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    expect(result.fetched).toBe(0);
    expect(result.errors[0]).toContain("db unreachable");
  });
});

describe("submitSnsUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run and returns ok:false when admin controls are disabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_CONTROLS", undefined);

    const result = await submitSnsUrl("https://www.instagram.com/p/ABC123/");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(JAPANESE_CHAR);
    expect(result.card).toBeNull();
    expect(runSubmitUrlMock).not.toHaveBeenCalled();
  });

  it("rejects a non-URL string with a non-empty Japanese message", async () => {
    const result = await submitSnsUrl("not a url at all");

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toMatch(JAPANESE_CHAR);
    expect(runSubmitUrlMock).not.toHaveBeenCalled();
  });

  it("rejects a javascript: scheme URL with a non-empty Japanese message", async () => {
    const result = await submitSnsUrl("javascript:alert(document.cookie)");

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toMatch(JAPANESE_CHAR);
    expect(runSubmitUrlMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported host with a non-empty Japanese message naming the supported providers", async () => {
    const result = await submitSnsUrl("https://example.com/some-wedding-article");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("対応していない");
    expect(result.message).toMatch(JAPANESE_CHAR);
    expect(runSubmitUrlMock).not.toHaveBeenCalled();
  });

  it("happy path: a valid Instagram URL is trimmed and delegated to runSubmitUrl", async () => {
    const card = {
      id: 1,
      sourceType: "sns" as const,
      sourceId: "instagram",
      sourceName: "Instagram",
      url: "https://www.instagram.com/p/abc123/",
      author: "someone",
      publishedAt: null,
      thumbnailUrl: null,
      aiTitle: "AI Title",
      aiSummary: "AI Summary",
      category: "その他" as const,
      tag: "trend" as const,
      embedProvider: "instagram" as const,
      embedHtml: "<blockquote>ig</blockquote>",
    };
    runSubmitUrlMock.mockResolvedValue({ ok: true, reason: null, card });

    const result = await submitSnsUrl("  https://www.instagram.com/p/ABC123/  ");

    expect(result.ok).toBe(true);
    expect(result.card).toEqual(card);
    expect(result.message.length).toBeGreaterThan(0);
    expect(runSubmitUrlMock).toHaveBeenCalledWith("https://www.instagram.com/p/ABC123/", undefined);
  });

  it("forwards a trimmed note through to runSubmitUrl", async () => {
    runSubmitUrlMock.mockResolvedValue({ ok: true, reason: null, card: null });

    await submitSnsUrl("https://www.instagram.com/p/ABC123/", "  会場の装花が綺麗でした  ");

    expect(runSubmitUrlMock).toHaveBeenCalledWith(
      "https://www.instagram.com/p/ABC123/",
      "会場の装花が綺麗でした",
    );
  });

  it("treats a whitespace-only note as absent (passes undefined to runSubmitUrl)", async () => {
    runSubmitUrlMock.mockResolvedValue({ ok: true, reason: null, card: null });

    await submitSnsUrl("https://www.instagram.com/p/ABC123/", "   ");

    expect(runSubmitUrlMock).toHaveBeenCalledWith("https://www.instagram.com/p/ABC123/", undefined);
  });

  it('surfaces a "needs review" message without failing when runSubmitUrl used the fallback curation', async () => {
    runSubmitUrlMock.mockResolvedValue({ ok: true, reason: "needs_review", card: null });

    const result = await submitSnsUrl("https://www.instagram.com/p/ABC123/");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("確認");
  });

  it("maps a needs_source_text outcome from runSubmitUrl to ok:false with a Japanese message", async () => {
    runSubmitUrlMock.mockResolvedValue({ ok: true, reason: "needs_source_text", card: null });

    const result = await submitSnsUrl("https://www.instagram.com/p/ABC123/");

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toMatch(JAPANESE_CHAR);
    expect(result.card).toBeNull();
    // UI の復帰フロー（補足メモ欄を開いてフォーカス）はこのフラグだけを見る。
    // メッセージ文面での判定に戻すと、コピー変更で無言に壊れる。
    expect(result.needsNote).toBe(true);
  });

  it("sets needsNote only for the needs_source_text case", async () => {
    runSubmitUrlMock.mockResolvedValue({ ok: false, reason: "save_failed", card: null });
    expect((await submitSnsUrl("https://www.instagram.com/p/ABC123/")).needsNote).toBe(false);

    runSubmitUrlMock.mockResolvedValue({ ok: false, reason: "invalid_url", card: null });
    expect((await submitSnsUrl("https://www.instagram.com/p/ABC123/")).needsNote).toBe(false);

    // URL 形式エラー（runSubmitUrl に到達しない経路）
    expect((await submitSnsUrl("not-a-url")).needsNote).toBe(false);
  });

  it("maps a save_failed outcome from runSubmitUrl to ok:false with a Japanese message", async () => {
    runSubmitUrlMock.mockResolvedValue({ ok: false, reason: "save_failed", card: null });

    const result = await submitSnsUrl("https://www.instagram.com/p/ABC123/");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(JAPANESE_CHAR);
  });

  it("never throws: catches an error from runSubmitUrl and returns ok:false", async () => {
    runSubmitUrlMock.mockRejectedValue(new Error("network error"));

    const result = await submitSnsUrl("https://www.instagram.com/p/ABC123/");

    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.card).toBeNull();
  });
});
