import { describe, it, expect, vi } from "vitest";
import {
  isGenericTopics,
  isLegacySignature,
  computeTopicBackfillSignature,
  assertNoSliceLeak,
} from "../scripts/lib/content-topic-backfill.mjs";

describe("Content Topic Backfill Unit Tests", () => {
  it("detects generic topics correctly", () => {
    expect(isGenericTopics(["準備の進め方"])).toBe(true);
    expect(isGenericTopics(["心構え", "ポイント"])).toBe(true);
    expect(isGenericTopics(["ウェディングドレスの選び方"])).toBe(false);
    expect(isGenericTopics([])).toBe(true);
  });

  it("detects legacy signature correctly", () => {
    expect(isLegacySignature({ promptVersion: null })).toBe(true);
    expect(isLegacySignature({ promptVersion: "legacy" })).toBe(true);
    expect(isLegacySignature({ promptVersion: "2026-09-03" })).toBe(false);
  });

  it("computes HMAC signature deterministically", () => {
    const sig1 = computeTopicBackfillSignature({
      recordId: 123,
      normalizedUrl: "https://example.com/1",
      sourceContentDigest: "abc",
      extractionVersion: "v1",
      topicPromptVersion: "v1",
      schemaVersion: "v1",
      modelId: "gemini",
      secretKey: "test-secret",
    });
    const sig2 = computeTopicBackfillSignature({
      recordId: 123,
      normalizedUrl: "https://example.com/1",
      sourceContentDigest: "abc",
      extractionVersion: "v1",
      topicPromptVersion: "v1",
      schemaVersion: "v1",
      modelId: "gemini",
      secretKey: "test-secret",
    });
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64);
  });

  it("assertNoSliceLeak catches prohibited terms", () => {
    expect(() =>
      assertNoSliceLeak({ outcome: "success", slice: "secret slice content" }),
    ).toThrowError(/Security Leak/);
    expect(() => assertNoSliceLeak({ outcome: "success", container: "div" })).toThrowError(
      /Security Leak/,
    );
    expect(() => assertNoSliceLeak({ outcome: "success", clean: true })).not.toThrow();
  });
});
