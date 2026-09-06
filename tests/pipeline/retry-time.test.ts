import { describe, expect, it } from "vitest";
import { addHoursIso } from "@/lib/pipeline/retry-time";

describe("addHoursIso", () => {
  it("adds positive, negative, and fractional hours", () => {
    expect(addHoursIso("2026-01-01T00:00:00.000Z", 2)).toBe("2026-01-01T02:00:00.000Z");
    expect(addHoursIso("2026-01-01T00:00:00.000Z", -2)).toBe("2025-12-31T22:00:00.000Z");
    expect(addHoursIso("2026-01-01T00:00:00.000Z", 1.5)).toBe("2026-01-01T01:30:00.000Z");
  });

  it("normalizes timezone offsets and preserves millisecond arithmetic", () => {
    expect(addHoursIso("2026-03-08T01:30:00.123-05:00", 1)).toBe("2026-03-08T07:30:00.123Z");
  });

  it("throws RangeError for an invalid ISO value", () => {
    expect(() => addHoursIso("invalid ISO", 1)).toThrow(RangeError);
  });
});
