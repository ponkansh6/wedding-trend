import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock ファクトリより先に評価される必要があるため vi.hoisted() で宣言する
// （通常の const 宣言だと vi.mock 側の巻き上げより後に実行され参照エラーになる）。
const {
  runIngestMock,
  runSubmitUrlMock,
  acquireIngestLeaseMock,
  releaseIngestLeaseMock,
  claimIngestSlotMock,
  getCooldownUntilMock,
} = vi.hoisted(() => ({
  runIngestMock: vi.fn(),
  runSubmitUrlMock: vi.fn(),
  acquireIngestLeaseMock: vi.fn(),
  releaseIngestLeaseMock: vi.fn(),
  claimIngestSlotMock: vi.fn(),
  getCooldownUntilMock: vi.fn(),
}));

vi.mock("@/lib/pipeline/ingest", () => ({
  runIngest: runIngestMock,
}));

vi.mock("@/lib/pipeline/submit-url", () => ({
  runSubmitUrl: runSubmitUrlMock,
}));

vi.mock("@/lib/pipeline/cooldown", () => ({
  acquireIngestLease: acquireIngestLeaseMock,
  releaseIngestLease: releaseIngestLeaseMock,
  claimIngestSlot: claimIngestSlotMock,
  getCooldownUntil: getCooldownUntilMock,
}));

import {
  adminControlsEnabled,
  getIngestCooldown,
  submitSnsUrl,
  triggerIngest,
} from "@/app/actions";

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

const CLAIMED_COOLDOWN_UNTIL = "2026-08-22T04:00:00.000Z";

