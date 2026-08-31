/**
 * Purpose: `resolveSourceName` / `registrableDomain` のテスト。もとは
 * `tests/pipeline-evergreen.test.ts` にあったが、実装が `evergreen.ts`
 * （旧骨格・削除済み）から `@/lib/pipeline/source-name.ts`（中立モジュール）
 * へ移設されたのに伴い、テストもここへ移した（Stage 6 S2 Commit 4）。
 * アサーション内容は移設前と同一。
 */

import { describe, expect, it } from "vitest";
import { resolveSourceName, registrableDomain } from "@/lib/pipeline/source-name";

describe("resolveSourceName / registrableDomain (src/lib/pipeline/source-name.ts)", () => {
  const meta = {
    title: "T",
    description: "D",
    image: null,
    siteName: null,
    author: null,
    datePublished: null,
  };

  it("prefers explicit sourceName (trimmed)", () => {
    expect(resolveSourceName("https://example.com/x", meta, { sourceName: "  Site  " })).toBe(
      "Site",
    );
  });
  it("falls back to og:site_name when no explicit", () => {
    expect(resolveSourceName("https://example.com/x", { ...meta, siteName: "OGSite" }, {})).toBe(
      "OGSite",
    );
  });
  it("falls back to registrable domain when both absent", () => {
    expect(resolveSourceName("https://www.zexy.net/x", meta, {})).toBe("zexy.net");
  });
  it("returns null when nothing resolves (unparseable URL)", () => {
    expect(resolveSourceName("not a url", meta, {})).toBeNull();
  });
  it("registrableDomain strips www. and returns null for empty/unparseable hostname", () => {
    expect(registrableDomain("https://www.example.com/x")).toBe("example.com");
    expect(registrableDomain("http:///")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
  });
});
