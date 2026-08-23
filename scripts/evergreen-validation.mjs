// Plan 04 §P4 再測定スクリプト（2026-08-23 改訂）。
// 旧版は SAMPLE_URLS に手書きの title/excerpt を持たせていたため、
// 「実 URL から取得できる原文テキストでゲートを通るか」を検証できていなかった。
// 本版では実在 URL のみを対象にし、OGP メタデータを実取得して評価する。
//
// 測定項目:
//   A. og:description（原文テキスト）欠損率 … P1 ガードにより pending 保存となる割合
//   B. メタデータ取得失敗率 … 実運用でそもそも摂取できない割合
//   C. ゲート通過率（本群 vs 対照群）… §1.5 除外トピックの対照群が混入しないか
import { existsSync, readFileSync } from "node:fs";
import { canonicalizeUrl } from "../src/lib/url.ts";
import { fetchOgpMetadata } from "../src/lib/sources/ogp.ts";
import { curatePosts } from "../src/lib/llm/batch.ts";

// .env.local の簡易パーサ（scripts/submit-evergreen.mjs と同じ作法）
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// 本群: 契約後の意思決定・費用内訳・演出トレードオフの体験談（ゲート通過期待）
const MAIN_GROUP = [
  {
    url: "https://www.mwed.jp/articles/11348/",
    note: "参加型演出65選。各演出の費用帯と先輩花嫁の体験談",
  },
  {
    url: "https://rukamama-note.com/palace-hotel-wedding-cost-report",
    note: "パレスホテル東京 挙式レポ。披露宴詳細と会場・装花費用",
  },
  {
    url: "https://www.wedding-note.net/blog-saving",
    note: "新郎日記。費用節約ポイント・相場や持ち込み料の実記録",
  },
  {
    url: "https://www.wedding-note.net/hmy",
    note: "卒花嫁ブログ。見積300万→最終350万の内訳と工夫",
  },
  {
    url: "https://kizuna-bridal.com/wedding-relatives-only-regret",
    note: "親族のみ婚の後悔体験談。費用と演出のトレードオフ",
  },
  {
    url: "https://soratobu-penguin.com/blog/information/setsuyaku",
    note: "披露宴の節約ポイント。持ち込み・アイテム別の削減術",
  },
];

// 対照群: §1.5 除外トピック（式場探し）。ゲート不通過であることの確認用。
const CONTROL_GROUP = [
  {
    url: "https://dressy.pla-cole.wedding/ceremony-venue-selection/",
    note: "[対照] 結婚式場の選び方完全ガイド",
  },
  {
    url: "https://pairy.com/article/wedding/1096783",
    note: "[対照] 式場選びの決め手となるポイント6選",
  },
  {
    url: "https://brass.ne.jp/media/how-to-choose-wedding-venue/",
    note: "[対照] 結婚式場の選び方・決め方",
  },
  {
    url: "https://hana-yume.net/howto/how-to-choose/",
    note: "[対照] 式場選び・決め方完ぺきガイド",
  },
  {
    url: "https://bridal-torisetsu.net/choose",
    note: "[対照] 後悔しない結婚式場の探し方",
  },
];

async function fetchGroupMetadata(label, items) {
  console.log(`\n### Phase A[${label}]: OGP メタデータ実取得 (${items.length} 件)`);
  const fetched = [];
  let fetchFailed = 0;
  let noDescription = 0;

  for (const item of items) {
    const canonical = canonicalizeUrl(item.url);
    if (!canonical) {
      console.log(`  [invalid_url] ${item.url}`);
      fetchFailed++;
      continue;
    }
    let meta = null;
    try {
      meta = await fetchOgpMetadata(canonical);
    } catch (err) {
      console.log(`  [fetch_error] ${item.url}: ${err?.message ?? err}`);
    }
    if (!meta || !meta.title) {
      console.log(`  [no_metadata] ${item.url} (${item.note})`);
      fetchFailed++;
      continue;
    }
    const hasSourceText = Boolean(meta.description && meta.description.trim());
    if (!hasSourceText) noDescription++;
    console.log(
      `  [ok] ${canonical}\n       title="${(meta.title ?? "").slice(0, 60)}" desc=${hasSourceText ? `${meta.description.length}字` : "null"} siteName=${meta.siteName ? `"${meta.siteName.slice(0, 30)}"` : "null"} (${item.note})`,
    );
    fetched.push({ ...item, canonical, meta, hasSourceText });
  }

  const total = items.length;
  console.log(
    `  -> 取得失敗/メタ無し: ${fetchFailed}/${total}, og:description 欠損: ${noDescription}/${total}`,
  );
  return { fetched, fetchFailed, noDescription };
}

