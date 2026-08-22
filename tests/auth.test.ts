import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBearerAuthorized } from "@/lib/auth";

function requestWithAuth(header?: string): Request {
  return new Request("http://localhost:3000/api/ingest", {
    headers: header ? { authorization: header } : undefined,
  });
}

describe("isBearerAuthorized", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // fail-closed 回帰防止（本タスクの本体）: secret が未設定なら常に拒否する。
  // 以前は「未設定ならローカル開発向けに無認証で許可する」fail-open だったが、
  // 本番で secret の設定を忘れた場合に /api/ingest, /api/submit-url を
  // 無認証公開してしまう事故につながっていた。
  it("rejects the request when CRON_SECRET is not configured, even with no Authorization header", () => {
    expect(isBearerAuthorized(requestWithAuth())).toBe(false);
  });

  it("rejects the request when CRON_SECRET is not configured, even with a correctly-shaped Bearer header", () => {
    expect(isBearerAuthorized(requestWithAuth("Bearer anything"))).toBe(false);
  });

  it("does not branch on NODE_ENV or VERCEL_ENV when the secret is unset (still rejects)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);
    expect(isBearerAuthorized(requestWithAuth())).toBe(false);
  });

  it("warns via console.warn (without leaking the secret value) when the secret is unset", () => {
    vi.stubEnv("CRON_SECRET", undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    isBearerAuthorized(requestWithAuth());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] ?? [];
    expect(typeof message).toBe("string");
    expect(message).toContain("CRON_SECRET");
  });

  it("rejects when the header is missing but a secret is configured", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isBearerAuthorized(requestWithAuth())).toBe(false);
  });

  it("rejects an incorrect token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isBearerAuthorized(requestWithAuth("Bearer wrong"))).toBe(false);
  });

  it("accepts the correct token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isBearerAuthorized(requestWithAuth("Bearer s3cret"))).toBe(true);
  });
});
