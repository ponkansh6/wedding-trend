import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function createMockRequest(url: string, headers?: Record<string, string>): NextRequest {
  const request = new Request(url, { headers: new Headers(headers) });
  return new NextRequest(request);
}

describe("middleware - Basic Auth for /admin", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", undefined);
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", undefined);
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips middleware entirely for non-admin paths", async () => {
    const req = createMockRequest("http://localhost:3000/");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("allows access when auth is not configured and NODE_ENV is not production", async () => {
    const req = createMockRequest("http://localhost:3000/admin/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(200);
  });

  it("returns 503 when auth is not configured and NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = createMockRequest("http://localhost:3000/admin/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(503);
  });

  it("returns 401 when the Authorization header is missing", async () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "password");

    const req = createMockRequest("http://localhost:3000/admin/dashboard");
    const res = await middleware(req);

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("returns 401 for wrong credentials", async () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "password");

    const credentials = Buffer.from("admin:wrongpass").toString("base64");
    const req = createMockRequest("http://localhost:3000/admin/dashboard", {
      authorization: `Basic ${credentials}`,
    });
    const res = await middleware(req);

    expect(res.status).toBe(401);
  });

  it("allows access for correct credentials", async () => {
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", "admin");
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", "password");

    const credentials = Buffer.from("admin:password").toString("base64");
    const req = createMockRequest("http://localhost:3000/admin/dashboard", {
      authorization: `Basic ${credentials}`,
    });
    const res = await middleware(req);

    expect(res.status).toBe(200);
  });
});
