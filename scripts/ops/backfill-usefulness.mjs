#!/usr/bin/env tsx
/**
 * 有用度スコア（post_usefulness_criteria）の全件バックフィル用の使い捨てスクリプト。
 *
 * CURATION_PROMPT_VERSION を bump した直後は、通常の ingest（新着優先 +
 * 余った予算でのバックフィル、src/lib/pipeline/ingest.ts 参照）でも数回の
 * cron 実行で全件へ波及するが、すぐに全件を揃えたい場合はこのスクリプトで
 * ローカルから直接 Turso に繋いで一括処理する。
 *
 * ロジックは複製しない: 候補選定は src/lib/db/repository.ts の
 * getStaleCurationCandidates()、キュレーション本体は src/lib/llm/batch.ts の
 * curatePosts() をそのまま呼ぶ薄いラッパー。Vercel の maxDuration や
 * CURATION_DEADLINE_MS（ソフト締切）はローカル実行には無関係なので、
 * 予算を上げ・締切なしで一括処理する。
 *
 * Gemini 無料枠（15 req/min）は全候補を一度に流すとすぐに枯渇する
 * （429 の指数バックオフ再試行が積み重なりログが埋まる上、実際の成功率も
 * 落ちる）。そのための分割実行オプション（--limit / --source）と、
 * バッチ投入間隔（BACKFILL_CHUNK_SIZE / BACKFILL_CHUNK_DELAY_MS）を用意している。
 * **再開可能性**: LLM 呼び出しに失敗した候補（429 で結果を得られなかった等）は
 * `curationSignature` を更新しないため、次回このスクリプトを実行したとき
 * `getStaleCurationCandidates()` に再び候補として現れる。したがって
 * `--limit` で小分けにしながら何度も再実行しても安全（二重更新にはならず、
 * 前回失敗した分は自然にリトライされる）。
 *
 * 使い方（pnpm 経由。npx/npm は使わない）:
 *   pnpm exec tsx scripts/ops/backfill-usefulness.mjs          # dry-run（Gemini を呼んで
 *     プレビュー表示するが DB へは書き込まない。Gemini 課金は dry-run でも発生する）
 *   pnpm exec tsx scripts/ops/backfill-usefulness.mjs --apply  # 実際に DB へ書き込む
 *   pnpm exec tsx scripts/ops/backfill-usefulness.mjs --apply --force
 *     # 署名に関わらず全ブログ投稿を再スコア（キュレーション結果の修正・検証用）
 *   pnpm exec tsx scripts/ops/backfill-usefulness.mjs --limit 20
 *     # 候補プールの先頭 20 件だけを対象にする（無料枠内での分割実行用）
 *   pnpm exec tsx scripts/ops/backfill-usefulness.mjs --source note.com --limit 20
 *     # URL に "note.com" を含む候補（プラン16 Stage 6 のコホート順）に絞った上で先頭 20 件
 *
 * 環境変数（バッチ投入間隔の調整。Gemini 無料枠 15 req/min を踏まえたデフォルト値）:
 *   BACKFILL_CHUNK_SIZE      : curatePosts() 1 回あたりに渡す候補数（デフォルト 30）
 *   BACKFILL_CHUNK_DELAY_MS  : チャンク間のウェイト（ミリ秒、デフォルト 15000）
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const HELP = process.argv.includes("--help") || process.argv.includes("-h");
const STATS_ONLY =
  process.argv.includes("--stats-only") || process.argv.includes("--preflight-only");
const NO_FETCH = process.argv.includes("--no-fetch");

if (HELP) {
  console.log(`
有用度スコア バックフィルスクリプト
\n使い方:
  pnpm exec tsx scripts/ops/backfill-usefulness.mjs [オプション]

オプション:
  --help, -h       このヘルプを表示する（Gemini / DB に接続しません）
  --stats-only     Gemini API を呼び出さず、バックフィル対象件数とシグネチャ別内訳をプレビューする
  --apply          実際に DB へ書き込む（デフォルトは dry-run）
  --force          署名に関わらず全ブログ投稿を再スコア
  --limit N        対象件数の上限を指定する
  --source X       URL に特定の文字列を含む候補に絞る
  --max-requests N Gemini API のリクエスト回数の上限を指定する
  --no-fetch       discovery 由来（originalExcerpt が空）の本文再取得バイパスを無効化する

環境変数:
  BACKFILL_CHUNK_SIZE     チャンクあたりの候補数（デフォルト 30）
  BACKFILL_CHUNK_DELAY_MS チャンク間のウェイト（ミリ秒、デフォルト 30000）
  MAX_GEMINI_REQUESTS     最大 Gemini リクエスト数
`);
  process.exit(0);
}

/** `--limit N` / `--source X` のような `--flag value` 形式の値を argv から取り出す。 */
function readFlagValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const LIMIT_RAW = readFlagValue("--limit");
const LIMIT = LIMIT_RAW !== undefined ? Number.parseInt(LIMIT_RAW, 10) : undefined;
if (LIMIT_RAW !== undefined && (!Number.isFinite(LIMIT) || LIMIT < 0)) {
  console.error(`--limit の値が不正です: ${LIMIT_RAW}`);
  process.exit(1);
}
const SOURCE = readFlagValue("--source");

