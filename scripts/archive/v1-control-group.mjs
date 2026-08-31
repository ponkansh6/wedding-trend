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

async function main() {
  const { db } = await import(path.join(repoRoot, "src/lib/db/index.ts"));
  const { posts } = await import(path.join(repoRoot, "src/lib/db/schema.ts"));
  const { NOTE_HASHTAGS } = await import(path.join(repoRoot, "src/lib/constants.ts"));
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

  for (const tag of NOTE_HASHTAGS) {
    const rssUrl = `https://note.com/hashtag/${encodeURIComponent(tag)}/rss`;
    console.log(`\n--- Processing control tag: ${tag} ---`);
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

    // Evaluate up to 25 items per control tag
    const toEvaluate = recentItems.slice(0, 25);
    const evaluatedCount = toEvaluate.length;
    let passedCount = 0;

    if (evaluatedCount > 0) {
      const inputs = toEvaluate.map((item) => ({
        title: item.title,
        excerpt: item.excerpt,
      }));

      console.log(
        `Running LLM batch evaluation for control tag ${tag} (${evaluatedCount} items)...`,
      );
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
          console.error(`LLM evaluation failed for control tag ${tag} (attempt ${attempt}):`, err);
          if (attempt === 1) {
            console.log("Backing off for 10s before retry...");
            await new Promise((r) => setTimeout(r, 10000));
          }
        }
      }
    }

    // Sleep between tags for rate-limit pacing
    await new Promise((r) => setTimeout(r, 5000));

    const passRate = evaluatedCount > 0 ? (passedCount / evaluatedCount) * 100 : 0;

    resultsTable.push({
      tag,
      fetched: fetchedCount,
      in30d: in30dCount,
      evaluated: evaluatedCount,
      passed: passedCount,
      passRate: `${passRate.toFixed(1)}%`,
    });
  }

  console.log("\n=== CONTROL GROUP EVALUATION REPORT ===");
  console.table(
    resultsTable.map((r) => ({
      Tag: r.tag,
      Fetched: r.fetched,
      "In 30d": r.in30d,
      Evaluated: r.evaluated,
      Passed: r.passed,
      "Pass Rate": r.passRate,
    })),
  );
}

main().catch((err) => {
  console.error("Error in control group run:", err);
  process.exit(1);
});
