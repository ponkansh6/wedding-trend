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

  it("lowercases the whole URL", () => {
    expect(canonicalizeUrl("https://Example.COM/Post/ABC")).toBe("https://example.com/post/abc");
  });

  it("removes a trailing slash (but keeps the root path as-is)", () => {
    expect(canonicalizeUrl("https://example.com/post/")).toBe("https://example.com/post");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("dedupes equivalent URLs to the same canonical form", () => {
    const a = canonicalizeUrl("https://Example.com/Post/?utm_source=x");
    const b = canonicalizeUrl("https://example.com/post?utm_source=y");
    expect(a).toBe(b);
  });

  it("returns null for unparsable URLs", () => {
    expect(canonicalizeUrl("not a url")).toBeNull();
  });
});