const MAX_REQUESTS_RAW =
  readFlagValue("--max-requests") ||
  readFlagValue("--maxRequests") ||
  process.env.MAX_GEMINI_REQUESTS;
const MAX_REQUESTS =
  MAX_REQUESTS_RAW !== undefined ? Number.parseInt(MAX_REQUESTS_RAW, 10) : undefined;
if (MAX_REQUESTS_RAW !== undefined && (!Number.isFinite(MAX_REQUESTS) || MAX_REQUESTS < 0)) {
  console.error(`--max-requests の値が不正です: ${MAX_REQUESTS_RAW}`);
  process.exit(1);
}

const CHUNK_SIZE = process.env.BACKFILL_CHUNK_SIZE
  ? Number.parseInt(process.env.BACKFILL_CHUNK_SIZE, 10)
  : 30;
const CHUNK_DELAY_MS = process.env.BACKFILL_CHUNK_DELAY_MS
  ? Number.parseInt(process.env.BACKFILL_CHUNK_DELAY_MS, 10)
  : 30_000;

const GEMINI_REQUEST_LOG_PATH = process.env.GEMINI_REQUEST_LOG_PATH || "logs/gemini-requests.log";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// .env.local の簡易パーサ（scripts/ops/apply-migrations-remote.mjs と同じ作法）。
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

for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "GOOGLE_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} が未設定です（.env.local を確認してください）`);
    process.exit(1);
  }
}

// 秘密情報を出力しないよう、接続先はスキームのみ表示する。
console.log(`接続先スキーム: ${process.env.TURSO_DATABASE_URL.split(":")[0]}`);

// Gemini リクエスト測定ログの初期化
const logDir = join(process.cwd(), "logs");
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}
const logFilePath = join(process.cwd(), GEMINI_REQUEST_LOG_PATH);
const backfillStartTime = new Date();
const sessionHeader = `\n=== Backfill Session Started at ${backfillStartTime.toISOString()} ===\n`;
appendFileSync(logFilePath, sessionHeader, "utf-8");

function logGeminiRequest(reqNumber, chunkIdx, totalChunks, articleCount) {
  const now = new Date();
  const timeStr = now.toTimeString().split(" ")[0];
  const msg = `[Gemini #${reqNumber}] ${timeStr} - chunk ${chunkIdx}/${totalChunks} (${articleCount} articles) -> 1 request`;
  console.log(`  📊 ${msg}`);
  appendFileSync(logFilePath, `${now.toISOString()} ${msg}\n`, "utf-8");
}

// env を設定した後に import する（src/lib/db/index.ts はモジュール読み込み時に
// process.env を読んで接続を作るため）。
const { getStaleCurationCandidates, markCurated, getRationaleByPostId } =
  await import("../../src/lib/db/repository.ts");
const { curatePosts } = await import("../../src/lib/llm/batch.ts");
const { computeContentHash, computeCurationSignature } =
  await import("../../src/lib/llm/signature.ts");
