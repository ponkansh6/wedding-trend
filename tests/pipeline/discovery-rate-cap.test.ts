import { describe, expect, it, vi } from "vitest";
import {
  checkDiscoveryRateCap,
  jstDayKey,
  jstDayStartIso,
} from "@/lib/pipeline/discovery-rate-cap";
import { isDailyPublishCapReached } from "@/lib/pipeline/rate-cap";

vi.mock("@/lib/pipeline/rate-cap", () => ({
  isDailyPublishCapReached: vi.fn(),
}));

const mockedIsDailyPublishCapReached = vi.mocked(isDailyPublishCapReached);

describe("discovery rate cap", () => {
  it("JSTの日跨ぎ直前・直後をUTC開始時刻へ変換する", () => {
    expect(jstDayStartIso("2026-09-06T14:59:59.999Z")).toBe("2026-09-05T15:00:00.000Z");
    expect(jstDayStartIso("2026-09-06T15:00:00.000Z")).toBe("2026-09-06T15:00:00.000Z");
  });

  it("UTC日付ではなくJST暦日のキーを使う", () => {
    expect(jstDayKey("2026-09-06T14:59:59.999Z")).toBe("2026-09-06");
    expect(jstDayKey("2026-09-06T15:00:00.000Z")).toBe("2026-09-07");
  });

  it("JST日次開始時刻を公開数リポジトリ判定へ渡し、その結果を維持する", async () => {
    mockedIsDailyPublishCapReached.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(checkDiscoveryRateCap("2026-09-06T14:59:59.999Z")).resolves.toEqual({
      capped: true,
    });
    await expect(checkDiscoveryRateCap("2026-09-06T15:00:00.000Z")).resolves.toEqual({
      capped: false,
    });

    expect(mockedIsDailyPublishCapReached).toHaveBeenNthCalledWith(1, "2026-09-05T15:00:00.000Z");
    expect(mockedIsDailyPublishCapReached).toHaveBeenNthCalledWith(2, "2026-09-06T15:00:00.000Z");
  });
});
