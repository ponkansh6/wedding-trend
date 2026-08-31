/**
 * Plan 17 S2: ゴールデンセット抽出スクリプト
 *
 * 本番 Turso DB から「決定的フィールドのみ」のゴールデンセットを抽出し、
 * tests/golden-set/pipeline/ 以下に JSONL として出力する。
 * 本番 DB に対しては READ（参照）のみを行い、INSERT/UPDATE/DELETE は一切行わない。
 *
 * 使い方:
 *   pnpm exec tsx scripts/ops/extract-golden-set.mjs [--dry-run] [--limit N] [--since ISO]
 */
import { createClient } from "@libsql/client";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// 1. .env.local の読み込み
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL が見つかりません");
  process.exit(1);
}

// 2. 引数解析
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
let limit = 150;
let sinceISO = null;

const limitIdx = args.indexOf("--limit");
if (limitIdx !== -1 && args[limitIdx + 1]) {
  const parsed = parseInt(args[limitIdx + 1], 10);
  if (!isNaN(parsed) && parsed > 0) {
    limit = parsed;
  }
}

const sinceIdx = args.indexOf("--since");
if (sinceIdx !== -1 && args[sinceIdx + 1]) {
  sinceISO = args[sinceIdx + 1];
}

const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

function hashUrl(targetUrl) {
  const normalized = String(targetUrl).trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

async function main() {
  console.log(`接続先スキーム: ${url.split(":")[0]}`);
  console.log(`抽出条件: limit=${limit}${sinceISO ? `, since=${sinceISO}` : ""}, dryRun=${dryRun}`);

  const allTables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tableNames = new Set(allTables.rows.map((r) => String(r.name)));
  console.log("DB 内テーブル一覧:", Array.from(tableNames).join(", "));

  // posts の取得クエリ作成（実スキーマに基づき curated_title, curated_summary, decision を除外）
  let postsQuery = `
    SELECT 
      p.id, p.url, p.source_type, p.source_id, p.source_name,
      p.original_title, p.original_excerpt,
      p.category,
      p.tag,
      ${tableNames.has("post_rationales") ? "pr.topic_anchor" : "NULL as topic_anchor"},
      p.status, p.published_at, p.content_hash,
      ${tableNames.has("post_publication_kind") ? "pk.hash_kind" : "NULL as hash_kind"},
      p.curation_signature
    FROM posts p
  `;

  if (tableNames.has("post_rationales")) {
    postsQuery += ` LEFT JOIN post_rationales pr ON p.id = pr.post_id`;
  }
  if (tableNames.has("post_publication_kind")) {
    postsQuery += ` LEFT JOIN post_publication_kind pk ON p.id = pk.post_id`;
  }

  let whereClauses = [];
  let params = [];
  if (sinceISO) {
    whereClauses.push(`p.published_at >= ?`);
    params.push(sinceISO);
  }

  if (whereClauses.length > 0) {
    postsQuery += ` WHERE ` + whereClauses.join(" AND ");
  }

  postsQuery += ` ORDER BY p.published_at DESC LIMIT ?`;
  params.push(limit);

  const postsResult = await client.execute({ sql: postsQuery, args: params });
  const rows = postsResult.rows;

  if (rows.length === 0) {
    console.error("エラー: 対象 posts が 0 件です。");
    process.exit(1);
  }

  console.log(`取得した posts 件数: ${rows.length}`);

  const postIds = rows.map((r) => Number(r.id));
  const urlHashes = rows.map((r) => hashUrl(r.url));

  // 関連テーブルの取得
  // 1. post_publications
  let pubRows = [];
  if (tableNames.has("post_publications") && postIds.length > 0) {
    const placeholders = postIds.map(() => "?").join(",");
    const pubRes = await client.execute({
      sql: `SELECT post_id, published_at, body_hash, text_length, link_density, paragraph_count FROM post_publications WHERE post_id IN (${placeholders})`,
      args: postIds,
    });
    pubRows = pubRes.rows;
  }

  // 2. host_gate_state
  let hostRows = [];
  if (tableNames.has("host_gate_state")) {
    const hostRes = await client.execute(
      `SELECT host, gate_id, state_kind, until_at, k4_strikes, last_429_at, count_day, count_value, updated_at FROM host_gate_state`,
    );
    hostRows = hostRes.rows;
  }

  // 3. evidence_signal_observations (url_hash で絞り込み)
  let evidenceRows = [];
  if (tableNames.has("evidence_signal_observations") && urlHashes.length > 0) {
    const placeholders = urlHashes.map(() => "?").join(",");
    const evRes = await client.execute({
      sql: `SELECT id, url_hash, host, text_length, link_density, paragraph_count, passed_gate, failed_conditions, observed_at FROM evidence_signal_observations WHERE url_hash IN (${placeholders})`,
      args: urlHashes,
    });
    evidenceRows = evRes.rows;
  }

  // 4. post_retry_queue (url_hash で絞り込み)
  let retryRows = [];
  if (tableNames.has("post_retry_queue") && urlHashes.length > 0) {
    const placeholders = urlHashes.map(() => "?").join(",");
    const retryRes = await client.execute({
      sql: `SELECT url_hash, url, host, lane, reason, attempts, first_queued_at, next_attempt_at, expires_at FROM post_retry_queue WHERE url_hash IN (${placeholders})`,
      args: urlHashes,
    });
    retryRows = retryRes.rows;
  }

  // 5. post_removals (post_id で絞り込み)
  let removalRows = [];
  if (tableNames.has("post_removals") && postIds.length > 0) {
    const placeholders = postIds.map(() => "?").join(",");
    const remRes = await client.execute({
      sql: `SELECT post_id, kind, reason, removed_at FROM post_removals WHERE post_id IN (${placeholders})`,
      args: postIds,
    });
    removalRows = remRes.rows;
  }

  if (dryRun) {
    console.log("\n--- DRY RUN サマリ ---");
    console.log(`posts.jsonl: ${rows.length} 行`);
    console.log(`post_publications.jsonl: ${pubRows.length} 行`);
    console.log(`host_gate_state.jsonl: ${hostRows.length} 行`);
    console.log(`evidence.jsonl: ${evidenceRows.length} 行`);
    console.log(`retry.jsonl: ${retryRows.length} 行`);
    console.log(`post_removals.jsonl: ${removalRows.length} 行`);
    await client.close();
    return;
  }

  // 出力ディレクトリ作成
  const outDir = join("tests", "golden-set", "pipeline");
  mkdirSync(outDir, { recursive: true });

  function extractHost(urlStr) {
    try {
      return new URL(String(urlStr)).hostname;
    } catch {
      return "";
    }
  }

  // 1. posts.jsonl
  const postsJsonlPath = join(outDir, "posts.jsonl");
  const postsLines = [
    `# fields: id, url, host, sourceType, sourceId, sourceName, originalTitle, originalExcerpt, category, tag, topicAnchor, status, publishedAt, contentHash, hashKind, curationSignature`,
  ];
  for (const r of rows) {
    const excerpt = r.original_excerpt != null ? String(r.original_excerpt) : "";
    const trimmedExcerpt = excerpt.length > 500 ? excerpt.slice(0, 500) + "…" : excerpt;

    const tagVal = r.tag != null ? String(r.tag) : null;

    const obj = {
      id: Number(r.id),
      url: String(r.url),
      host: extractHost(r.url),
      sourceType: String(r.source_type),
      sourceId: String(r.source_id),
      sourceName: String(r.source_name),
      originalTitle: String(r.original_title),
      originalExcerpt: trimmedExcerpt,
      category: r.category != null ? String(r.category) : null,
      tag: tagVal,
      topicAnchor: r.topic_anchor != null ? String(r.topic_anchor) : null,
      status: String(r.status),
      publishedAt: r.published_at != null ? String(r.published_at) : null,
      contentHash: r.content_hash != null ? String(r.content_hash) : null,
      hashKind: r.hash_kind != null ? String(r.hash_kind) : null,
      curationSignature: r.curation_signature != null ? String(r.curation_signature) : null,
    };
    postsLines.push(JSON.stringify(obj));
  }
  writeFileSync(postsJsonlPath, postsLines.join("\n") + "\n", "utf-8");

  // 2. post_publications.jsonl
  const pubJsonlPath = join(outDir, "post_publications.jsonl");
  const pubLines = [
    `# fields: postId, publishedAt, bodyHash, textLength, linkDensity, paragraphCount`,
  ];
  for (const r of pubRows) {
    const obj = {
      postId: Number(r.post_id),
      publishedAt: String(r.published_at),
      bodyHash: String(r.body_hash),
      textLength: r.text_length != null ? Number(r.text_length) : null,
      linkDensity: r.link_density != null ? Number(r.link_density) : null,
      paragraphCount: r.paragraph_count != null ? Number(r.paragraph_count) : null,
    };
    pubLines.push(JSON.stringify(obj));
  }
  writeFileSync(pubJsonlPath, pubLines.join("\n") + "\n", "utf-8");

  // 3. host_gate_state.jsonl
  const hostJsonlPath = join(outDir, "host_gate_state.jsonl");
  const hostLines = [
    `# fields: host, gateId, stateKind, untilAt, k4Strikes, last429At, countDay, countValue, updatedAt`,
  ];
  for (const r of hostRows) {
    const obj = {
      host: String(r.host),
      gateId: r.gate_id != null ? String(r.gate_id) : null,
      stateKind: r.state_kind != null ? String(r.state_kind) : null,
      untilAt: r.until_at != null ? String(r.until_at) : null,
      k4Strikes: r.k4_strikes != null ? Number(r.k4_strikes) : 0,
      last429At: r.last_429_at != null ? String(r.last_429_at) : null,
      countDay: r.count_day != null ? String(r.count_day) : "",
      countValue: r.count_value != null ? Number(r.count_value) : 0,
      updatedAt: r.updated_at != null ? String(r.updated_at) : null,
    };
    hostLines.push(JSON.stringify(obj));
  }
  writeFileSync(hostJsonlPath, hostLines.join("\n") + "\n", "utf-8");

  // 4. evidence.jsonl
  const evidenceJsonlPath = join(outDir, "evidence.jsonl");
  const evidenceLines = [
    `# fields: id, urlHash, host, textLength, linkDensity, paragraphCount, passedGate, failedConditions, observedAt`,
  ];
  for (const r of evidenceRows) {
    const obj = {
      id: Number(r.id),
      urlHash: String(r.url_hash),
      host: String(r.host),
      textLength: Number(r.text_length),
      linkDensity: Number(r.link_density),
      paragraphCount: Number(r.paragraph_count),
      passedGate: Boolean(r.passed_gate),
      failedConditions: r.failed_conditions != null ? String(r.failed_conditions) : null,
      observedAt: String(r.observed_at),
    };
    evidenceLines.push(JSON.stringify(obj));
  }
  writeFileSync(evidenceJsonlPath, evidenceLines.join("\n") + "\n", "utf-8");

  // 5. retry.jsonl
  const retryJsonlPath = join(outDir, "retry.jsonl");
  const retryLines = [
    `# fields: urlHash, url, host, lane, reason, attempts, firstQueuedAt, nextAttemptAt, expiresAt`,
  ];
  for (const r of retryRows) {
    const obj = {
      urlHash: String(r.url_hash),
      url: String(r.url),
      host: String(r.host),
      lane: String(r.lane),
      reason: String(r.reason),
      attempts: Number(r.attempts),
      firstQueuedAt: String(r.first_queued_at),
      nextAttemptAt: String(r.next_attempt_at),
      expiresAt: String(r.expires_at),
    };
    retryLines.push(JSON.stringify(obj));
  }
  writeFileSync(retryJsonlPath, retryLines.join("\n") + "\n", "utf-8");

  // 6. post_removals.jsonl
  const removalJsonlPath = join(outDir, "post_removals.jsonl");
  const removalLines = [`# fields: postId, kind, reason, removedAt`];
  for (const r of removalRows) {
    const obj = {
      postId: Number(r.post_id),
      kind: String(r.kind),
      reason: String(r.reason),
      removedAt: String(r.removed_at),
    };
    removalLines.push(JSON.stringify(obj));
  }
  writeFileSync(removalJsonlPath, removalLines.join("\n") + "\n", "utf-8");

  console.log(`\n✅ ゴールデンセットの抽出が完了しました: ${outDir}/`);
  console.log(`  - posts.jsonl (${rows.length} 件)`);
  console.log(`  - post_publications.jsonl (${pubRows.length} 件)`);
  console.log(`  - host_gate_state.jsonl (${hostRows.length} 件)`);
  console.log(`  - evidence.jsonl (${evidenceRows.length} 件)`);
  console.log(`  - retry.jsonl (${retryRows.length} 件)`);
  console.log(`  - post_removals.jsonl (${removalRows.length} 件)`);

  await client.close();
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
