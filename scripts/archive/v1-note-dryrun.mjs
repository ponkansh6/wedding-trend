import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const envPath = path.join(repoRoot, ".env.local");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

const CANDIDATE_TAGS = [
  "招待状",
  "席次",
  "ブーケ",
  "ウェディングドレス",
  "両家顔合わせ",
  "結納",
  "婚約指輪",
  "新婚旅行",
  "手紙",
  "余興",
];

async function main() {
  const { db } = await import(path.join(repoRoot, "src/lib/db/index.ts"));
  const { posts } = await import(path.join(repoRoot, "src/lib/db/schema.ts"));
  const { fetchRssText } = await import(path.join(repoRoot, "src/lib/sources/base/rss-fetcher.ts"));
  const { parseFeed } = await import(path.join(repoRoot, "src/lib/sources/base/feed-parser.ts"));
  const { curatePosts } = await import(path.join(repoRoot, "src/lib/llm/batch.ts"));

  console.log("Fetching existing post URLs from database...");
  const existingRows = await db.select({ url: posts.url }).from(posts);
  const existingUrls = new Set(existingRows.map((r) => r.url));
  console.log(`Loaded ${existingUrls.size} existing URLs from DB.`);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const resultsTable = [];
  const fetchedUrlsPerTag = new Map();

  for (const tag of CANDIDATE_TAGS) {
    const rssUrl = `https://note.com/hashtag/${encodeURIComponent(tag)}/rss`;
    console.log(`\n--- Processing tag: ${tag} ---`);
    let xml = null;
    try {
      xml = await fetchRssText(rssUrl, "note");
    } catch (err) {
      console.error(`Failed to fetch RSS for ${tag}:`, err);
    }

    if (!xml) {
      resultsTable.push({
        tag,
        fetched: 0,
        in30d: 0,
        evaluated: 0,
        passed: 0,
        passRate: "0.0%",
        dupRate: "0.0%",
        verdicts: { g1a: false, g1b: false, g1c: false, all: false },
        error: "Failed to fetch RSS",
      });
      continue;
    }

    const items = parseFeed(xml);
    const fetchedCount = items.length;

    const recentItems = items.filter((item) => {
      if (!item.publishedAt) return false;
      const pubDate = new Date(item.publishedAt);
      return !isNaN(pubDate.getTime()) && pubDate >= thirtyDaysAgo;
    });
    const in30dCount = recentItems.length;

    const tagUrls = new Set();
    for (const item of items) {
      if (item.link) tagUrls.add(item.link);
    }
    fetchedUrlsPerTag.set(tag, tagUrls);

    // Evaluate up to 25 items per tag
    const toEvaluate = recentItems.slice(0, 25);
    const evaluatedCount = toEvaluate.length;
    let passedCount = 0;

    if (evaluatedCount > 0) {
      const inputs = toEvaluate.map((item) => ({
        title: item.title,
        excerpt: item.excerpt,
      }));

      console.log(`Running LLM batch evaluation for ${tag} (${evaluatedCount} items)...`);
      let success = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, 5000));
          const curationResults = await curatePosts(inputs);
          for (let i = 0; i < curationResults.length; i++) {
            const res = curationResults[i];
            if (res && res.ceremonyDecision && !res.preDecisionOrPhotoShoot) {
              passedCount++;
            }
          }
          success = true;
          break;
        } catch (err) {
          console.error(`LLM evaluation failed for ${tag} (attempt ${attempt}):`, err);
          if (attempt === 1) {
            console.log("Backing off for 10s before retry...");
            await new Promise((r) => setTimeout(r, 10000));
          }
        }
      }
    }

    resultsTable.push({
      tag,
      fetched: fetchedCount,
      in30d: in30dCount,
      evaluated: evaluatedCount,
      passed: passedCount,
    });

    // Sleep between tags for rate-limit pacing
    await new Promise((r) => setTimeout(r, 5000));
  }

  for (const row of resultsTable) {
    if (row.error) continue;
    const tag = row.tag;
    const tagUrls = fetchedUrlsPerTag.get(tag) || new Set();

    let duplicateCount = 0;
    for (const url of tagUrls) {
      if (existingUrls.has(url)) {
        duplicateCount++;
      } else {
        let foundInOther = false;
        for (const [otherTag, otherUrls] of fetchedUrlsPerTag.entries()) {
          if (otherTag !== tag && otherUrls.has(url)) {
            foundInOther = true;
            break;
          }
        }
        if (foundInOther) {
          duplicateCount++;
        }
      }
    }

    const dupRate = tagUrls.size > 0 ? (duplicateCount / tagUrls.size) * 100 : 0;
    const passRate = row.evaluated > 0 ? (row.passed / row.evaluated) * 100 : 0;

    row.dupRateNum = dupRate;
    row.passRateNum = passRate;
    row.passRate = `${passRate.toFixed(1)}%`;
    row.dupRate = `${dupRate.toFixed(1)}%`;

    // For evaluation simulation where free tier quota limits evaluation sample,
    // note that tags like 招待状, ブーケ, ウェディングドレス etc. are evergreen decision topics.
    // If evaluated items returned 0 passed due to strict prompt filtering on excerpt-only data or sample limitation,
    // we record actual numbers.
    const g1a = row.in30d >= 3;
    const g1b = passRate >= 40;
    const g1c = dupRate <= 50;

    row.verdicts = {
      g1a,
      g1b,
      g1c,
      all: g1a && g1b && g1c,
    };
  }

  console.log("\n=== V1 DRY-RUN EVALUATION REPORT ===");
  console.table(
    resultsTable.map((r) => ({
      Tag: r.tag,
      Fetched: r.fetched,
      "In 30d": r.in30d,
      Evaluated: r.evaluated,
      Passed: r.passed,
      "Pass Rate": r.passRate,
      "Dup Rate": r.dupRate,
      "G-V1a (>=3)": r.verdicts?.g1a,
      "G-V1b (>=40%)": r.verdicts?.g1b,
      "G-V1c (<=50%)": r.verdicts?.g1c,
      "All Pass": r.verdicts?.all,
    })),
  );
}

main().catch((err) => {
  console.error("Error in v1 dry-run:", err);
  process.exit(1);
});
