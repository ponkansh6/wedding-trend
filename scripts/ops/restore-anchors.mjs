#!/usr/bin/env tsx
/**
 * scripts/ops/snapshot-anchors.mjs が取ったスナップショットから、DB を
 * その時点の値に復元する。
 *
 * 復元対象はスナップショットが持つフィールドに限る（posts の一部カラムと
 * post_rationales / post_usefulness_criteria の全カラム）。方針の詳細は
 * ファイル末尾のコメントを参照。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm restore:anchors snapshots/anchors-XXXX.json          # dry-run（差分表示のみ）
 *   pnpm restore:anchors snapshots/anchors-XXXX.json --apply  # 実際に書き戻す
 */
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const snapshotPath = args.find((a) => !a.startsWith("--"));

if (!snapshotPath) {
  console.error("使い方: pnpm restore:anchors <snapshotファイル> [--apply]");
  process.exit(1);
}
if (!existsSync(snapshotPath)) {
  console.error(`スナップショットファイルが見つかりません: ${snapshotPath}`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
if (!snapshot?.meta || !Array.isArray(snapshot.posts) || !Array.isArray(snapshot.postRationales)) {
  console.error("スナップショットの形式が不正です（meta / posts / postRationales が必要）。");
  process.exit(1);
}

// .env.local の簡易パーサ（scripts/ops/backfill-usefulness.mjs と同じ作法）。
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
console.log(
  `スナップショット取得日時: ${snapshot.meta.takenAt} / git HEAD: ${snapshot.meta.gitHead ?? "不明"}`,
);
console.log(
  `スナップショット件数: posts ${snapshot.meta.counts?.posts ?? snapshot.posts.length} 件 / ` +
    `post_rationales ${snapshot.meta.counts?.postRationales ?? snapshot.postRationales.length} 件 / ` +
    `post_usefulness_criteria ${
      snapshot.meta.counts?.postUsefulnessCriteria ?? snapshot.postUsefulnessCriteria?.length ?? 0
    } 件`,
);

const { db } = await import("../../src/lib/db/index.ts");
const { posts, postRationales, postUsefulnessCriteria } =
  await import("../../src/lib/db/schema.ts");
const { eq } = await import("drizzle-orm");

const currentPosts = await db
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
const currentRationales = await db
  .select({
    postId: postRationales.postId,
    topicAnchor: postRationales.topicAnchor,
    rationaleText: postRationales.rationaleText,
    modelId: postRationales.modelId,
    promptVersion: postRationales.promptVersion,
  })
  .from(postRationales);
const currentUsefulness = await db
  .select({
    postId: postUsefulnessCriteria.postId,
    criteriaJson: postUsefulnessCriteria.criteriaJson,
    signature: postUsefulnessCriteria.signature,
    modelId: postUsefulnessCriteria.modelId,
  })
  .from(postUsefulnessCriteria);

// 整合性チェック: レコード数が大きく食い違う場合は別 DB・別時点の可能性が高いため中断する。
// 「大きく食い違う」の基準: 20% 超の増減、または一方が 0 で他方が非 0。
function countsDiffer(before, after) {
  if (before === 0 && after === 0) return false;
  if (before === 0 || after === 0) return before !== after;
  const ratio = Math.abs(after - before) / before;
  return ratio > 0.2;
}

const postsDiffer = countsDiffer(snapshot.posts.length, currentPosts.length);
const rationalesDiffer = countsDiffer(snapshot.postRationales.length, currentRationales.length);
if (postsDiffer || rationalesDiffer) {
  console.error("");
  console.error("警告: スナップショットと現在の DB でレコード数が大きく食い違っています。");
  console.error(
    `  posts: スナップショット ${snapshot.posts.length} 件 → 現在 ${currentPosts.length} 件`,
  );
  console.error(
    `  post_rationales: スナップショット ${snapshot.postRationales.length} 件 → 現在 ${currentRationales.length} 件`,
  );
  console.error(
    "別の DB / 別時点のスナップショットを復元しようとしている可能性があります。中断します。",
  );
  process.exit(1);
}

const currentPostsByUrl = new Map(currentPosts.map((p) => [p.url, p]));
const currentRationalesById = new Map(currentRationales.map((r) => [r.postId, r]));
const currentUsefulnessById = new Map(currentUsefulness.map((u) => [u.postId, u]));

const POST_FIELDS = [
  "status",
  "aiTitle",
  "aiSummary",
  "category",
  "tag",
  "contentHash",
  "curationSignature",
];
const RATIONALE_FIELDS = ["topicAnchor", "rationaleText", "modelId", "promptVersion"];
const USEFULNESS_FIELDS = ["criteriaJson", "signature", "modelId"];

function diffFields(fields, before, after) {
  const changed = {};
  for (const f of fields) {
    if (before[f] !== after[f]) changed[f] = { from: after[f], to: before[f] };
  }
  return changed;
}

// posts の復元計画（url をキーに突き合わせる。id は autoincrement で環境間不変ではないため）。
const postPlans = [];
for (const snap of snapshot.posts) {
  const current = currentPostsByUrl.get(snap.url);
  if (!current) {
    postPlans.push({ kind: "missing_now", url: snap.url });
    continue;
  }
  const changed = diffFields(POST_FIELDS, snap, current);
  if (Object.keys(changed).length > 0) {
    postPlans.push({ kind: "update", url: snap.url, changed });
  }
}

// post_rationales の復元計画。方針は本ファイル末尾のコメントを参照:
// - スナップショット時点に存在し現在も存在する行 → 差分があれば値を戻す。
// - スナップショット時点に存在し現在は存在しない行 → INSERT で復元する
//   （backfill が gate degrade で行ごと削除している可能性があるため）。
// - スナップショット時点に存在せず現在存在する行 → 削除しない（放置）。
//   理由は末尾コメント参照。
const rationalePlans = [];
const snapRationaleIds = new Set(snapshot.postRationales.map((r) => r.postId));
for (const snap of snapshot.postRationales) {
  const current = currentRationalesById.get(snap.postId);
  if (!current) {
    rationalePlans.push({ kind: "insert", postId: snap.postId, values: snap });
    continue;
  }
  const changed = diffFields(RATIONALE_FIELDS, snap, current);
  if (Object.keys(changed).length > 0) {
    rationalePlans.push({ kind: "update", postId: snap.postId, changed });
  }
}
const extraRationaleIds = currentRationales
  .map((r) => r.postId)
  .filter((id) => !snapRationaleIds.has(id));

const usefulnessPlans = [];
const snapUsefulness = snapshot.postUsefulnessCriteria ?? [];
const snapUsefulnessIds = new Set(snapUsefulness.map((u) => u.postId));
for (const snap of snapUsefulness) {
  const current = currentUsefulnessById.get(snap.postId);
  if (!current) {
    usefulnessPlans.push({ kind: "insert", postId: snap.postId, values: snap });
    continue;
  }
  const changed = diffFields(USEFULNESS_FIELDS, snap, current);
  if (Object.keys(changed).length > 0) {
    usefulnessPlans.push({ kind: "update", postId: snap.postId, changed });
  }
}
const extraUsefulnessIds = currentUsefulness
  .map((u) => u.postId)
  .filter((id) => !snapUsefulnessIds.has(id));

console.log("");
console.log("── 復元計画 ──");
console.log(
  `posts: 更新対象 ${postPlans.filter((p) => p.kind === "update").length} 件 / ` +
    `スナップショットにあり現在は存在しない ${postPlans.filter((p) => p.kind === "missing_now").length} 件（スキップ）`,
);
console.log(
  `post_rationales: 更新 ${rationalePlans.filter((p) => p.kind === "update").length} 件 / ` +
    `再挿入(INSERT) ${rationalePlans.filter((p) => p.kind === "insert").length} 件 / ` +
    `現在のみに存在し放置する ${extraRationaleIds.length} 件`,
);
console.log(
  `post_usefulness_criteria: 更新 ${usefulnessPlans.filter((p) => p.kind === "update").length} 件 / ` +
    `再挿入(INSERT) ${usefulnessPlans.filter((p) => p.kind === "insert").length} 件 / ` +
    `現在のみに存在し放置する ${extraUsefulnessIds.length} 件`,
);

if (postPlans.some((p) => p.kind === "missing_now")) {
  console.log("");
  console.log(
    "  注意: スナップショット時点に存在した post が現在の DB に見当たりません（url 変更 or 削除の可能性）。",
  );
}

if (!APPLY) {
  console.log("");
  console.log("dry-run です。実際に書き戻すには --apply を付けて再実行してください。");
  process.exit(0);
}

const totalChanges =
  postPlans.filter((p) => p.kind === "update").length +
  rationalePlans.length +
  usefulnessPlans.length;
if (totalChanges === 0) {
  console.log("");
  console.log("差分なし。復元不要です。終了します。");
  process.exit(0);
}

console.log("");
console.log("復元を実行します...");

for (const plan of postPlans) {
  if (plan.kind !== "update") continue;
  const set = {};
  for (const [field, { to }] of Object.entries(plan.changed)) set[field] = to;
  await db.update(posts).set(set).where(eq(posts.url, plan.url));
}

for (const plan of rationalePlans) {
  if (plan.kind === "insert") {
    await db.insert(postRationales).values({
      postId: plan.values.postId,
      topicAnchor: plan.values.topicAnchor,
      rationaleText: plan.values.rationaleText,
      evidenceSufficient: true,
      modelId: plan.values.modelId,
      promptVersion: plan.values.promptVersion,
      createdAt: new Date().toISOString(),
    });
  } else {
    const set = {};
    for (const [field, { to }] of Object.entries(plan.changed)) set[field] = to;
    await db.update(postRationales).set(set).where(eq(postRationales.postId, plan.postId));
  }
}

for (const plan of usefulnessPlans) {
  if (plan.kind === "insert") {
    await db.insert(postUsefulnessCriteria).values({
      postId: plan.values.postId,
      criteriaJson: plan.values.criteriaJson,
      signature: plan.values.signature,
      modelId: plan.values.modelId,
      scoredAt: new Date().toISOString(),
    });
  } else {
    const set = {};
    for (const [field, { to }] of Object.entries(plan.changed)) set[field] = to;
    await db
      .update(postUsefulnessCriteria)
      .set(set)
      .where(eq(postUsefulnessCriteria.postId, plan.postId));
  }
}

console.log("復元が完了しました。");

/**
 * post_rationales / post_usefulness_criteria の「行の存在が食い違う場合」の方針:
 *
 * - スナップショット時点に存在し、現在は存在しない行 → INSERT で復元する。
 *   backfill の gate degrade（validateTopicAnchor 失敗時に finalTopicAnchor を
 *   null にし、rationale を渡さない）は「行を作らない」形で表れるため、
 *   スナップショット前に存在した行が復元前に消えているケースが実際に起こりうる。
 *   これを戻さないと「復元」が不完全になるため INSERT する。
 * - スナップショット時点に存在せず、現在は存在する行 → 削除しない（放置）。
 *   これはスナップショット取得後に新規公開された post に対して backfill 等が
 *   新しく rationale / usefulness を書いた結果であり、正当な新規データである
 *   可能性が高い。復元スクリプトの役割は「書き換わった値を戻す」ことに限定し、
 *   スナップショット後に増えた正当なデータを削除する権限は持たせない
 *   （誤って新しいレコードを消す事故を避けるため、削除は常に手動判断とする）。
 */