const { LLM_MODEL } = await import("../../src/lib/llm/client.ts");
const { RATIONALE_PROMPT_VERSION } = await import("../../src/lib/constants.ts");
const { validateTopicAnchor } = await import("../../src/lib/publish/gate.ts");
const { shouldRegenerateAnchor } = await import("../lib/backfill-anchor-gate.mjs");
const { disciplinedFetch } = await import("../../src/lib/sources/access-discipline.ts");
const {
  extractArticleContainer,
  extractVisibleText,
  selectJudgmentSlice,
  computeEvidenceSignals,
  computeEvidenceSufficiency,
} = await import("../../src/lib/sources/article-text.ts");
const { assertNoSliceLeak } = await import("../lib/mwed-anchor-backfill.mjs");
const {
  partitionCandidates,
  selectCandidatesForRun,
  chunkArray,
  classifyBackfillOutcomes,
  summarizeBackfillOutcomes,
  buildBackfillUpdates,
  toMarkCuratedInput,
} = await import("../lib/backfill-plan.mjs");

// 本番の対象件数（数十件想定）を十分に上回る上限。無限に伸びないための保険であり、
// --limit とは別物: --source によるコホート絞り込みを --limit 適用前に行うため、
// 常に大きめのプールを取得してから scripts/lib/backfill-plan.mjs の
// selectCandidatesForRun() で絞り込む（詳細は同関数の JSDoc 参照）。
const BACKFILL_LIMIT = 1000;

const currentSignature = computeCurationSignature();
console.log(`対象シグネチャ: ${currentSignature} / モデル: ${LLM_MODEL}`);

const allCandidates = await getStaleCurationCandidates({
  currentSignature,
  limit: BACKFILL_LIMIT,
  force: FORCE,
});
console.log(
  `バックフィル対象（DB 上の候補プール全体）: ${allCandidates.length} 件${FORCE ? "（--force: 署名無視）" : ""}`,
);

// --source によるコホート絞り込み → --limit による頭出し、の順で適用する
// （selectCandidatesForRun の JSDoc 参照。順序を逆にすると --source の意味が失われる）。
const candidates = selectCandidatesForRun(allCandidates, { source: SOURCE, limit: LIMIT });
if (SOURCE || LIMIT !== undefined) {
  console.log(
    `今回の実行対象（--source=${SOURCE ?? "(指定なし)"} --limit=${LIMIT ?? "(指定なし)"} 適用後）: ${candidates.length} 件`,
  );
}

if (STATS_ONLY) {
  console.log("\n[--stats-only モード] Gemini API は呼び出さずに終了します。");
  const { runnableCandidates, skippedCandidates } = partitionCandidates(
    candidates,
    shouldRegenerateAnchor,
  );
  console.log(`- バックフィル対象総数: ${allCandidates.length} 件`);
  console.log(`- フィルタ適用後対象数: ${candidates.length} 件`);
  console.log(`- プレフライト再生成対象（LLM対象）: ${runnableCandidates.length} 件`);
  console.log(`- プレフライトスキップ対象: ${skippedCandidates.length} 件`);
  process.exit(0);
}

if (candidates.length === 0) {
  console.log("対象なし。終了します。");
  process.exit(0);
}

// R4: dry-run でも新旧 topicAnchor の対比を表示するため、--apply の有無にかかわらず
// Gemini を呼び出す（DB への書き込みだけを末尾で APPLY によってゲートする）。
// dry-run でも Gemini 課金は発生することを明示しておく。
console.log(
  APPLY
    ? "Gemini によるキュレーションを開始します..."
    : "dry-run: Gemini によるキュレーションを実行して結果をプレビューします（課金が発生します。DB へは書き込みません）...",
);
// プレフライト: shouldRegenerateAnchor が false の候補は、LLM 呼び出しの入力から
// 除外する（スキップし、既存アンカー・既存キュレーション値は一切温存する）。
// 分割ロジック本体は scripts/lib/backfill-plan.mjs の partitionCandidates()
// （純粋関数として抽出し、単体テストで「スキップ対象は updates に一切現れない」
// 不変条件を固定している。tests/backfill-plan.test.ts 参照）。
const { runnableCandidates, skippedCandidates } = partitionCandidates(
  candidates,
  shouldRegenerateAnchor,
);

console.log(
  `プレフライト判定: 再生成対象（＝ LLM を呼ぶ件数） ${runnableCandidates.length} 件 / スキップ（タイトルのみ等） ${skippedCandidates.length} 件`,
);

