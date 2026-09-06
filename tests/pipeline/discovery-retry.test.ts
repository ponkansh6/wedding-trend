import { describe, expect, it } from "vitest";
import { decideDiscoveryRetry } from "@/lib/pipeline/discovery-retry";

const nowIso = "2026-01-01T00:00:00.000Z";

describe("decideDiscoveryRetry", () => {
  it.each([
    [0, "2026-01-01T01:00:00.000Z"],
    [1, "2026-01-01T06:00:00.000Z"],
    [2, "2026-01-02T00:00:00.000Z"],
  ])("schedules attempt %i with its existing backoff", (attempts, nextAttemptAt) => {
    expect(
      decideDiscoveryRetry({ nowIso, attempts, firstQueuedAt: "2025-12-31T00:00:00.000Z" }),
    ).toEqual({
      kind: "schedule",
      attempts: attempts + 1,
      firstQueuedAt: "2025-12-31T00:00:00.000Z",
      nextAttemptAt,
      expiresAt: "2026-01-03T00:00:00.000Z",
    });
  });

  it("uses now for the first queue time and preserves its ISO normalization", () => {
    expect(
      decideDiscoveryRetry({
        nowIso: "2026-03-08T01:30:00.123-05:00",
        attempts: 0,
        firstQueuedAt: null,
      }),
    ).toEqual({
      kind: "schedule",
      attempts: 1,
      firstQueuedAt: "2026-03-08T01:30:00.123-05:00",
      nextAttemptAt: "2026-03-08T07:30:00.123Z",
      expiresAt: "2026-03-11T06:30:00.123Z",
    });
  });

  it("becomes terminal only after the maximum attempt", () => {
    expect(decideDiscoveryRetry({ nowIso, attempts: 3, firstQueuedAt: nowIso })).toEqual({
      kind: "terminal",
    });
  });

  it("preserves the existing negative-attempt fallback behavior", () => {
    expect(decideDiscoveryRetry({ nowIso, attempts: -1, firstQueuedAt: nowIso })).toMatchObject({
      kind: "schedule",
      attempts: 0,
      nextAttemptAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("returns scheduling data only, without queue DTO or content fields", () => {
    const decision = decideDiscoveryRetry({ nowIso, attempts: 0, firstQueuedAt: null });
    expect(decision).not.toHaveProperty("url");
    expect(decision).not.toHaveProperty("urlHash");
    expect(decision).not.toHaveProperty("host");
    expect(decision).not.toHaveProperty("reason");
    expect(decision).not.toHaveProperty("body");
  });
});
