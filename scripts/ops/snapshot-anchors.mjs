#!/usr/bin/env tsx
/**
 * topicAnchor 再生成（backfill-usefulness.mjs 等）の前に取る復元用スナップショット。
 *
 * shared_plan/16-anchor-clause-form-and-non-redundancy.md Stage 4「可逆性の確保」用。
 * 「次の backfill が可逆でないなら実行してはならない」という教訓に基づき、
 * 再生成によって書き換わりうるフィールドを全件 SELECT で JSON ダンプする。
 *
 * 書き込みは一切行わない（SELECT のみ）。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm snapshot:anchors
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// .env.local の簡易パーサ（scripts/backfill-usefulness.mjs と同じ作法）。
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

for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"]) {
  if (!process.env[key]) {
    console.error(`${key} が未設定です（.env.local を確認してください）`);
    process.exit(1);
  }
}

console.log(`接続先スキーム: ${process.env.TURSO_DATABASE_URL.split(":")[0]}`);

// env を設定した後に import する（src/lib/db/index.ts はモジュール読み込み時に
// process.env を読んで接続を作るため）。
const { db } = await import("../src/lib/db/index.ts");
const { posts, postRationales, postUsefulnessCriteria } = await import("../src/lib/db/schema.ts");
const { CURATION_PROMPT_VERSION, RATIONALE_PROMPT_VERSION } =
  await import("../src/lib/constants.ts");

let gitHead = null;
try {
  gitHead = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
} catch {
  // git が使えない環境でも失敗させない（メタ情報は best-effort）。
}

// R1: 再生成によって書き換わりうるフィールドのみを SELECT する。
const postRows = await db
  .select({
    id: posts.id,
    url: posts.url,
    status: posts.status,
    aiTitle: posts.aiTitle,
    aiSummary: posts.aiSummary,
    category: posts.category,
    tag: posts.tag,
    contentHash: posts.contentHash,
    curationSignature: posts.curationSignature,
  })
  .from(posts);

const rationaleRows = await db
  .select({
    postId: postRationales.postId,
    topicAnchor: postRationales.topicAnchor,
    rationaleText: postRationales.rationaleText,
    modelId: postRationales.modelId,
    promptVersion: postRationales.promptVersion,
  })
  .from(postRationales);

// post_usefulness_criteria も含める: markCurated() は usefulness が渡されると
// この表の criteriaJson / signature / modelId / scoredAt を上書きする
// （src/lib/db/repository.ts の buildUsefulnessValues 参照）。backfill による
// topicAnchor 再生成は同じ curatePosts() 呼び出しの結果を使って usefulness も
// 同時に書き換えるため、topicAnchor だけでなくこの表も「再生成によって
// 書き換わりうるフィールド」に含まれる。復元の完全性のためダンプする。
const usefulnessRows = await db
  .select({
    postId: postUsefulnessCriteria.postId,
    criteriaJson: postUsefulnessCriteria.criteriaJson,
    signature: postUsefulnessCriteria.signature,
    modelId: postUsefulnessCriteria.modelId,
  })
  .from(postUsefulnessCriteria);

const snapshot = {
  meta: {
    takenAt: new Date().toISOString(),
    curationPromptVersion: CURATION_PROMPT_VERSION,
    rationalePromptVersion: RATIONALE_PROMPT_VERSION,
    gitHead,
    counts: {
      posts: postRows.length,
      postRationales: rationaleRows.length,
      postUsefulnessCriteria: usefulnessRows.length,
    },
  },
  posts: postRows,
  postRationales: rationaleRows,
  postUsefulnessCriteria: usefulnessRows,
};

const outDir = "snapshots";
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = `${outDir}/anchors-${stamp}.json`;
writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

console.log(
  `posts: ${postRows.length} 件 / post_rationales: ${rationaleRows.length} 件 / ` +
    `post_usefulness_criteria: ${usefulnessRows.length} 件`,
);
console.log(`出力先: ${outPath}`);