// ── discovery 経路等（originalExcerpt が空の候補）の本文メモリ上再取得バイパス ──
// spec §10-5: 本文の永続化禁止。メモリ上でのみ一時取得し、LLM 入力に使う。
let finalRunnableCandidates = runnableCandidates;
let bypassedCount = 0;
let bypassFailedCount = 0;
let bypassRetryLaterCount = 0;

if (!NO_FETCH && skippedCandidates.length > 0) {
  const slicelessSkipped = skippedCandidates.filter(
    (sc) =>
      sc.candidate.originalExcerpt === null ||
      sc.candidate.originalExcerpt === undefined ||
      sc.candidate.originalExcerpt === "" ||
      sc.candidate.originalExcerpt === "null",
  );

  if (slicelessSkipped.length > 0) {
    console.log(
      `\n[discovery バイパス] originalExcerpt が空のスキップ候補 ${slicelessSkipped.length} 件について、本文をメモリ上で一時取得して再スコア対象にバイパスします...`,
    );

    const newlyRunnable = [];
    const remainingSkipped = [];

    for (const sc of skippedCandidates) {
      const isSliceless =
        sc.candidate.originalExcerpt === null ||
        sc.candidate.originalExcerpt === undefined ||
        sc.candidate.originalExcerpt === "" ||
        sc.candidate.originalExcerpt === "null";

      if (!isSliceless) {
        remainingSkipped.push(sc);
        continue;
      }

      const url = sc.candidate.url;
      // ホスト名の抽出（例: https://www.mwed.jp/... -> www.mwed.jp）
      let host = "www.mwed.jp";
      try {
        host = new URL(url).hostname;
      } catch {
        // ignore
      }

      const verdict = await disciplinedFetch(url, { purpose: "article" });
      if (verdict.kind === "kill_gate") {
        console.error(`  🛑 kill gate 発火（${verdict.gate}）: ${verdict.detail}`);
        console.error("  ホスト停止状態のため処理を中断します。");
        process.exit(1);
      }
      if (verdict.kind !== "ok") {
        bypassFailedCount++;
        remainingSkipped.push(sc);
        // budget_exhausted / rate_limited / cooldown は「本文が無い」のではなく
        // アクセス規律（§10-6 の日次ホストキャップ等）による一時的な取得不可。
        // 日次カウンタのリセット後に --source で再実行すれば取得できる。
        if (verdict.kind === "budget_exhausted" || verdict.kind === "retry_after") {
          bypassRetryLaterCount++;
          console.log(
            `  skip ${url}（fetch: ${verdict.kind} — 一時的。日次バジェット回復後に再実行で取得可）`,
          );
        } else {
          console.log(`  skip ${url}（fetch: ${verdict.kind}）`);
        }
        continue;
      }

      const html = await verdict.response.text();
      const containerHtml = extractArticleContainer(html, host);
      if (containerHtml === null) {
        bypassFailedCount++;
        remainingSkipped.push(sc);
        console.log(`  skip ${url}（container_not_found）`);
        continue;
      }

      const signals = computeEvidenceSignals(containerHtml);
      const gate = computeEvidenceSufficiency(signals);
      if (!gate.ok) {
        bypassFailedCount++;
        remainingSkipped.push(sc);
        console.log(`  skip ${url}（extraction_insufficient: ${gate.failedConditions.join(",")}）`);
        continue;
      }

      const slice = selectJudgmentSlice(extractVisibleText(containerHtml));
      bypassedCount++;
      // runnableCandidates に追加する。ここで candidate に slice を持たせるが、
      // slice はメモリ上のみの保持であり、DB やマークアップには書き出されない。
      newlyRunnable.push({
        candidate: {
          ...sc.candidate,
          originalExcerpt: slice, // 一時的なメモリ上スライス
        },
        originalIndex: sc.originalIndex,
      });
      console.log(`  bypass ok ${url}（slice ${slice.length} 字）`);
    }

    if (bypassedCount > 0) {
      finalRunnableCandidates = [...runnableCandidates, ...newlyRunnable];
      // skippedCandidates も再構成
      skippedCandidates.length = 0;
      skippedCandidates.push(...remainingSkipped);
      console.log(
        `  → バイパス成功: ${bypassedCount} 件を runnable に追加しました（バイパス失敗・維持: ${bypassFailedCount} 件）。最終 runnable: ${finalRunnableCandidates.length} 件`,
      );
    }
  }
}

