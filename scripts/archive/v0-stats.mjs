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
  const { posts, postUsefulnessCriteria } = await import(
    path.join(repoRoot, "src/lib/db/schema.ts")
  );
  const { sql } = await import("drizzle-orm");

  console.log("=== V0 STATS REPORT ===");

  const totalPostsResult = await db.select({ count: sql`count(*)` }).from(posts);
  const totalPosts = totalPostsResult[0]?.count ?? 0;
  console.log(`a. Total row count of posts: ${totalPosts}`);

  const dateRangeResult = await db
    .select({
      minPublishedAt: sql`min(published_at)`,
      maxPublishedAt: sql`max(published_at)`,
      minCreatedAt: sql`min(created_at)`,
      maxCreatedAt: sql`max(created_at)`,
    })
    .from(posts);
  console.log(`b. Date range:`, dateRangeResult[0]);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`c. 30 days window start: ${thirtyDaysAgo}`);

  const thirtyDaysPosts = await db
    .select({
      sourceType: posts.sourceType,
      sourceName: posts.sourceName,
      count: sql`count(*)`,
    })
    .from(posts)
    .where(sql`published_at >= ${thirtyDaysAgo} OR created_at >= ${thirtyDaysAgo}`)
    .groupBy(posts.sourceType, posts.sourceName);

  console.log("Ingested in last 30 days by source:", thirtyDaysPosts);

  const totalCriteriaResult = await db
    .select({ count: sql`count(*)` })
    .from(postUsefulnessCriteria);
  const totalCriteria = totalCriteriaResult[0]?.count ?? 0;

  const windowPostsWithCriteria = await db
    .select({ count: sql`count(DISTINCT ${posts.id})` })
    .from(posts)
    .innerJoin(postUsefulnessCriteria, sql`${posts.id} = ${postUsefulnessCriteria.postId}`)
    .where(sql`published_at >= ${thirtyDaysAgo} OR created_at >= ${thirtyDaysAgo}`);
  const windowCriteriaCount = windowPostsWithCriteria[0]?.count ?? 0;

  const windowTotalPostsResult = await db
    .select({ count: sql`count(*)` })
    .from(posts)
    .where(sql`published_at >= ${thirtyDaysAgo} OR created_at >= ${thirtyDaysAgo}`);
  const windowTotal = windowTotalPostsResult[0]?.count ?? 0;

  console.log(`d. Total post_usefulness_criteria rows: ${totalCriteria}`);
  console.log(`   Posts in 30-day window: ${windowTotal}`);
  console.log(`   Window posts with usefulness criteria: ${windowCriteriaCount}`);
  console.log(
    `   Ratio (window): ${windowTotal > 0 ? ((windowCriteriaCount / windowTotal) * 100).toFixed(2) : 0}%`,
  );

  const totalBlogResult = await db
    .select({ count: sql`count(*)` })
    .from(posts)
    .where(sql`source_type = 'blog'`);
  const totalBlog = totalBlogResult[0]?.count ?? 0;

  const windowBlogResult = await db
    .select({ count: sql`count(*)` })
    .from(posts)
    .where(
      sql`source_type = 'blog' AND (published_at >= ${thirtyDaysAgo} OR created_at >= ${thirtyDaysAgo})`,
    );
  const windowBlog = windowBlogResult[0]?.count ?? 0;

  console.log(`e. Classic lane (blog) total: ${totalBlog}, in window: ${windowBlog}`);
}

main().catch((err) => {
  console.error("Error running v0-stats:", err);
  process.exit(1);
});
