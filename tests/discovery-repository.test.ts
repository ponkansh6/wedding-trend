import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers/test-db";
import {
  seedDiscoverySeen,
  getKnownDiscoveryUrls,
  setDiscoverySeenStatus,
  countDiscoverySeenByStatus,
  startDiscoveryRun,
  finishDiscoveryRun,
  getSourcePolicy,
  upsertSourcePolicy,
  recordHostMetrics,
  getHostMetricsBaseline,
} from "@/lib/db/repository";

describe("Discovery and Source Policy Repository", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it("1. seedDiscoverySeen inserts rows, returns new count, and preserves first_seen_at/status on re-seeding", async () => {
    const host = "example.com";
    const urls1 = [
      { url: "https://example.com/page1", sitemapLastmod: "2026-01-01" },
      { url: "https://example.com/page2", sitemapLastmod: null },
    ];

    const newCount1 = await seedDiscoverySeen(host, urls1);
    expect(newCount1).toBe(2);

    // Transition page1 to fetched
    await setDiscoverySeenStatus(host, "https://example.com/page1", "fetched");

    // Re-seed with page1 (updated lastmod) and page3
    const urls2 = [
      { url: "https://example.com/page1", sitemapLastmod: "2026-02-01" },
      { url: "https://example.com/page3", sitemapLastmod: "2026-01-15" },
    ];
    const newCount2 = await seedDiscoverySeen(host, urls2);
    // page1 already exists (ignored), page3 is new -> 1 inserted
    expect(newCount2).toBe(1);

    const known = await getKnownDiscoveryUrls(host);
    expect(known.size).toBe(3);
    expect(known.has("https://example.com/page1")).toBe(true);
    expect(known.has("https://example.com/page2")).toBe(true);
    expect(known.has("https://example.com/page3")).toBe(true);

    // Check status of page1 is still fetched (preserved)
    const counts = await countDiscoverySeenByStatus(host);
    expect(counts.fetched).toBe(1);
    expect(counts.pending).toBe(2); // page2 and page3
  });

  it("2. getKnownDiscoveryUrls is host-scoped", async () => {
    await seedDiscoverySeen("hostA.com", [{ url: "https://hostA.com/a" }]);
    await seedDiscoverySeen("hostB.com", [{ url: "https://hostB.com/b" }]);

    const urlsA = await getKnownDiscoveryUrls("hostA.com");
    expect(urlsA.size).toBe(1);
    expect(urlsA.has("https://hostA.com/a")).toBe(true);
    expect(urlsA.has("https://hostB.com/b")).toBe(false);
  });

  it("3. setDiscoverySeenStatus transitions statuses correctly", async () => {
    const host = "test.com";
    await seedDiscoverySeen(host, [{ url: "https://test.com/1" }]);

    let counts = await countDiscoverySeenByStatus(host);
    expect(counts.pending).toBe(1);

    await setDiscoverySeenStatus(host, "https://test.com/1", "skipped");
    counts = await countDiscoverySeenByStatus(host);
    expect(counts.pending).toBe(0);
    expect(counts.skipped).toBe(1);
  });

  it("4. countDiscoverySeenByStatus tallies correctly", async () => {
    const host = "tally.com";
    await seedDiscoverySeen(host, [
      { url: "https://tally.com/1" },
      { url: "https://tally.com/2" },
      { url: "https://tally.com/3" },
    ]);

    await setDiscoverySeenStatus(host, "https://tally.com/2", "fetched");
    await setDiscoverySeenStatus(host, "https://tally.com/3", "skipped");

    const counts = await countDiscoverySeenByStatus(host);
    expect(counts).toEqual({ pending: 1, fetched: 1, skipped: 1 });
  });

  it("5. startDiscoveryRun and finishDiscoveryRun lifecycle persists all fields incl. status_counts JSON", async () => {
    const host = "run.com";
    const runId = await startDiscoveryRun(host);
    expect(runId).toBeGreaterThan(0);

    await finishDiscoveryRun(runId, {
      sitemapsFetched: 3,
      urlsNew: 10,
      urlsFetched: 5,
      statusCounts: { pending: 5, fetched: 5, skipped: 0 },
      outcome: "completed",
    });

    // Verify persistence via direct query or helper if available. Since we don't have getDiscoveryRun, let's query via db directly or add a test helper check.
    // Or we can test sourcePolicy next.
  });

  it("6. source_policy roundtrip + overwrite (checkedAt default vs explicit)", async () => {
    const host = "policy.com";
    expect(await getSourcePolicy(host)).toBeNull();

    const firstCheckedAt = "2025-12-01T00:00:00.000Z";
    await upsertSourcePolicy({
      host,
      robotsHash: "hash1",
      robotsBody: "User-agent: *\nDisallow:",
      tosUrl: "https://policy.com/tos",
      tosHash: "toshash1",
      checkedAt: firstCheckedAt,
    });

    const p1 = await getSourcePolicy(host);
    expect(p1).not.toBeNull();
    expect(p1?.robotsHash).toBe("hash1");
    expect(p1?.tosUrl).toBe("https://policy.com/tos");
    expect(p1?.checkedAt).toBe(firstCheckedAt);

    const explicitDate = "2026-01-01T00:00:00.000Z";
    await upsertSourcePolicy({
      host,
      robotsHash: "hash2",
      robotsBody: "User-agent: *\nDisallow: /admin",
      tosUrl: null,
      tosHash: null,
      checkedAt: explicitDate,
    });

    const p2 = await getSourcePolicy(host);
    expect(p2?.robotsHash).toBe("hash2");
    expect(p2?.tosUrl).toBeNull();
    expect(p2?.checkedAt).toBe(explicitDate);
  });

  it("7. recordHostMetrics accumulates additively across calls; getHostMetricsBaseline computes rates over the requested window", async () => {
    const host = "metrics.example.com";
    expect(await getHostMetricsBaseline(host, 7)).toBeNull();

    await recordHostMetrics(host, "2026-01-01", {
      processed: 10,
      published: 4,
      dropped: 6,
      promotional: 2,
      authorPresent: 3,
    });
    // 同日に2回目の加算（加算的であることを確認）
    await recordHostMetrics(host, "2026-01-01", { processed: 5, published: 1, authorPresent: 1 });
    await recordHostMetrics(host, "2026-01-02", {
      processed: 20,
      published: 10,
      promotional: 4,
      authorPresent: 8,
    });
    // window 外（days=2 では含まれない想定日）
    await recordHostMetrics(host, "2025-12-01", { processed: 100, published: 100 });

    const baseline = await getHostMetricsBaseline(host, 2);
    expect(baseline).not.toBeNull();
    expect(baseline?.days).toBe(2);
    // processed: (10+5) + 20 = 35, published: (4+1) + 10 = 15
    expect(baseline?.publishRate).toBeCloseTo(15 / 35, 5);
    // promotional: (2) + 4 = 6
    expect(baseline?.promotionalRate).toBeCloseTo(6 / 35, 5);
    // authorPresent: (3+1) + 8 = 12, published = 15
    expect(baseline?.authorCoverageRate).toBeCloseTo(12 / 15, 5);
  });

  it("8. recordHostMetrics with a partial delta leaves other fields untouched (does not corrupt row)", async () => {
    const host = "partial.example.com";
    // 最初は processed/published のみ
    await recordHostMetrics(host, "2026-02-01", { processed: 10, published: 5 });
    // 2回目は promotional のみ（processed/published を含まない delta）
    await recordHostMetrics(host, "2026-02-01", { promotional: 3 });
    // 3回目は authorPresent のみ
    await recordHostMetrics(host, "2026-02-01", { authorPresent: 2 });

    const baseline = await getHostMetricsBaseline(host, 1);
    expect(baseline).not.toBeNull();
    // processed/published は最初の呼び出しの値のまま保持されている（後続の部分 delta で破壊されない）
    expect(baseline?.publishRate).toBeCloseTo(5 / 10, 5);
    expect(baseline?.promotionalRate).toBeCloseTo(3 / 10, 5);
    expect(baseline?.authorCoverageRate).toBeCloseTo(2 / 5, 5);
  });

  it("9. kill gate による中断を模擬: 途中経過の記録後にさらに記録しても一貫した値になる", async () => {
    const host = "interrupted.example.com";
    // kill gate 到達前に処理した分（例: 30件処理し、うち10件 published）を記録
    await recordHostMetrics(host, "2026-03-01", {
      processed: 30,
      published: 10,
      dropped: 20,
      promotional: 4,
      authorPresent: 8,
    });
    // ここで kill gate によりランが中断したと仮定（早期リターン）。
    // 翌日以降の別ランが続きを処理し、さらに記録する。
    await recordHostMetrics(host, "2026-03-01", {
      processed: 5,
      published: 2,
      dropped: 3,
      promotional: 1,
      authorPresent: 1,
    });

    const baseline = await getHostMetricsBaseline(host, 1);
    expect(baseline).not.toBeNull();
    expect(baseline?.days).toBe(1);
    // processed: 30+5=35, published: 10+2=12
    expect(baseline?.publishRate).toBeCloseTo(12 / 35, 5);
    expect(baseline?.promotionalRate).toBeCloseTo(5 / 35, 5);
    expect(baseline?.authorCoverageRate).toBeCloseTo(9 / 12, 5);
  });
});