// Gemini 無料枠（15 req/min）への配慮: curatePosts() 自体の内部リトライ・並行数
// 制御（src/lib/llm/batch.ts, src/lib/llm/client.ts）は変更せず、このスクリプト側で
// 「一度に curatePosts() へ渡す件数を CHUNK_SIZE 件に抑え、チャンク間に
// CHUNK_DELAY_MS のウェイトを挟む」ことでバースト的なリクエスト集中を避ける。
const runnableChunks = chunkArray(finalRunnableCandidates, CHUNK_SIZE);
if (runnableChunks.length > 1) {
  console.log(
    `チャンク分割: ${runnableChunks.length} チャンク（1チャンクあたり最大 ${CHUNK_SIZE} 件、間隔 ${CHUNK_DELAY_MS}ms）`,
  );
}

let resultsMap = new Map();
let geminiCalls = 0;
let totalGeminiRequestsCount = 0;
let stoppedEarly = false;

for (let chunkIdx = 0; chunkIdx < runnableChunks.length; chunkIdx++) {
  if (MAX_REQUESTS !== undefined && totalGeminiRequestsCount >= MAX_REQUESTS) {
    console.log(
      `\n🛑 規定のリクエスト数制限（--max-requests / MAX_GEMINI_REQUESTS = ${MAX_REQUESTS}）に達したため、処理を中断します。`,
    );
    stoppedEarly = true;
    break;
  }
  const chunk = runnableChunks[chunkIdx];
  if (chunk.length === 0) continue;
  if (chunkIdx > 0) {
    console.log(`  ...チャンク間ウェイト ${CHUNK_DELAY_MS}ms...`);
    await sleep(CHUNK_DELAY_MS);
  }

  if (MAX_REQUESTS !== undefined && totalGeminiRequestsCount >= MAX_REQUESTS) {
    console.log(
      `\n🛑 規定のリクエスト数制限（--max-requests / MAX_GEMINI_REQUESTS = ${MAX_REQUESTS}）に達したため、処理を中断します。`,
    );
    stoppedEarly = true;
    break;
  }

  console.log(
    `  チャンク ${chunkIdx + 1}/${runnableChunks.length}（${chunk.length} 件）を処理中...`,
  );

  const curationRes = await curatePosts(
    chunk.map((rc) => ({
      title: rc.candidate.originalTitle,
      excerpt: rc.candidate.originalExcerpt,
    })),
    {
      onGeminiCall: () => {
        totalGeminiRequestsCount++;
        logGeminiRequest(
          totalGeminiRequestsCount,
          chunkIdx + 1,
          runnableChunks.length,
          chunk.length,
        );
      },
      maxRequests: MAX_REQUESTS,
      getCurrentRequests: () => totalGeminiRequestsCount,
    },
  );
  geminiCalls += curationRes.geminiCalls;
  curationRes.results.forEach((res, idx) => {
    resultsMap.set(chunk[idx].originalIndex, res);
  });
  if (MAX_REQUESTS !== undefined && totalGeminiRequestsCount >= MAX_REQUESTS) {
    console.log(
      `\n🛑 規定のリクエスト数制限（--max-requests / MAX_GEMINI_REQUESTS = ${MAX_REQUESTS}）に達したため、処理を中断します。`,
    );
    stoppedEarly = true;
    break;
  }
}

// R4: dry-run 表示用に、実行対象候補の既存 topicAnchor（旧値）をまとめて引く。
const oldAnchorByPostId = new Map();
await Promise.all(
  finalRunnableCandidates
    .filter((rc) => rc.candidate.id !== null)
    .map(async (rc) => {
      const existing = await getRationaleByPostId(rc.candidate.id);
      oldAnchorByPostId.set(rc.candidate.id, existing?.topicAnchor ?? null);
    }),
);

// 3状態への分類本体は scripts/lib/backfill-plan.mjs の classifyBackfillOutcomes()。
// 「LLM 呼び出し自体が失敗した（結果なし）」候補と「LLM は成功したが gate に
// 落ちた」候補を明確に区別する（このスクリプトが直す対象の退行）。
const outcomes = classifyBackfillOutcomes(finalRunnableCandidates, resultsMap, {
  validateTopicAnchor,
});
const outcomeSummary = summarizeBackfillOutcomes(outcomes);

