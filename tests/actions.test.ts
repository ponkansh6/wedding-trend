import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock ファクトリより先に評価される必要があるため vi.hoisted() で宣言する
// （通常の const 宣言だと vi.mock 側の巻き上げより後に実行され参照エラーになる）。
const {
  runIngestMock,
  getLastRunSummaryMock,
  acquireIngestLeaseMock,
  releaseIngestLeaseMock,
  claimIngestSlotMock,
  extendIngestCooldownAfterRunMock,
  getCooldownUntilMock,
  isBasicAuthorizedMock,
} = vi.hoisted(() => ({
  runIngestMock: vi.fn(),
  getLastRunSummaryMock: vi.fn(),
  acquireIngestLeaseMock: vi.fn(),
  releaseIngestLeaseMock: vi.fn(),
  claimIngestSlotMock: vi.fn(),
  extendIngestCooldownAfterRunMock: vi.fn(),
  getCooldownUntilMock: vi.fn(),
  isBasicAuthorizedMock: vi.fn(),
}));

vi.mock("@/lib/pipeline/ingest", () => ({
  runIngest: runIngestMock,
  getLastRunSummary: getLastRunSummaryMock,
}));

vi.mock("@/lib/pipeline/cooldown", () => ({
  acquireIngestLease: acquireIngestLeaseMock,
  releaseIngestLease: releaseIngestLeaseMock,
  claimIngestSlot: claimIngestSlotMock,
  extendIngestCooldownAfterRun: extendIngestCooldownAfterRunMock,
  getCooldownUntil: getCooldownUntilMock,
}));

vi.mock("@/lib/auth", () => ({
  isBasicAuthorized: isBasicAuthorizedMock,
}));

// isBasicAuthorized() 自体は @/lib/auth のモックで完全に差し替えているため、
// next/headers の headers() が返す実際の中身はテストの結果に影響しない。
// ここでは Server Action が呼び出し時に headers() を await できることだけを
// 保証すればよい。
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

import { getIngestCooldown, getIngestStatus, triggerIngest } from "@/app/actions";

const JAPANESE_CHAR = /[ぁ-んァ-ヶ一-龠]/;

const CLAIMED_COOLDOWN_UNTIL = "2026-08-22T04:15:00.000Z";
const EXTENDED_COOLDOWN_UNTIL = "2026-08-22T08:00:00.000Z";

describe("getIngestCooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps getCooldownUntil() as { cooldownUntil }", async () => {
    getCooldownUntilMock.mockResolvedValue(null);
    await expect(getIngestCooldown()).resolves.toEqual({ cooldownUntil: null });

    getCooldownUntilMock.mockResolvedValue(CLAIMED_COOLDOWN_UNTIL);
    await expect(getIngestCooldown()).resolves.toEqual({
      cooldownUntil: CLAIMED_COOLDOWN_UNTIL,
    });
  });
});

describe("getIngestStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null without calling getLastRunSummary() when Basic auth fails (does not leak whether a run history exists)", async () => {
    isBasicAuthorizedMock.mockReturnValue(false);

    await expect(getIngestStatus()).resolves.toBeNull();
    expect(getLastRunSummaryMock).not.toHaveBeenCalled();
  });

  it("returns getLastRunSummary()'s value when authorized", async () => {
    isBasicAuthorizedMock.mockReturnValue(true);
    const summary = {
      startedAt: "2026-08-22T04:00:00.000Z",
      finishedAt: "2026-08-22T04:00:30.000Z",
      fetched: 5,
      inserted: 3,
      curated: 3,
      geminiCalls: 1,
      errorCount: 0,
      trigger: "manual" as const,
    };
    getLastRunSummaryMock.mockResolvedValue(summary);

    await expect(getIngestStatus()).resolves.toEqual(summary);
  });

  it("returns null (not an error) when authorized but no run has happened yet", async () => {
    isBasicAuthorizedMock.mockReturnValue(true);
    getLastRunSummaryMock.mockResolvedValue(null);

    await expect(getIngestStatus()).resolves.toBeNull();
  });
});

