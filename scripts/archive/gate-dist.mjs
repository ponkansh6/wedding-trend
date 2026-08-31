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
  const { eq } = await import("drizzle-orm");

  console.log("=== PRODUCTION GATE-PASS DISTRIBUTION ===");

  const rows = await db
    .select({
      postId: posts.id,
      sourceName: posts.sourceName,
      sourceType: posts.sourceType,
      criteriaJson: postUsefulnessCriteria.criteriaJson,
    })
    .from(posts)
    .innerJoin(postUsefulnessCriteria, eq(posts.id, postUsefulnessCriteria.postId));

  console.log(`Total posts with usefulness criteria: ${rows.length}`);

  let overallGatePass = 0;
  let overallCeremonyDecision = 0;
  let overallPreDecisionOrPhoto = 0;

  const bySource = new Map();

  for (const row of rows) {
    const sourceKey = `${row.sourceType}:${row.sourceName}`;
    if (!bySource.has(sourceKey)) {
      bySource.set(sourceKey, {
        total: 0,
        ceremonyDecision: 0,
        preDecisionOrPhoto: 0,
        gatePass: 0,
      });
    }
    const stats = bySource.get(sourceKey);
    stats.total++;

    let criteria;
    try {
      criteria = JSON.parse(row.criteriaJson);
    } catch {
      continue;
    }

    const cd = Boolean(criteria.ceremonyDecision);
    const pd = Boolean(criteria.preDecisionOrPhotoShoot);
    const pass = cd && !pd;

    if (cd) {
      overallCeremonyDecision++;
      stats.ceremonyDecision++;
    }
    if (pd) {
      overallPreDecisionOrPhoto++;
      stats.preDecisionOrPhoto++;
    }
    if (pass) {
      overallGatePass++;
      stats.gatePass++;
    }
  }

  console.log(`\nOverall Stats:`);
  console.log(
    `- ceremonyDecision = true: ${overallCeremonyDecision} (${rows.length > 0 ? ((overallCeremonyDecision / rows.length) * 100).toFixed(1) : 0}%)`,
  );
  console.log(
    `- preDecisionOrPhotoShoot = true: ${overallPreDecisionOrPhoto} (${rows.length > 0 ? ((overallPreDecisionOrPhoto / rows.length) * 100).toFixed(1) : 0}%)`,
  );
  console.log(
    `- Gate Pass (ceremonyDecision && !preDecisionOrPhotoShoot): ${overallGatePass} (${rows.length > 0 ? ((overallGatePass / rows.length) * 100).toFixed(1) : 0}%)`,
  );

  console.log(`\nBreakdown by Source:`);
  for (const [sourceKey, stats] of bySource.entries()) {
    const passRate = stats.total > 0 ? ((stats.gatePass / stats.total) * 100).toFixed(1) : "0.0";
    console.log(
      `- ${sourceKey}: total=${stats.total}, gatePass=${stats.gatePass} (${passRate}%), ceremonyDecision=${stats.ceremonyDecision}, preDecision=${stats.preDecisionOrPhoto}`,
    );
  }
}

main().catch((err) => {
  console.error("Error in gate-dist:", err);
  process.exit(1);
});