// updates 構築本体は scripts/lib/backfill-plan.mjs の buildBackfillUpdates()。
// ここで渡す outcomes は上の分類結果そのものであり、kind === "llm_failed" の候補は
// 内部で除外されるため、返る updates にそのエントリは一切現れない（＝ posts への
// UPDATE 文が生成されない。R1）。プレフライトでスキップされた候補は
// runnableCandidates にすら含まれていないため、同様に updates に現れない。
const { updates, degradeReasonCounts, matchedTermCounts } = buildBackfillUpdates(outcomes, {
  computeContentHash,
  currentSignature,
  modelId: LLM_MODEL,
  rationalePromptVersion: RATIONALE_PROMPT_VERSION,
  oldAnchorByPostId,
});

// R4: dry-run（--apply なし）でも、実行対象・スキップ対象・LLM失敗/gate degrade/
// 更新の内訳を目視レビューできるようにする。
console.log("");
console.log("── サマリー ──");
console.log(`候補総数（今回の対象プール）: ${candidates.length} 件`);
console.log(`LLM を呼んだ件数（プレフライト通過分）: ${runnableCandidates.length} 件`);
if (bypassedCount > 0 || bypassFailedCount > 0) {
  console.log(
    `discovery バイパス: 成功 ${bypassedCount} 件 / 失敗 ${bypassFailedCount} 件（うち一時的取得不可（日次バジェット等）: ${bypassRetryLaterCount} 件）`,
  );
  console.log(
    `最終 LLM 対象件数（プレフライト通過 + バイパス）: ${finalRunnableCandidates.length} 件`,
  );
}
if (bypassRetryLaterCount > 0) {
  console.log(
    `⚠ ${bypassRetryLaterCount} 件は本文が無いのではなく §10-6 の日次ホストキャップ等で今回取得できなかっただけ。` +
      `日次カウンタ回復後に \`--source <host>\` で再実行すれば取得・付与される（このスクリプトは再開可能）。`,
  );
}
console.log(
  `スキップ（今回 posts を更新しなかった件数。うち上記の一時的取得不可分を含む）: ${skippedCandidates.length} 件`,
);
if (skippedCandidates.length > 0) {
  console.log("  スキップ対象 URL:", skippedCandidates.map((rc) => rc.candidate.url).join(", "));
}
console.log("");
console.log("── LLM 呼び出し後の内訳（3状態。件数の合計は「LLM を呼んだ件数」と一致する） ──");
console.log(
  `  LLM 失敗（429 等で結果が得られず、updates に含めない・posts 未更新・次回また候補になる）: ${outcomeSummary.llmFailed} 件`,
);
console.log(
  `  gate degrade（生成できたが validateTopicAnchor に落ちたので topicAnchor = null。` +
    `旧アンカー・curationSignature は温存し次回また再生成の候補に残す。aiTitle/aiSummary/category/tag は更新する）: ${outcomeSummary.gateDegrade} 件`,
);
console.log(
  `  更新（topicAnchor を含め通常どおり反映。curationSignature も前進）: ${outcomeSummary.updated} 件`,
);
console.log(`  → updates 件数: ${updates.length} 件（= gate degrade + 更新。LLM失敗分は含まない）`);
if (degradeReasonCounts.size > 0) {
  console.log("  gate degrade の理由内訳:");
  for (const [reason, count] of degradeReasonCounts) {
    console.log(`    - ${reason}: ${count} 件`);
  }
}
if (matchedTermCounts.size > 0) {
  // 要件4: anchor_prohibited_term で実際にどの denylist 項目（語 or 正規表現の
  // source）が効いたかの内訳。src/lib/publish/gate.ts の checkAnchorDenylist の
  // matchedTerms JSDoc を参照（ルール識別子であり、実際の一致文字列そのものでは
  // ない箇所がある。個々の却下アンカーの実文言は下の「topicAnchor 対比」に出る）。
  console.log("  anchor_prohibited_term で抵触した denylist 項目の内訳:");
  for (const [term, count] of matchedTermCounts) {
    console.log(`    - ${term}: ${count} 件`);
  }
}
if (outcomeSummary.llmFailed > 0) {
  const failedUrls = outcomes.filter((o) => o.kind === "llm_failed").map((o) => o.candidate.url);
  console.log(`  LLM 失敗 URL（次回再実行で自動的に再候補化される）: ${failedUrls.join(", ")}`);
}
if (updates.length > 0) {
  console.log("");
  console.log(
    "── topicAnchor 対比（旧 → 新。gate degrade は新が null になり、旧アンカー・署名は温存される） ──",
  );
  for (const u of updates) {
    const oldAnchor = u._oldTopicAnchor ?? "(なし)";
    const newAnchor = u._newTopicAnchor ?? "(null / gate degrade)";
    const reasonSuffix =
      u._kind === "gate_degrade" ? `（理由: ${u._gateReason ?? "unknown"}）` : "";
    const lines = [
      `  [${u._kind}]${reasonSuffix} ${u.url}`,
      `    旧: ${oldAnchor}`,
      `    新: ${newAnchor}`,
      `    topics: ${Array.isArray(u.topics) && u.topics.length > 0 ? u.topics.join(" / ") : "(なし)"}`,
    ];
    // 要件1〜3: 却下されたアンカーの実際の文言と、missingTerms（anchor_ungrounded）/
    // matchedTerms（anchor_prohibited_term）を1回目・リトライそれぞれ表示する。
    for (const rejected of u._rejectedAnchors ?? []) {
      const attemptLabel = rejected.attempt === "first" ? "1回目" : "リトライ";
      const anchorText = rejected.anchor ?? "(生成なし)";
      const details = [];
      if (rejected.missingTerms && rejected.missingTerms.length > 0) {
        details.push(`未接地語: ${rejected.missingTerms.join("・")}`);
      }
      if (rejected.matchedTerms && rejected.matchedTerms.length > 0) {
        details.push(`抵触: ${rejected.matchedTerms.join("・")}`);
      }
      const detailSuffix = details.length > 0 ? `（${details.join(", ")}）` : "";
      lines.push(
        `    却下(${attemptLabel}, 理由: ${rejected.reason ?? "unknown"}): 「${anchorText}」${detailSuffix}`,
      );
    }
    console.log(lines.join("\n"));
  }
}
console.log("");

