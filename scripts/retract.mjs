#!/usr/bin/env tsx
/**
 * 1コマンド撤回ツール（plan 07 §5-M5）。
 *
 * 無人運転下で緊急の削除要請（著作権者からの申し立て等）が来た際、DB を
 * 手作業で触らずに特定 URL / ホストの公開記事を撤回するための CLI。
 * 内部では `src/lib/db/repository.ts` の `markRetracted()` をそのまま呼ぶ
 * （撤回のロジック・sticky 性は複製しない）。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm retract --url https://example.com/a --reason source_gone
 *   pnpm retract --host example.com --reason tos_changed
 *   pnpm retract --url https://example.com/a --reason source_gone --yes   # 実際に撤回する
 *
 * 何も指定しなければ dry-run（対象の一覧表示のみ、DB は変更しない）。
 * 実際に撤回するには `--yes`（または `--execute`）を明示する。
 *
 * 理由コード（`RetractionReason`、src/lib/types.ts）のうち `takedown_request`
 * は「削除要請の受領」を表す専用コードであり、本ツールの主用途である。他の
 * 4 値（source_gone / robots_disallowed / tos_changed / body_changed）は
 * すべて自動検知パイプライン側の客観的トリガ用で、本来は人間がこの CLI から
 * 明示的に選ぶものではないが、緊急時に自動検知を待たず手動で先回りして撤回
 * する運用のため受け付ける。`--reason` は必須（既定値なし）。主用途が
 * `takedown_request` であっても、誤って客観的トリガのコードを付けたまま実行
 * してしまう事故（監査ログ上「削除要請」と「自動トリガ」が混同される事故）を
 * 防ぐため、あえて既定値を設けず毎回明示させる。
 */
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
function getFlag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}
const URL_ARG = getFlag("url");
const HOST_ARG = getFlag("host");
const REASON_ARG = getFlag("reason");
const EXECUTE = args.includes("--yes") || args.includes("--execute");

const VALID_REASONS = [
  "source_gone",
  "robots_disallowed",
  "tos_changed",
  "body_changed",
  "takedown_request",
];

function usageAndExit(message) {
  if (message) console.error(`エラー: ${message}\n`);
  console.error(
    [
      "使い方:",
      "  pnpm retract --url <URL> --reason <理由コード> [--yes]",
      "  pnpm retract --host <ホスト名> --reason <理由コード> [--yes]",
      "",
      `理由コード: ${VALID_REASONS.join(" / ")}`,
      "  ※ takedown_request は削除要請の受領（人間判断）を表す、本ツールの主用途。",
      "    他は自動検知パイプライン側の客観的トリガ用のコード。",
      "",
      "--yes（または --execute）を付けない場合は dry-run（実行計画の表示のみ）。",
    ].join("\n"),
  );
  process.exit(1);
}

if (!URL_ARG && !HOST_ARG) usageAndExit("--url か --host のどちらかを指定してください");
if (URL_ARG && HOST_ARG) usageAndExit("--url と --host は同時に指定できません");
if (!REASON_ARG) usageAndExit("--reason を指定してください");
if (!VALID_REASONS.includes(REASON_ARG)) {
  usageAndExit(`--reason は次のいずれかである必要があります: ${VALID_REASONS.join(" / ")}`);
}

// .env.local の簡易パーサ（scripts/apply-migrations-remote.mjs と同じ作法）。
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const dbUrl = process.env.TURSO_DATABASE_URL ?? "";
if (!dbUrl) {
  console.error("TURSO_DATABASE_URL が未設定です（.env.local を確認してください）");
  process.exit(1);
}

// 接続先を必ず表示する（本番に対する無自覚な破壊的操作を避けるため）。
// 秘密情報（認証トークン等）を出力しないよう、スキームとホスト部のみ表示する。
let displayTarget = dbUrl;
try {
  const parsed = new URL(dbUrl.replace(/^libsql:/, "https:"));
  displayTarget = `${dbUrl.split(":")[0]}://${parsed.host}`;
} catch {
  displayTarget = dbUrl.split(":")[0];
}
const looksProduction = dbUrl.includes("turso.io") || dbUrl.startsWith("libsql:");
console.log(
  `接続先: ${displayTarget}${looksProduction ? "  ⚠️  本番相当（Turso）の可能性があります" : ""}`,
);

// env を設定した後に import する（src/lib/db/index.ts はモジュール読み込み時に
// process.env を読んで接続を作るため。scripts/backfill-usefulness.mjs と同じ作法）。
const { findPostByUrlForRetraction, listPublishedByHostForRetraction, markRetracted, isRemoved } =
  await import("../src/lib/db/repository.ts");

let candidates = [];
if (URL_ARG) {
  const found = await findPostByUrlForRetraction(URL_ARG);
  if (!found) {
    console.error(`対象 URL が見つかりません: ${URL_ARG}`);
    process.exit(1);
  }
  candidates = [found];
} else {
  candidates = await listPublishedByHostForRetraction(HOST_ARG);
  if (candidates.length === 0) {
    console.log(`ホスト "${HOST_ARG}" に公開中の post はありません。対象なし。終了します。`);
    process.exit(0);
  }
}

console.log(`\n実行計画（理由: ${REASON_ARG}、${candidates.length} 件）:`);
for (const c of candidates) {
  console.log(`  [id=${c.id}] status=${c.status} host=${c.host} url=${c.url}`);
  console.log(`    title: ${c.originalTitle}`);
}

const alreadyRemoved = [];
for (const c of candidates) {
  if (await isRemoved(c.id)) alreadyRemoved.push(c.id);
}
if (alreadyRemoved.length > 0) {
  console.log(
    `\n注記: このうち ${alreadyRemoved.length} 件（id: ${alreadyRemoved.join(", ")}）は既に除去済みです。` +
      "撤回は sticky なため、再実行しても最初に記録された理由が保持されます（理由の上書きは行われません）。",
  );
}

if (!EXECUTE) {
  console.log("\ndry-run です。実際に撤回するには --yes を付けて再実行してください。");
  process.exit(0);
}

const at = new Date().toISOString();
let done = 0;
for (const c of candidates) {
  await markRetracted(c.id, REASON_ARG, at);
  done += 1;
  console.log(`  ✅ [id=${c.id}] 撤回処理を実行しました（${at}）`);
}

console.log(`\n完了: ${done} 件に markRetracted(reason="${REASON_ARG}") を実行しました。`);
