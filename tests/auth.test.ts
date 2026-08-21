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
  });

  it("allows the request when CRON_SECRET is not configured", () => {
    expect(isBearerAuthorized(requestWithAuth())).toBe(true);
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