if (!APPLY) {
  console.log(
    "dry-run です。上記内容で問題なければ --apply を付けて再実行してください（Gemini 課金が発生します）。",
  );
  process.exit(0);
}

// markCurated に渡す前に dry-run 専用フィールドを取り除く。
const applyUpdates = toMarkCuratedInput(updates);

// §10-5 漏洩防止の保証: applyUpdates が許可リスト外のキーや slice／本文を含まないことを機械的にアサート
// （assertNoSliceLeak は updates 配列を受け取り各要素を検査する）
assertNoSliceLeak(applyUpdates);

const markResult = await markCurated(applyUpdates);

const backfillEndTime = new Date();
const durationSec = ((backfillEndTime.getTime() - backfillStartTime.getTime()) / 1000).toFixed(1);
const summaryJson = {
  startedAt: backfillStartTime.toISOString(),
  endedAt: backfillEndTime.toISOString(),
  durationSeconds: Number.parseFloat(durationSec),
  maxRequests: MAX_REQUESTS ?? null,
  stoppedEarly,
  totalGeminiRequests: totalGeminiRequestsCount,
  totalArticlesProcessed: runnableCandidates.length,
  avgRequestsPerMinute:
    durationSec > 0
      ? Number.parseFloat(
          ((totalGeminiRequestsCount / Number.parseFloat(durationSec)) * 60).toFixed(2),
        )
      : 0,
};
appendFileSync(
  logFilePath,
  `\n=== Backfill Summary ===\n${JSON.stringify(summaryJson, null, 2)}\n==========================\n`,
  "utf-8",
);
console.log(
  `  📝 Gemini リクエストログを ${logFilePath} に保存しました（合計 ${totalGeminiRequestsCount} リクエスト）`,
);

console.log(`Gemini 呼び出し回数: ${geminiCalls} (実測ログカウント: ${totalGeminiRequestsCount})`);
console.log(`更新成功: ${markResult.succeeded.length} 件 / 失敗: ${markResult.failed.length} 件`);
if (markResult.failed.length > 0) {
  console.log("失敗した URL:", markResult.failed.join(", "));
}
console.log("完了しました。");
