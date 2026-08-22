import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "@/lib/url";

describe("canonicalizeUrl", () => {
  it("strips utm_* query params", () => {
    expect(
      canonicalizeUrl("https://example.com/post?utm_source=twitter&utm_medium=social&id=1"),
    ).toBe("https://example.com/post?id=1");
  });

  it("strips fbclid", () => {
    expect(canonicalizeUrl("https://example.com/post?fbclid=abc123&id=1")).toBe(
      "https://example.com/post?id=1",
    );
  });

  it("lowercases the scheme and host but preserves path case", () => {
    // パスは RFC 3986 上 case-sensitive。Instagram のショートコードや
    // YouTube の動画 ID はここを壊すとリンクが 404 になる。
    expect(canonicalizeUrl("https://Example.COM/Post/ABC")).toBe("https://example.com/Post/ABC");
  });

  it("preserves case in identifiers that are case-sensitive in practice", () => {
    expect(canonicalizeUrl("https://www.instagram.com/p/CUbHfhpswxt/")).toBe(
      "https://www.instagram.com/p/CUbHfhpswxt",
    );
    expect(canonicalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("returns null for non-http(s) schemes", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("data:text/html,<h1>x</h1>")).toBeNull();
  });

  it("removes a trailing slash (but keeps the root path as-is)", () => {
    expect(canonicalizeUrl("https://example.com/post/")).toBe("https://example.com/post");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("dedupes equivalent URLs to the same canonical form", () => {
    // ホストの表記ゆれとトラッキングパラメータのみを吸収する。
    const a = canonicalizeUrl("https://Example.com/Post/?utm_source=x");
    const b = canonicalizeUrl("https://example.com/Post?utm_source=y");
    expect(a).toBe(b);
  });

  it("returns null for unparsable URLs", () => {
    expect(canonicalizeUrl("not a url")).toBeNull();
  });
});