describe("triggerIngest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 明示的に上書きしないテストのデフォルトは「認証済み・lease を取得でき、
    // クールダウンも空いていた」状態。claimed: true でも cooldownUntil は必ず
    // 入る（今回の奪取で新たに開始した 15 分の枠の満了時刻）。
    isBasicAuthorizedMock.mockReturnValue(true);
    acquireIngestLeaseMock.mockResolvedValue(true);
    releaseIngestLeaseMock.mockResolvedValue(undefined);
    claimIngestSlotMock.mockResolvedValue({
      claimed: true,
      cooldownUntil: CLAIMED_COOLDOWN_UNTIL,
    });
    extendIngestCooldownAfterRunMock.mockResolvedValue(undefined);
    // 既定では「延長は行われず、claim 時点の 15 分の枠がそのまま有効」を模す。
    getCooldownUntilMock.mockResolvedValue(CLAIMED_COOLDOWN_UNTIL);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a fixed public message and never touches lease/cooldown/runIngest when Basic auth fails", async () => {
    isBasicAuthorizedMock.mockReturnValue(false);

    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.busy).toBe(false);
    expect(result.cooldownUntil).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(JAPANESE_CHAR);
    // 認証失敗は「無効になっています」の固定文言であり、生の認証エラーの
    // 内部情報（どちらの資格情報が一致しなかったか等）を含まない。
    expect(result.errors[0]).not.toMatch(/user|password|auth/i);
    expect(acquireIngestLeaseMock).not.toHaveBeenCalled();
    expect(claimIngestSlotMock).not.toHaveBeenCalled();
    expect(runIngestMock).not.toHaveBeenCalled();
  });

  it("does not call claimIngestSlot or runIngest, and reports busy:true, when the lease cannot be acquired (another execution — e.g. cron — is running)", async () => {
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
    // クールダウン判定のみで完了しており、延長ロジックには到達しない。
    expect(extendIngestCooldownAfterRunMock).not.toHaveBeenCalled();
  });

  it("wraps runIngest's summary into an IngestResult with ok:true/ran:true/busy:false, calls runIngest('manual'), and extends the cooldown based on geminiCalls", async () => {
    runIngestMock.mockResolvedValue({
      fetched: 3,
      inserted: 2,
      curated: 2,
      skipped: 1,
      errors: [],
      geminiCalls: 2,
    });
    getCooldownUntilMock.mockResolvedValue(EXTENDED_COOLDOWN_UNTIL);

    const result = await triggerIngest();

    expect(runIngestMock).toHaveBeenCalledWith("manual");
    expect(result).toEqual({
      ok: true,
      ran: true,
      busy: false,
      fetched: 3,
      inserted: 2,
      curated: 2,
      skipped: 1,
      errors: [],
      cooldownUntil: EXTENDED_COOLDOWN_UNTIL,
    });
    // Gemini を実際に呼んだ回数（geminiCalls）をそのまま延長ロジックへ渡す。
    expect(extendIngestCooldownAfterRunMock).toHaveBeenCalledWith(
      CLAIMED_COOLDOWN_UNTIL,
      2,
      expect.any(Date),
    );
    // 延長後の実際の値は getCooldownUntil() で読み直す。
    expect(getCooldownUntilMock).toHaveBeenCalled();
    // 成功時も lease を解放する（finally）。
    expect(releaseIngestLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("still calls extendIngestCooldownAfterRun with geminiCalls:0 for a no-op run (Gemini not called), and the base 15-minute cooldown is left in place", async () => {
    runIngestMock.mockResolvedValue({
      fetched: 0,
      inserted: 0,
      curated: 0,
      skipped: 0,
      errors: [],
      geminiCalls: 0,
    });
    // extendIngestCooldownAfterRun 自体は geminiCalls<=0 のとき何もしない
    // （src/lib/pipeline/cooldown.ts 側の契約）ため、DB 上の値は claim 時点の
    // 15 分の枠のまま変わらない。
    getCooldownUntilMock.mockResolvedValue(CLAIMED_COOLDOWN_UNTIL);

    const result = await triggerIngest();

    expect(extendIngestCooldownAfterRunMock).toHaveBeenCalledWith(
      CLAIMED_COOLDOWN_UNTIL,
      0,
      expect.any(Date),
    );
    expect(result.cooldownUntil).toBe(CLAIMED_COOLDOWN_UNTIL);
  });

  it("falls back to the claimed cooldownUntil when getCooldownUntil() cannot resolve the current value after extension", async () => {
    runIngestMock.mockResolvedValue({
      fetched: 1,
      inserted: 1,
      curated: 1,
      skipped: 0,
      errors: [],
      geminiCalls: 1,
    });
    getCooldownUntilMock.mockResolvedValue(null);

    const result = await triggerIngest();

    expect(result.cooldownUntil).toBe(CLAIMED_COOLDOWN_UNTIL);
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
      geminiCalls: 1,
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

  it("never throws and never leaks the raw exception message: catches an error from runIngest, returns ok:false with ran:true/busy:false, a fixed public message, force-extends the cooldown to the safe (budget-protecting) side, and still reports a non-null cooldownUntil", async () => {
    runIngestMock.mockRejectedValue(new Error("connect ECONNREFUSED internal-db.example.com:5432"));
    getCooldownUntilMock.mockResolvedValue(EXTENDED_COOLDOWN_UNTIL);
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
    // runIngest() が例外を投げた場合、Gemini を呼んだかどうか不明なため安全側
    // （予算保護優先）に倒し、無条件で4時間への延長を試みる（geminiCalls に
    // 実際の回数ではなく正の値を渡す）。
    expect(extendIngestCooldownAfterRunMock).toHaveBeenCalledWith(
      CLAIMED_COOLDOWN_UNTIL,
      expect.any(Number),
      expect.any(Date),
    );
    const [, geminiCallsArg] = extendIngestCooldownAfterRunMock.mock.calls[0] ?? [];
    expect(geminiCallsArg).toBeGreaterThan(0);
    expect(result.cooldownUntil).toBe(EXTENDED_COOLDOWN_UNTIL);
    expect(result.cooldownUntil).not.toBeNull();
    errorSpy.mockRestore();
    // 失敗時も lease を解放する（finally）。
    expect(releaseIngestLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail the Server Action when extendIngestCooldownAfterRun itself throws; falls back to the value read from getCooldownUntil()", async () => {
    runIngestMock.mockResolvedValue({
      fetched: 1,
      inserted: 1,
      curated: 1,
      skipped: 0,
      errors: [],
      geminiCalls: 1,
    });
    extendIngestCooldownAfterRunMock.mockRejectedValue(new Error("SQLITE_BUSY"));
    getCooldownUntilMock.mockResolvedValue(CLAIMED_COOLDOWN_UNTIL);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await triggerIngest();

    expect(result.ok).toBe(true);
    expect(result.cooldownUntil).toBe(CLAIMED_COOLDOWN_UNTIL);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
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

  it("does not branch on NODE_ENV: runs identically in a production-like environment as long as Basic auth succeeds (regression guard against reintroducing a dev/prod fail-open split)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    runIngestMock.mockResolvedValue({
      fetched: 1,
      inserted: 1,
      curated: 1,
      skipped: 0,
      errors: [],
      geminiCalls: 0,
    });

    const result = await triggerIngest();

    expect(result.ok).toBe(true);
    expect(result.ran).toBe(true);
    expect(runIngestMock).toHaveBeenCalledTimes(1);
  });
});
