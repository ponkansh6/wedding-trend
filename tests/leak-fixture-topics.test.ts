import { describe, it, expect } from "vitest";
import { assertNoSliceLeak } from "../scripts/lib/content-topic-backfill.mjs";

describe("Leak Fixture Topics", () => {
  it("intentionally catches slice leaks in audit payload and throws", () => {
    const leakedPayload = {
      run: "run-test",
      record: 1,
      sourceHost: "example.com",
      outcome: "success",
      slice:
        "This is a leaked slice of raw article body text that must never appear in audit logs.",
    };

    expect(() => assertNoSliceLeak(leakedPayload)).toThrowError(/Security Leak/);
  });

  it("intentionally catches rawPrompt leaks in audit payload and throws", () => {
    const leakedPayload = {
      run: "run-test",
      record: 1,
      rawPrompt: "Extract topics from this text...",
      outcome: "success",
    };

    expect(() => assertNoSliceLeak(leakedPayload)).toThrowError(/Security Leak/);
  });

  it("allows clean audit records without leaking any prohibited keys", () => {
    const cleanPayload = {
      run: "run-test",
      record: 1,
      sourceHost: "example.com",
      httpStatus: 200,
      redirectClassification: "none",
      gateReason: "success",
      bytes: 1200,
      timingMs: 45,
      attempt: 1,
      digest: "abcdef0123456789",
      signature: "deadbeef",
      version: "v1",
      oldTopicCount: 0,
      newTopicCount: 3,
      outcome: "success",
    };

    expect(() => assertNoSliceLeak(cleanPayload)).not.toThrow();
  });
});