async function runValidation() {
  console.log("=== Evergreen 再測定（実 URL / 実 OGP メタデータ） ===");
  console.log(`本群 ${MAIN_GROUP.length} 件 + 対照群 ${CONTROL_GROUP.length} 件`);

  const main = await fetchGroupMetadata("本群", MAIN_GROUP);
  const control = await fetchGroupMetadata("対照群", CONTROL_GROUP);

  // Phase B: 原文テキストがあるものだけ LLM キュレーション（P1 ガードと同じ分岐）
  const evaluable = [...main.fetched, ...control.fetched].filter((f) => f.hasSourceText);
  const pendingCount =
    main.fetched.filter((f) => !f.hasSourceText).length +
    control.fetched.filter((f) => !f.hasSourceText).length;

  console.log(
    `\n### Phase B: LLM キュレーション (${evaluable.length} 件 / pending 対象 ${pendingCount} 件は評価外)`,
  );
  if (evaluable.length === 0) {
    console.log("評価可能な原文テキストが 1 件もありません。URL リストを見直してください。");
    return;
  }

  const inputs = evaluable.map((f) => ({
    title: f.meta.title,
    excerpt: f.meta.description,
  }));
  const startTime = Date.now();
  const { results, geminiCalls } = await curatePosts(inputs);
  const duration = Date.now() - startTime;

  const tally = { main: { evaluated: 0, passed: 0 }, control: { evaluated: 0, passed: 0 } };

  results.forEach((res, idx) => {
    const item = evaluable[idx];
    const group = item.note.startsWith("[対照]") ? "control" : "main";
    console.log(`\n--- [${group}] ${item.canonical} ---`);
    if (!res) {
      console.log("Result: FAILED / NULL (LLM error or deadline exceeded)");
      return;
    }
    tally[group].evaluated++;
    const passes = res.ceremonyDecision && !res.preDecisionOrPhotoShoot;
    if (passes) tally[group].passed++;
    console.log(
      `Category: ${res.category} | Tag: ${res.tag} | Firsthand: ${res.firsthand} | Tradeoff: ${res.tradeoff}`,
    );
    console.log(
      `CeremonyDecision: ${res.ceremonyDecision} | PreDecisionOrPhotoShoot: ${res.preDecisionOrPhotoShoot} | Gate: ${passes ? "PASS" : "FAIL"}`,
    );
    console.log(`Summary: ${(res.summary ?? "").slice(0, 120)}`);
  });

  const rate = (g) =>
    tally[g].evaluated > 0 ? ((tally[g].passed / tally[g].evaluated) * 100).toFixed(1) : "n/a";

  console.log(`\n========================================`);
  console.log("VALIDATION SUMMARY:");
  console.log(
    `A. og:description 欠損率: 本群 ${main.noDescription}/${main.fetched.length}, 対照群 ${control.noDescription}/${control.fetched.length}`,
  );
  console.log(
    `B. 取得失敗率: 本群 ${main.fetchFailed}/${MAIN_GROUP.length}, 対照群 ${control.fetchFailed}/${CONTROL_GROUP.length}`,
  );
  console.log(
    `C. ゲート通過率: 本群 ${tally.main.passed}/${tally.main.evaluated} (${rate("main")}%) / 対照群 ${tally.control.passed}/${tally.control.evaluated} (${rate("control")}%)`,
  );
  console.log(`Gemini API Calls: ${geminiCalls} | Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`========================================`);
  if (tally.control.passed > 0) {
    console.log(
      `⚠️ 対照群（式場探し等の除外トピック）が ${tally.control.passed} 件通過。§9.3 判定項目の要見直し。`,
    );
  }
}

runValidation().catch((err) => {
  console.error("[validator] Fatal error:", err);
  process.exit(1);
});
