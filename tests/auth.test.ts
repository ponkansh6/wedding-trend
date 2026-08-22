import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBasicAuthorized, isBearerAuthorized } from "@/lib/auth";

function requestWithAuth(header?: string): Request {
  return new Request("http://localhost:3000/api/ingest", {
    headers: header ? { authorization: header } : undefined,
  });
}

function headersWithAuth(header?: string): Headers {
  return new Headers(header ? { authorization: header } : undefined);
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
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

describe("isBasicAuthorized", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", undefined);
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // fail-closed 回帰防止（本タスクの本体、isBearerAuthorized と同じ方針）:
  // 資格情報が未設定なら常に拒否する。src/middleware.ts の NODE_ENV 分岐
  // （開発環境は無認証で通す）とは意図的に非対称であり、この関数は
  // NODE_ENV に関わらず常に拒否する（Server Action の多層防御用途のため）。
  it("rejects when ADMIN_BASIC_AUTH_USER/PASSWORD are not configured, even with no Authorization header", () => {
    expect(isBasicAuthorized(headersWithAuth())).toBe(false);
  });

  it("rejects when not configured, even with a correctly-shaped Basic header", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", undefined);
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", undefined);
    expect(isBasicAuthorized(headersWithAuth(basicAuthHeader("admin", "whatever")))).toBe(false);
  });

  it("does not branch on NODE_ENV when the credentials are unset (still rejects)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isBasicAuthorized(headersWithAuth())).toBe(false);
  });

  it("warns via console.warn (without leaking the credential values) when unset", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    isBasicAuthorized(headersWithAuth());

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] ?? [];
    expect(typeof message).toBe("string");
    expect(message).toContain("ADMIN_BASIC_AUTH_USER");
    expect(message).not.toContain("s3cret");
  });

  it("rejects when the header is missing but credentials are configured", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "s3cret");
    expect(isBasicAuthorized(headersWithAuth())).toBe(false);
  });

  it("rejects a non-Basic Authorization header", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "s3cret");
    expect(isBasicAuthorized(headersWithAuth("Bearer something"))).toBe(false);
  });

  it("rejects an incorrect username", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "s3cret");
    expect(isBasicAuthorized(headersWithAuth(basicAuthHeader("wrong-user", "s3cret")))).toBe(false);
  });

  it("rejects an incorrect password", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "s3cret");
    expect(isBasicAuthorized(headersWithAuth(basicAuthHeader("admin", "wrong-password")))).toBe(
      false,
    );
  });

  it("accepts the correct username and password", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "s3cret");
    expect(isBasicAuthorized(headersWithAuth(basicAuthHeader("admin", "s3cret")))).toBe(true);
  });

  it("handles a password containing a colon (only the first ':' separates user/password)", () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "pass:with:colons");
    expect(isBasicAuthorized(headersWithAuth(basicAuthHeader("admin", "pass:with:colons")))).toBe(
      true,
    );
  });
});