describe("triggerIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 明示的に上書きしないテストのデフォルトは「lease を取得でき、クールダウンも
    // 空いていた」状態。claimed: true でも cooldownUntil は必ず入る
    // （今回の奪取で新たに開始した枠の満了時刻）。
    acquireIngestLeaseMock.mockResolvedValue(true);
    releaseIngestLeaseMock.mockResolvedValue(undefined);
    claimIngestSlotMock.mockResolvedValue({
      claimed: true,
      cooldownUntil: CLAIMED_COOLDOWN_UNTIL,
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 収集ボタンは無認証で本番公開される方針のため、triggerIngest は
  // adminControlsEnabled() のガードを持たない。submitSnsUrl とは異なり
  // 公開範囲を広げること自体が意図した変更である（下の「回帰防止」テスト参照）。

  it("does not call claimIngestSlot or runIngest, and reports busy:true, when the lease cannot be acquired (another execution — e.g. cron — is running)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    acquireIngestLeaseMock.mockResolvedValue(false);
    getCooldownUntilMock.mockResolvedValue(null);

    const result = await triggerIngest();

    // 二重実行防止の回帰テストの本体: lease が取れなければ、cooldown の判定にも
    // runIngest() にも到達しない。
    expect(result.ok).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.busy).toBe(true);
    expect(result.errors).toEqual([]);
    expect(claimIngestSlotMock).not.toHaveBeenCalled();
    expect(runIngestMock).not.toHaveBeenCalled();
    // busy の場合でも参考情報として現在のクールダウン状態を返す（null 可）。
    expect(result.cooldownUntil).toBeNull();
    // lease を取得できていないので解放も呼ばない。
    expect(releaseIngestLeaseMock).not.toHaveBeenCalled();
  });

  it("reports busy:true with the current cooldown deadline (non-null) when both a run is in progress and a cooldown window happens to be open", async () => {
    acquireIngestLeaseMock.mockResolvedValue(false);
    getCooldownUntilMock.mockResolvedValue(CLAIMED_COOLDOWN_UNTIL);

    const result = await triggerIngest();

    expect(result.busy).toBe(true);
    expect(result.ran).toBe(false);
    expect(result.cooldownUntil).toBe(CLAIMED_COOLDOWN_UNTIL);
  });

  it("does not call runIngest, releases the lease, and reports ran:false/busy:false plus the cooldown deadline when the slot cannot be claimed", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const cooldownUntil = "2026-08-22T04:00:00.000Z";
    claimIngestSlotMock.mockResolvedValue({ claimed: false, cooldownUntil });

    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    // ran:false は「今回この呼び出しでは runIngest() を実行しなかった」ことを表す。
    // UI 側の見送り判定はこの ran を見る契約であり、cooldownUntil の真偽ではない
    // （cooldownUntil はほぼ全分岐で非 null になるため判別に使えない）。
    expect(result.ran).toBe(false);
    expect(result.busy).toBe(false);
    expect(result.cooldownUntil).toBe(cooldownUntil);
    // クールダウンはエラーではなく正常な待機状態として表現するため errors は空。
    expect(result.errors).toEqual([]);
    expect(runIngestMock).not.toHaveBeenCalled();
    // クールダウン中で見送る場合、次の呼び出しをブロックしないよう lease を解放する。
    expect(releaseIngestLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("wraps runIngest's summary into an IngestResult with ok:true, ran:true, busy:false, and echoes the claimed cooldownUntil (not null)", async () => {
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
      ran: true,
      busy: false,
      fetched: 3,
      inserted: 2,
      curated: 2,
      skipped: 1,
      errors: [],
      cooldownUntil: CLAIMED_COOLDOWN_UNTIL,
    });
    // UI の誤判定を防ぐ回帰テストの本体: 実行して成功した場合、
    // ran は true（cooldownUntil の非 null だけでは「見送り」と誤解されるため）。
    expect(result.ran).toBe(true);
    expect(result.cooldownUntil).not.toBeNull();
    // 成功時も lease を解放する（finally）。
    expect(releaseIngestLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes runIngest's per-source errors: the public response reports only a count, never the raw messages", async () => {
    runIngestMock.mockResolvedValue({
      fetched: 5,
      inserted: 3,
      curated: 3,
      skipped: 0,
      errors: [
        "hatena-bookmark: fetch failed https://internal.example.com/secret-path",
        "curation failed: GoogleGenAI: 500 Internal error at https://generativelanguage.googleapis.com/...",
      ],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await triggerIngest();

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("2件");
    expect(result.errors[0]).not.toContain("internal.example.com");
    expect(result.errors[0]).not.toContain("generativelanguage.googleapis.com");
    // 原文はサーバーログにのみ残す。
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never throws and never leaks the raw exception message: catches an error from runIngest, returns ok:false with ran:true/busy:false, a fixed public message, and still reports the claimed cooldownUntil (regression guard: must not be null)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    runIngestMock.mockRejectedValue(new Error("connect ECONNREFUSED internal-db.example.com:5432"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    // 実行はした（＝ runIngest() が呼ばれた）上で失敗した、という区別を
    // 呼び出し側ができるように ran は true のままにする。
    expect(result.ran).toBe(true);
    expect(result.busy).toBe(false);
    expect(result.fetched).toBe(0);
    // 公開面には固定文言のみを返し、生の例外メッセージ（ホスト名等）は含めない。
    expect(result.errors).toEqual(["収集処理でエラーが発生しました。時間をおいてお試しください。"]);
    expect(result.errors[0]).not.toContain("ECONNREFUSED");
    expect(result.errors[0]).not.toContain("internal-db.example.com");
    // 実際の例外はサーバーログにのみ出す。
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    // runIngest が失敗しても実行権の消費（クールダウンの開始）は claimIngestSlot()
    // の時点で確定済みであり、その事実を戻り値に正しく反映する。null を返すと
    // UI が「今すぐ実行可能」と誤解し、押すとクールダウン拒否になる不整合が生じる。
    expect(result.cooldownUntil).toBe(CLAIMED_COOLDOWN_UNTIL);
    expect(result.cooldownUntil).not.toBeNull();
    // 失敗時も lease を解放する（finally）。
    expect(releaseIngestLeaseMock).toHaveBeenCalledTimes(1);
  });

  // config テーブル未作成（マイグレーション未適用の本番・smoke test の空 DB）
  // では acquireIngestLease() / claimIngestSlot() は fail-closed で throw する
  // 契約（tests/cooldown.test.ts で検証）。triggerIngest() 側はそれを catch し、
  // 未処理例外で Server Action を落とさず、安全な IngestResult を返すこと。

  it("never throws and returns a fixed public error message when acquireIngestLease() itself throws (e.g. config table missing pre-migration)", async () => {
    acquireIngestLeaseMock.mockRejectedValue(new Error("SQLITE_ERROR: no such table: config"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await triggerIngest();

    expect(result).toEqual({
      ok: false,
      ran: false,
      busy: false,
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: ["収集処理でエラーが発生しました。時間をおいてお試しください。"],
      cooldownUntil: null,
    });
    // 生の例外メッセージ（テーブル名等）は公開面に出さない。
    expect(result.errors[0]).not.toContain("no such table");
    // lease を取得していないので、claimIngestSlot にも解放にも進まない。
    expect(claimIngestSlotMock).not.toHaveBeenCalled();
    expect(releaseIngestLeaseMock).not.toHaveBeenCalled();
    expect(runIngestMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("never throws, releases the already-acquired lease, and returns a fixed public error message when claimIngestSlot() itself throws", async () => {
    claimIngestSlotMock.mockRejectedValue(new Error("SQLITE_ERROR: no such table: config"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.busy).toBe(false);
    expect(result.errors).toEqual(["収集処理でエラーが発生しました。時間をおいてお試しください。"]);
    expect(result.cooldownUntil).toBeNull();
    expect(runIngestMock).not.toHaveBeenCalled();
    // lease は既に取得済みだったので、例外経路でも必ず解放する。
    expect(releaseIngestLeaseMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("runs even in a production-like environment with ENABLE_ADMIN_CONTROLS unset (public-button regression guard)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_ADMIN_CONTROLS", undefined);
    runIngestMock.mockResolvedValue({
      fetched: 1,
      inserted: 1,
      curated: 1,
      skipped: 0,
      errors: [],
    });

    const result = await triggerIngest();

    expect(result.ok).toBe(true);
    expect(result.ran).toBe(true);
    expect(runIngestMock).toHaveBeenCalledTimes(1);
  });
});

describe("getIngestCooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps getCooldownUntil() as { cooldownUntil }", async () => {
    getCooldownUntilMock.mockResolvedValue(null);
    await expect(getIngestCooldown()).resolves.toEqual({ cooldownUntil: null });

    getCooldownUntilMock.mockResolvedValue("2026-08-22T04:00:00.000Z");
    await expect(getIngestCooldown()).resolves.toEqual({
      cooldownUntil: "2026-08-22T04:00:00.000Z",
    });
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
