import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupTestDb } from "./helpers/test-db";
import { discoverNewUrls } from "@/lib/sources/sitemap-discovery";
import { getKnownDiscoveryUrls, setDiscoveryCursor, seedDiscoverySeen } from "@/lib/db/repository";
import { db } from "@/lib/db";
import { discoveryRun } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

describe("Sitemap Discovery Module", () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.restoreAllMocks();
  });

  it("1. sitemapindex fetches children and parses correctly (sitemapsFetched count correct)", async () => {
    const host = "index-test.com";
    const rootSitemapUrl = `https://${host}/sitemap.xml`;
    const childSitemapUrl = `https://${host}/sitemap-sub.xml`;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === rootSitemapUrl) {
        return {
          ok: true,
          text: async () => `<?xml version="1.0" encoding="UTF-8"?>
            <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <sitemap>
                <loc>${childSitemapUrl}</loc>
                <lastmod>2026-06-01T00:00:00.000Z</lastmod>
              </sitemap>
            </sitemapindex>`,
        };
      }
      if (url === childSitemapUrl) {
        return {
          ok: true,
          text: async () => `<?xml version="1.0" encoding="UTF-8"?>
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
              <url>
                <loc>https://${host}/post-1</loc>
                <lastmod>2026-06-01T00:00:00.000Z</lastmod>
              </url>
            </urlset>`,
        };
      }
      return { ok: false, status: 404 };
    });

    vi.stubGlobal("fetch", fetchMock);

    const outcome = await discoverNewUrls(host, [rootSitemapUrl]);
    expect(outcome.outcome).toBe("seeded"); // First run is seeding mode
    expect(outcome.sitemapsFetched).toBe(2); // root + child
    expect(outcome.urlsNew).toBe(0); // seeding mode records urlsNew as 0

    const known = await getKnownDiscoveryUrls(host);
    expect(known.size).toBe(1);
    expect(known.has(`https://${host}/post-1`)).toBe(true);
  });

  it("2. urlset extraction with missing lastmod tolerated", async () => {
    const host = "urlset-test.com";
    const sitemapUrl = `https://${host}/sitemap.xml`;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc>https://${host}/no-lastmod</loc>
          </url>
        </urlset>`,
    });

    vi.stubGlobal("fetch", fetchMock);

    const outcome = await discoverNewUrls(host, [sitemapUrl]);
    expect(outcome.outcome).toBe("seeded");
    expect(outcome.sitemapsFetched).toBe(1);
  });

  it("3. First run (empty known set) → seeding mode: all recorded, outcome 'seeded', urlsNew 0", async () => {
    const host = "seed-test.com";
    const sitemapUrl = `https://${host}/sitemap.xml`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => `<?xml version="1.0"?>
          <urlset>
            <url><loc>https://${host}/a</loc></url>
            <url><loc>https://${host}/b</loc></url>
          </urlset>`,
      }),
    );

    const outcome = await discoverNewUrls(host, [sitemapUrl]);
    expect(outcome.outcome).toBe("seeded");
    expect(outcome.urlsNew).toBe(0);

    const runs = await db
      .select()
      .from(discoveryRun)
      .where(eq(discoveryRun.host, host))
      .orderBy(desc(discoveryRun.id))
      .limit(1);
    expect(runs[0]?.outcome).toBe("seeded");

    const known = await getKnownDiscoveryUrls(host);
    expect(known.size).toBe(2);
    expect(known.has(`https://${host}/a`)).toBe(true);
    expect(known.has(`https://${host}/b`)).toBe(true);
  });

  it("4. Second run with new + known (changed lastmod ignored)", async () => {
    const host = "diff-test.com";
    const sitemapUrl = `https://${host}/sitemap.xml`;

    // First run (seeding)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => `<?xml version="1.0"?>
          <urlset>
            <url><loc>https://${host}/known-1</loc><lastmod>2026-01-01T00:00:00.000Z</lastmod></url>
            <url><loc>https://${host}/known-2</loc><lastmod>2026-01-01T00:00:00.000Z</lastmod></url>
          </urlset>`,
      }),
    );

    await discoverNewUrls(host, [sitemapUrl]);

    // Second run: known-1 modified lastmod (should be ignored), known-2 same, new-3 and new-4 added
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => `<?xml version="1.0"?>
          <urlset>
            <url><loc>https://${host}/known-1</loc><lastmod>2026-06-01T00:00:00.000Z</lastmod></url>
            <url><loc>https://${host}/known-2</loc><lastmod>2026-01-01T00:00:00.000Z</lastmod></url>
            <url><loc>https://${host}/new-3</loc><lastmod>2026-05-01T00:00:00.000Z</lastmod></url>
            <url><loc>https://${host}/new-4</loc><lastmod>2026-05-01T00:00:00.000Z</lastmod></url>
          </urlset>`,
      }),
    );

    const outcome = await discoverNewUrls(host, [sitemapUrl]);
    expect(outcome.outcome).toBe("completed");
    expect(outcome.urlsNew).toBe(2);

    const runs = await db
      .select()
      .from(discoveryRun)
      .where(eq(discoveryRun.host, host))
      .orderBy(desc(discoveryRun.id))
      .limit(1);
    expect(runs[0]?.outcome).toBe("completed");

    const known = await getKnownDiscoveryUrls(host);
    expect(known.size).toBe(4);
    expect(known.has(`https://${host}/new-3`)).toBe(true);
    expect(known.has(`https://${host}/new-4`)).toBe(true);
  });

  it("5. Fetch failure of a child sitemap -> outcome 'failed' but run row still finished", async () => {
    const host = "fail-test.com";
    const rootUrl = `https://${host}/sitemap.xml`;
    const childUrl = `https://${host}/child.xml`;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url === rootUrl) {
          return {
            ok: true,
            text: async () =>
              `<sitemapindex><sitemap><loc>${childUrl}</loc></sitemap></sitemapindex>`,
          };
        }
        return { ok: false, status: 500 };
      }),
    );

    const outcome = await discoverNewUrls(host, [rootUrl]);
    expect(outcome.outcome).toBe("failed");
  });

  it("6. Threshold distrust path: cursor skips child, resulting in new items > LASTMOD_DIFF_ALERT_THRESHOLD (100), triggering completed_lastmod_distrusted outcome and database record", async () => {
    const host = "distrust-test.com";
    const rootUrl = `https://${host}/sitemap.xml`;
    const skippedChildUrl = `https://${host}/skipped-child.xml`;
    const activeChildUrl = `https://${host}/active-child.xml`;

    // First, seed some known URLs so we are NOT in seeding mode
    await seedDiscoverySeen(host, [
      { url: `https://${host}/initial-1`, sitemapLastmod: "2025-01-01T00:00:00.000Z" },
    ]);

    // Set a cursor in the future so skippedChildUrl (lastmod older) gets skipped,
    // but give activeChildUrl a RECENT lastmod so it is NOT skipped (usedOptimization = true).
    await setDiscoveryCursor(host, "2026-03-01T00:00:00.000Z");

    // Generate > 100 new URLs in activeChildUrl
    const newUrlsXml = Array.from(
      { length: 105 },
      (_, i) => `
      <url>
        <loc>https://${host}/new-${i}</loc>
        <lastmod>2026-06-01T00:00:00.000Z</lastmod>
      </url>
    `,
    ).join("");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url === rootUrl) {
          return {
            ok: true,
            text: async () => `<?xml version="1.0"?>
              <sitemapindex>
                <sitemap><loc>${skippedChildUrl}</loc><lastmod>2025-01-01T00:00:00.000Z</lastmod></sitemap>
                <sitemap><loc>${activeChildUrl}</loc><lastmod>2026-06-01T00:00:00.000Z</lastmod></sitemap>
              </sitemapindex>`,
          };
        }
        if (url === skippedChildUrl) {
          return {
            ok: true,
            text: async () => `<urlset><url><loc>https://${host}/skipped-url</loc></url></urlset>`,
          };
        }
        if (url === activeChildUrl) {
          return {
            ok: true,
            text: async () => `<urlset>${newUrlsXml}</urlset>`,
          };
        }
        return { ok: false, status: 404 };
      }),
    );

    const outcome = await discoverNewUrls(host, [rootUrl]);
    expect(outcome.outcome).toBe("completed_lastmod_distrusted");
    // 再読パスは全子サイトマップを読むため、スキップ対象だった子の /skipped-url も新規に加算される
    expect(outcome.urlsNew).toBe(106);

    // Verify database record
    const runs = await db
      .select()
      .from(discoveryRun)
      .where(eq(discoveryRun.host, host))
      .orderBy(desc(discoveryRun.id))
      .limit(1);
    expect(runs[0]?.outcome).toBe("completed_lastmod_distrusted");

    // Verify new URLs are in known set
    const known = await getKnownDiscoveryUrls(host);
    expect(known.has(`https://${host}/new-0`)).toBe(true);
    expect(known.has(`https://${host}/new-104`)).toBe(true);
  });

  it("7. All-identical past lastmod pathology blocks skipping: children are not skipped despite cursor, discovering expected URLs with completed outcome", async () => {
    const host = "pathology-test.com";
    const rootUrl = `https://${host}/sitemap.xml`;
    const child1Url = `https://${host}/child-1.xml`;
    const child2Url = `https://${host}/child-2.xml`;

    // Set a cursor in the future, but all child sitemaps have identical past lastmods (pathological)
    await setDiscoveryCursor(host, "2026-12-31T00:00:00.000Z");

    await seedDiscoverySeen(host, [
      { url: `https://${host}/known-1`, sitemapLastmod: "2025-01-01T00:00:00.000Z" },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url === rootUrl) {
          return {
            ok: true,
            text: async () => `<?xml version="1.0"?>
              <sitemapindex>
                <sitemap><loc>${child1Url}</loc><lastmod>2025-01-01T00:00:00.000Z</lastmod></sitemap>
                <sitemap><loc>${child2Url}</loc><lastmod>2025-01-01T00:00:00.000Z</lastmod></sitemap>
              </sitemapindex>`,
          };
        }
        if (url === child1Url) {
          return {
            ok: true,
            text: async () =>
              `<urlset><url><loc>https://${host}/pathology-url-1</loc></url></urlset>`,
          };
        }
        if (url === child2Url) {
          return {
            ok: true,
            text: async () =>
              `<urlset><url><loc>https://${host}/pathology-url-2</loc></url></urlset>`,
          };
        }
        return { ok: false, status: 404 };
      }),
    );

    const outcome = await discoverNewUrls(host, [rootUrl]);
    expect(outcome.outcome).toBe("completed");
    expect(outcome.urlsNew).toBe(2);

    const known = await getKnownDiscoveryUrls(host);
    expect(known.has(`https://${host}/pathology-url-1`)).toBe(true);
    expect(known.has(`https://${host}/pathology-url-2`)).toBe(true);
  });

  describe("article path whitelist enforcement (allowlisted host only)", () => {
    const host = "www.mwed.jp";
    const rootUrl = `https://${host}/sitemap_stories.xml`;
    const storyCaseUrl = `https://${host}/story/cases/174/`;
    const hallReviewStoryUrl = `https://${host}/hall/16479/rev/story/83/`;
    const reviewCommentUrl = `https://${host}/hall/16479/rev/12345/`;

    function stubSitemap() {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          if (url === rootUrl) {
            return {
              ok: true,
              text: async () => `<?xml version="1.0" encoding="UTF-8"?>
                <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
                  <url><loc>${storyCaseUrl}</loc></url>
                  <url><loc>${hallReviewStoryUrl}</loc></url>
                  <url><loc>${reviewCommentUrl}</loc></url>
                </urlset>`,
            };
          }
          return { ok: false, status: 404 };
        }),
      );
    }

    it("seeds the two allowed article path shapes but drops the review-comment page", async () => {
      stubSitemap();

      const outcome = await discoverNewUrls(host, [rootUrl]);
      expect(outcome.outcome).toBe("seeded");

      const known = await getKnownDiscoveryUrls(host);
      expect(known.has(storyCaseUrl)).toBe(true);
      expect(known.has(hallReviewStoryUrl)).toBe(true);
      expect(known.has(reviewCommentUrl)).toBe(false);
      expect(known.size).toBe(2);
    });

    it("boundary: /hall/{id}/rev/story/{id}/ is allowed, /hall/{id}/rev/{id}/ is not", async () => {
      stubSitemap();

      await discoverNewUrls(host, [rootUrl]);
      const known = await getKnownDiscoveryUrls(host);

      expect(known.has(hallReviewStoryUrl)).toBe(true);
      expect(known.has(reviewCommentUrl)).toBe(false);
    });

    it("does not restrict paths for a host that is not in HOST_ALLOWLIST (regression)", async () => {
      const otherHost = "non-allowlisted-host.example.com";
      const otherRoot = `https://${otherHost}/sitemap.xml`;
      const arbitraryUrl = `https://${otherHost}/whatever/path/not/matching/any/pattern`;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          if (url === otherRoot) {
            return {
              ok: true,
              text: async () => `<urlset><url><loc>${arbitraryUrl}</loc></url></urlset>`,
            };
          }
          return { ok: false, status: 404 };
        }),
      );

      const outcome = await discoverNewUrls(otherHost, [otherRoot]);
      expect(outcome.outcome).toBe("seeded");

      const known = await getKnownDiscoveryUrls(otherHost);
      expect(known.has(arbitraryUrl)).toBe(true);
    });
  });
});
