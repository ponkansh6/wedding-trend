#!/usr/bin/env tsx
/**
 * discovery_run テーブルの最終実行時刻を監視する（plan 06 §5.5、P7c）。
 *
 * GitHub Actions の schedule トリガーは 60日 inactivity で自動停止する。
 * discovery.yml が動き続けていることを discovery_run の最終実行時刻から
 * 確認し、一定期間以上更新が無ければ失敗させる（weekly-monitor.yml から
 * 呼ばれ、失敗時は既存の GitHub Issue 作成ステップに乗る）。
 *
 * TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が無い環境（secrets 未設定）では
 * スキップして正常終了する（AGENTS.md「外部依存の監視は CI ゲートに入れない」の
 * 趣旨。CI を外部要因で赤くしない）。
 *
 * 使い方:
 *   pnpm exec tsx scripts/check-discovery-freshness.mjs
 */
import { existsSync, readFileSync } from "node:fs";

const STALE_AFTER_DAYS = 10;

// .env.local の簡易パーサ（run-discovery.mjs / backfill-usefulness.mjs と同じ作法）。
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

console.log("==================================================");
console.log("  Wedding Trend - Discovery Freshness Monitor");
console.log("==================================================");

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.log(
    "⏭️  TURSO_DATABASE_URL / TURSO_AUTH_TOKEN が未設定のため、discovery_run 監視をスキップします。",
  );
  process.exit(0);
}

// discovery.yml の schedule が無効化されている間は、鮮度監視そのものを停止する。
// plan 07 Stage 0 の完了までは自動実行しない決定のため、ここで失敗させると
// 「外部要因ではない、意図された停止」で CI が赤くなり、監視への信頼が壊れる。
// schedule を復帰させれば、この判定が自動的に監視を再武装する。
const WORKFLOW_PATH = ".github/workflows/discovery.yml";
if (existsSync(WORKFLOW_PATH)) {
  const workflow = readFileSync(WORKFLOW_PATH, "utf-8");
  const hasActiveSchedule = workflow
    .split("\n")
    .some((line) => /^\s*schedule:\s*$/.test(line) && !line.trimStart().startsWith("#"));
  if (!hasActiveSchedule) {
    console.log(
      `⏭️  ${WORKFLOW_PATH} の schedule が無効化されているため、discovery_run 鮮度監視をスキップします。` +
        " plan 07 Stage 0 完了後に schedule を復帰させると、この監視も自動的に再開します。",
    );
    process.exit(0);
  }
}

const { getLatestDiscoveryRunStartedAt } = await import("../src/lib/db/repository.ts");

const startedAt = await getLatestDiscoveryRunStartedAt();

if (!startedAt) {
  console.error(
    "❌ discovery_run にレコードが見つかりません。discovery.yml が一度も成功実行されていないか、DB 接続に失敗している可能性があります。",
  );
  process.exit(1);
}

const lastRun = new Date(startedAt);
if (Number.isNaN(lastRun.getTime())) {
  console.error(`❌ discovery_run.started_at の値が不正です: ${startedAt}`);
  process.exit(1);
}

const ageDays = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24);
console.log(`最終実行開始時刻: ${startedAt}（${ageDays.toFixed(1)} 日前）`);

if (ageDays > STALE_AFTER_DAYS) {
  console.error(
    `❌ discovery_run の最終実行から ${ageDays.toFixed(1)} 日経過しています（閾値 ${STALE_AFTER_DAYS} 日）。` +
      " GitHub Actions の schedule は 60日 inactivity で自動停止するため、discovery.yml の Actions タブでの実行状況を確認してください。",
  );
  process.exit(1);
}

console.log(`✅ discovery_run は直近 ${STALE_AFTER_DAYS} 日以内に実行されています。`);
process.exit(0);
