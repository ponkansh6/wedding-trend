#!/usr/bin/env tsx
/**
 * 週次発見ランナー（plan 06 §5.1/§5.5、P7b/P7c）。
 *
 * 使い方:
 *   pnpm exec tsx scripts/run-discovery.mjs [--host www.mwed.jp]
 *
 * GitHub Actions の discovery.yml から呼ばれることを想定する。
 * 1) sitemap 差分発見（初回実行は seed のみ・本文は取りに行かない）
 * 2) pending URL / 再試行キューの本文取得キュレーション（時間予算内・規律レイヤー経由）
 * 3) 公開済み投稿の再検証（plan 07 §5-M4: 客観トリガによる自動撤回）
 */
import { existsSync, readFileSync } from "node:fs";

// .env.local の簡易パーサ（submit-evergreen.mjs と同じ）
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

const args = process.argv.slice(2);
let host = "www.mwed.jp";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" && args[i + 1]) {
    host = args[i + 1];
    i++;
  }
}

/** ホストごとの起点 sitemap（§4.2: mwed.jp は stories のみ）。 */
const SITEMAPS_BY_HOST = {
  "www.mwed.jp": ["https://www.mwed.jp/sitemap_stories.xml"],
};

const sitemaps = SITEMAPS_BY_HOST[host];
if (!sitemaps) {
  console.error(`未知のホストです: ${host}（SITEMAPS_BY_HOST に定義がありません）`);
  process.exit(1);
}

const { discoverNewUrls } = await import("../src/lib/sources/sitemap-discovery.ts");
const { ingestDiscoveredUrls, revalidatePublishedPosts } =
  await import("../src/lib/pipeline/discovery-ingest.ts");

console.log(`[1/3] sitemap 差分発見: ${host}`);
const discovery = await discoverNewUrls(host, sitemaps);
console.log(
  `  outcome=${discovery.outcome} sitemaps=${discovery.sitemapsFetched} urlsNew=${discovery.urlsNew}`,
);

console.log(`[2/3] 本文取得キュレーション: ${host}`);
const ingest = await ingestDiscoveredUrls(host);
console.log(JSON.stringify(ingest, null, 2));

// 無人運転では**ログが唯一の観測手段**（plan 07 §「stats の拡張」）なので、
// 何が起きたかを後から再構成できるよう理由コード別の内訳も明示的に出す。
console.log(
  `  processed=${ingest.processed} published=${ingest.published} ` +
    `dropped(extraction_insufficient=${ingest.extractionInsufficientDropped}, ` +
    `title_filter=${ingest.titleFilterDropped}, anchor_ungrounded=${ingest.anchorUngroundedDropped}, ` +
    `retry_exhausted=${ingest.retryExhausted}) ` +
    `rateCapped=${ingest.rateCapped} stickyRemovedBlocked=${ingest.stickyRemovedBlocked} ` +
    `enqueuedRetries=${ingest.enqueuedRetries} staleReaped=${ingest.staleReaped}`,
);

if (ingest.hostNotAllowed) {
  console.error(
    `ホスト ${host} は HOST_ALLOWLIST に含まれていません。src/lib/constants.ts の明示的なコミットでのみ追加できます。`,
  );
  process.exit(1);
}
if (ingest.yieldCollapseDetected) {
  console.error(
    `[Q2] ホスト ${host} の採用率がベースラインから乖離しました。収集を止めて内容を確認してください。`,
  );
}
if (ingest.abortedByKillGate) {
  console.error("kill gate が発火しました。ホスト停止状態を確認してください。");
  process.exit(1);
}
if (ingest.abortedByBudget) {
  console.log(
    "[B1] 日次リクエスト予算を消化したため本日の巡回を終了しました（正常な定常状態・UTC 日次で自動リセット）。",
  );
  process.exit(2);
}
if (ingest.abortedByRetryAfter) {
  console.error("Retry-After 指定により中断しました。次回ランまで待機します。");
  process.exit(0);
}

console.log("[3/3] 公開済み投稿の再検証（M4: 客観トリガによる自動撤回）");
const revalidation = await revalidatePublishedPosts();
console.log(JSON.stringify(revalidation, null, 2));
console.log(
  `  checked=${revalidation.checked} seeded=${revalidation.seeded} ok=${revalidation.ok} ` +
    `retracted(source_gone=${revalidation.retractedSourceGone}, ` +
    `robots_disallowed=${revalidation.retractedRobotsDisallowed}, ` +
    `tos_changed=${revalidation.retractedTosChanged}, body_changed=${revalidation.retractedBodyChanged}) ` +
    `containerNotFoundSkipped=${revalidation.containerNotFoundSkipped}`,
);
