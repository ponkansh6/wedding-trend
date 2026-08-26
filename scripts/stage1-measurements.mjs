/**
 * Stage 1 用の本番DB読み取りスクリプト（LLM課金ゼロ・読み取り専用）。
 *
 * 用途: shared_plan/11 Stage 1 の4タスクに必要なデータを一括取得する。
 *   1. 19点17件の目視フェーズラベル
 *   2. 19点クラスタの publishedAt 分布
 *   3. 全false 30件の抜粋長分布
 *   4. heavy 1件 / light 24件の抽出目視
 *
 * 使い方: pnpm exec tsx scripts/stage1-measurements.mjs
 * 認証情報は .env.local から自動読み込み。
 */
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

function computeScore(c) {
  if (!c) return -999;
  const first = c.firsthand ? 3 : 0;
  const cd = c.ceremonyDecision ? 12 : 0;
  const spec = c.specific ? 2 : 0;
  const trade = c.tradeoff ? 2 : 0;
  let promo = 0;
  if (c.promotional === "heavy") promo = -4;
  else if (c.promotional === "light") promo = -1;
  const pre = c.preDecisionOrPhotoShoot ? -3 : 0;
  const gate = c.ceremonyDecision && !c.preDecisionOrPhotoShoot;
  return (gate ? cd : 0) + first + spec + trade + promo + pre;
}

async function main() {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const result = await client.execute(`
    SELECT
      p.id,
      p.url,
      p.source_name AS sourceName,
      p.original_title AS originalTitle,
      p.ai_title AS aiTitle,
      p.original_excerpt AS originalExcerpt,
      p.published_at AS publishedAt,
      c.criteria_json AS criteriaJson,
      c.scored_at AS scoredAt,
      c.signature AS signature
    FROM posts p
    INNER JOIN post_usefulness_criteria c ON p.id = c.post_id
    WHERE p.status = 'published'
  `);

  const rows = result.rows;
  console.log(`全 published 投稿数 (criteria あり): ${rows.length}\n`);

  const enriched = rows.map((r) => {
    let criteria = null;
    try {
      criteria = JSON.parse(String(r.criteriaJson));
    } catch {
      /* ignore */
    }
    const excerptLen = r.originalExcerpt ? String(r.originalExcerpt).length : 0;
    return { ...r, criteria, excerptLen, score: computeScore(criteria) };
  });

  // ── Task 1 & 2: 19点17件 ─────────────────────────────────────
  const score19 = enriched.filter((r) => r.score === 19);
  console.log("=== Task 1 & 2: 19点記事一覧 (目視フェーズラベル + publishedAt 分布) ===");
  console.log(`件数: ${score19.length}\n`);
  for (const r of score19) {
    console.log(`id=${r.id} | published=${r.publishedAt} | source=${r.sourceName}`);
    console.log(`  title: ${r.aiTitle ?? r.title ?? "(no title)"}`);
    console.log(`  url: ${r.url}`);
    console.log(`  excerpt_len: ${r.excerptLen}`);
    console.log(`  criteria: ${r.criteriaJson}`);
    console.log();
  }

  // ── Task 3: 全false群 vs 判定成立群の抜粋長 ──────────────────
  const allFalse = enriched.filter((r) => {
    const c = r.criteria;
    return (
      c &&
      !c.firsthand &&
      !c.ceremonyDecision &&
      !c.specific &&
      !c.tradeoff &&
      c.preDecisionOrPhotoShoot === false &&
      (c.promotional === "none" || c.promotional == null)
    );
  });
  const hasTrue = enriched.filter((r) => {
    const c = r.criteria;
    return c && (c.firsthand || c.ceremonyDecision || c.specific || c.tradeoff);
  });

  console.log("\n=== Task 3: 全false群 vs 判定成立群の抜粋長分布 ===");

  function stats(lengths, label) {
    if (!lengths.length) {
      console.log(`  ${label}: 0件`);
      return;
    }
    lengths.sort((a, b) => a - b);
    const sum = lengths.reduce((a, b) => a + b, 0);
    console.log(`  ${label}: ${lengths.length}件`);
    console.log(
      `    min=${lengths[0]} max=${lengths[lengths.length - 1]} median=${lengths[Math.floor(lengths.length / 2)]} avg=${(sum / lengths.length).toFixed(0)}`,
    );
  }
  stats(
    allFalse.map((r) => r.excerptLen).filter((n) => n > 0),
    "全false群",
  );
  stats(
    hasTrue.map((r) => r.excerptLen).filter((n) => n > 0),
    "判定成立群(>=1 true)",
  );

  // ── Task 4: promotional 分布 ──────────────────────────────────
  const heavy = enriched.filter((r) => r.criteria?.promotional === "heavy");
  const light = enriched.filter((r) => r.criteria?.promotional === "light");

  console.log("\n=== Task 4: promotional 分布 ===");
  console.log(`heavy: ${heavy.length}件`);
  for (const r of heavy) {
    console.log(`  id=${r.id} | source=${r.sourceName} | url=${r.url}`);
    console.log(`  title: ${r.aiTitle ?? r.title ?? "(no title)"}`);
    console.log(`  excerpt (先頭300字): ${(r.originalExcerpt ?? "").slice(0, 300)}`);
    console.log(`  criteria: ${r.criteriaJson}`);
    console.log();
  }
  console.log(`light: ${light.length}件 (上位10件を表示)`);
  for (const r of light.slice(0, 10)) {
    console.log(
      `  id=${r.id} | source=${r.sourceName} | title: ${r.aiTitle ?? r.title ?? "(no title)"}`,
    );
  }

  // ── スコア分布サマリ ──────────────────────────────────────────
  console.log("\n=== スコア分布サマリ ===");
  const dist = {};
  for (const r of enriched) {
    dist[r.score] = (dist[r.score] || 0) + 1;
  }
  for (const [s, n] of Object.entries(dist).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    console.log(`  ${s}点: ${n}件`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
