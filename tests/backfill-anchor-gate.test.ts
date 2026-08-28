import { describe, it, expect } from "vitest";
import { shouldRegenerateAnchor } from "../scripts/lib/backfill-anchor-gate.mjs";

describe("shouldRegenerateAnchor", () => {
  it("returns false if excerpt is null", () => {
    expect(shouldRegenerateAnchor({ title: "x", excerpt: null })).toBe(false);
  });

  it("returns false if excerpt is whitespace-only", () => {
    expect(shouldRegenerateAnchor({ title: "x", excerpt: "   " })).toBe(false);
  });

  it("returns false if excerpt is too short (length < 5)", () => {
    expect(shouldRegenerateAnchor({ title: "x", excerpt: "短い" })).toBe(false);
  });

  it("returns true if excerpt has meaningful length", () => {
    expect(
      shouldRegenerateAnchor({ title: "x", excerpt: "記事の本文です。十分に長い説明文。" }),
    ).toBe(true);
  });
});
