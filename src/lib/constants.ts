/**
 * 全チューニング値の集約ファイル。
 * lib 配下のコードにマジックナンバーを直書きしない — 必ずここに定数化する。
 */

// ── LLM (Gemini) ──────────────────────────────────────────────
/** キュレーションに使う Gemini モデル ID。 */
export const LLM_MODEL = "gemini-3.1-flash-lite";
/**
 * 生成温度。0（このSDKでの最小値）に固定している。
 *
 * すべてのキュレーション呼び出しは要約・タイトル生成と同時に有用度判定
 * （firsthand / ceremonyDecision / specific / weddingDayContent / promotional /
 * preDecisionOrPhotoShoot の6つのブール値。`src/lib/scoring/usefulness.ts`
 * 参照）を1コールで行う設計のため、
 * 温度を上げるとこのブール判定がブレて体験談レーンの掲載順が実行のたびに
 * 揺らいでしまう。要約の事実からの逸脱・創作的表現の抑制という以前からの
 * 目的とも合致するため、0.2 から 0 へさらに下げた。
 */
export const LLM_GEN_TEMPERATURE = 0;
/** バッチキュレーション 1 回あたりの投稿数。 */
export const LLM_BATCH_SIZE = 12;
/** バッチ処理の並列実行数（p-limit）。 */
export const LLM_BATCH_CONCURRENCY = 4;
/** バッチ 1 回あたりのタイムアウト。 */
export const LLM_BATCH_TIMEOUT_MS = 25_000;
/** 単体キュレーション（フォールバック / SNS 単発投稿）のタイムアウト。 */
export const LLM_SINGLE_TIMEOUT_MS = 30_000;
/** Gemini API 呼び出しの最大リトライ回数（429 / 5xx 用）。 */
export const LLM_MAX_RETRIES = 3;
/** バッチ呼び出し専用の最大リトライ回数（バッチは軽めに）。 */
export const LLM_BATCH_MAX_RETRIES = 1;
/** JSON パース失敗時の再試行回数。 */
export const LLM_MAX_PARSE_RETRIES = 2;
/** 指数バックオフの基準待機時間。 */
export const LLM_BACKOFF_BASE_MS = 2000;
/** バッチ応答の最大トークン数。 */
export const LLM_BATCH_MAX_TOKENS = 8000;
/** 単体応答の最大トークン数。 */
export const LLM_SINGLE_MAX_TOKENS = 800;
/**
 * プロンプト本文を変更したら bump する（curationSignature に反映）。
 *
 * v2: 有用度判定5項目（firsthand / ceremonyDecision / specific / weddingDayContent /
 * promotional）の判定指示を追加し、想定読者ペルソナをプロンプトに載せた
 * （openspec/specs/wedding-trend/spec.md §9 編集方針）。bump により全投稿の
 * curationSignature が不一致になり、次回以降の ingest で段階的に、または
 * scripts/backfill-usefulness.mjs で一括して再キュレーションされる。
 * v3: 新たな判定項目 `preDecisionOrPhotoShoot`（フォト婚・前撮り・式場探し等の話題か）を追加し、`ceremonyDecision` の定義を「挙式当日の写真・映像」に限定した（shared_plan/02）。bump により全投稿の curationSignature が不一致になり、再キュレーションされる。
 * v4: プロンプト本文の指示は元から6項目（v3 で `preDecisionOrPhotoShoot`
 * を追加済み）だったが、見出し・件数表記が「5つのブール値」「以下の5項目」
 * のまま取り残されていた（`USEFULNESS_CRITERIA_RULES` in
 * `src/lib/llm/prompts.ts`）。LLM が実際に読むプロンプト本文自体の誤りで
 * あり、単なるコメント陳腐化ではないため修正した。判定ロジック・判定項目の
 * 定義自体は変わっていない（重み調整ではなくプロンプト本文の変更なので、
 * 重み変更のときとは異なり bump が正しい——この変更は
 * `computeCurationSignature` の対象であるプロンプトそのものの変更であり、
 * bump により全投稿の curationSignature が不一致になり再キュレーションされる）。
 * v8 (2026-08-27, shared_plan/15): topicAnchor を「結論を出さずに記事が扱う具体的な判断・場面・選択肢を体言止めで名指しする」よう RATIONALE_RULES を書き換えた。bump により全投稿の curationSignature が不一致になり、backfill-usefulness.mjs で再キュレーションされる。
 * v10 (2026-08-29, オーナー判断): topicAnchor のゲート大幅緩和に伴い RATIONALE_RULES を再設計。(a) 本文語句の逐語使用指定を削除（記事内容に即していれば自然な言い換えを許容）、(b) 文型指定（「問いを立てる節にする・体言止め禁止」）を削除、(c) 「この記事ならではの独自性を続きを読みたくなる形で提示する」クリック誘引ルールを追加。数値・PII・煽り語の禁止は維持。bump により全投稿の curationSignature が不一致になり、backfill-usefulness.mjs --force で一括再キュレーションできる（spec §10-3）。
 * v11 (2026-08-30, オーナー判断): 有用度判定を全項目 boolean → 0/1/2 の三段階へ。`specific` を「当日の実施内容の具体性」、`weddingDayContent` を「フルパッケージ結婚式の当日内容か」に再定義し、`preDecisionOrPhotoShoot` を廃止（`weddingDayContent = 0` に吸収）。判定項目は 5 つ（firsthand / ceremonyDecision / specific / weddingDayContent / promotional、すべて 0-2）。USEFULNESS_CRITERIA_RULES を全面書き換え。bump により全投稿再キュレーション（spec §9.3）。
 * v12 (2026-08-30, オーナー判断): v11 再キュレーションで小モデルが 5 項目ほぼすべて 2 を返し、上位 21 件が同点（score 34）で掲載順が実質新着順になっていた。USEFULNESS_CRITERIA_RULES の「スケールの使い方」を書き換え、`1 = 該当する（標準）` / `2 = 例外的に突出している場合のみ（目安: 上位 2〜3 割）` / 迷ったら低い方、を明示。bump により全投稿再キュレーション。
 * v13 (2026-08-30, オーナー判断): v12 の 0-2 でも小モデルの分解能が不足したため、判定レンジを 0-2 → 0〜9 の整数に拡張（スケール帯を明示）。あわせて weddingDayContent を「厳密に挙式・披露宴が実際に行われた当日の実施内容」と強調し、前撮り・リハーサル・準備・式場探し・後日談のみは 0 とする指示を追加。重み定数据え置き、USEFULNESS_GATE_BONUS 16→70。bump により全投稿再キュレーション。
 */
export const CURATION_PROMPT_VERSION = 13;
export const RATIONALE_PROMPT_VERSION = "rationale-v2";
/** フィード表示条件のフェーズ。phase1: 移行期（レガシー対 OR 根拠存在）/ phase2: 根拠のみ。 */
export const RATIONALE_DISPLAY_PHASE = "phase1" as const;
export type RationaleDisplayPhase = typeof RATIONALE_DISPLAY_PHASE | "phase2";

// ── キュレーション予算・締切 ──────────────────────────────────
/** 1 回の ingest 実行で LLM に投げる投稿数の上限。 */
export const CURATION_BUDGET = 40;
/** ingest 実行全体のソフト締切（Route Handler の maxDuration=60s に対する内部上限）。 */
export const CURATION_DEADLINE_MS = 45_000;
/** 残り時間がこれ未満のバッチには着手しない。 */
export const CURATION_MIN_SLICE_MS = 5_000;

// ── AI タイトル・要約の文字数 ─────────────────────────────────
/** AI 生成タイトルの最大文字数（見出し調）。 */
export const AI_TITLE_MAX_CHARS = 30;
/** AI 生成要約の目標下限・上限（プロンプトで指示する目安）。 */
export const AI_SUMMARY_TARGET_MIN_CHARS = 100;
export const AI_SUMMARY_TARGET_MAX_CHARS = 150;
/** zod バリデーションの実際の許容範囲（目標より緩め。over-rejection 回避）。 */
export const AI_SUMMARY_VALIDATE_MIN_CHARS = 60;
export const AI_SUMMARY_VALIDATE_MAX_CHARS = 200;

/**
 * 最低限の証拠テキスト長（これ未満は証拠不十分として弾く）。
 * 2026-08-29 のゲート緩和で 80 → 30。これ未満は LLM の判定材料も
 * トピックアンカーの語彙的接地も成立しないため下限として残す。
 */
export const MIN_EVIDENCE_INPUT_CHARS = 30;

// ── 判定根拠文（renderRationaleText）の文字数上下限 ──────────────
/**
 * `renderRationaleText()`（`src/lib/publish/gate.ts`）が生成する判定根拠文の
 * 下限文字数。`renderRationaleText()` 自身がこの値を下回ったら例外を投げる
 * （上限側と対称）。
 *
 * 値は「公開経路に実際に到達しうる」構造的最小値——理論上の zod 下限
 * （`topicAnchor` は `CurationItemSchema` 上 `min(1)`）ではない。`topicAnchor`
 * が1字の場合、`checkAnchorGrounding()`（`src/lib/publish/gate.ts`）の
 * `extractFeatureTerms()` が長さ2未満の語を特徴語として採用しないため
 * 特徴語ゼロとなり `anchor_ungrounded` で終端棄却され、公開経路に乗らない
 * （`src/lib/pipeline/ingest.ts` / `evergreen.ts` / `discovery-ingest.ts` は
 * いずれも `publishPost`/`status: "published"` の前に `checkAnchorGrounding()`
 * を通す）。有用度スコア（`computeUsefulnessScore()`）側には公開を止める
 * 閾値ゲートが無く、有用度6項目すべて false の投稿も公開されうることは
 * 確認済み。したがって公開経路上の構造的最小値は「`topicAnchor` が
 * `checkAnchorGrounding()` を通過する最小の2字、有用度6項目すべて false」
 * のケースであり、`renderRationaleText()` の実測値は 38 字
 * （`tests/publish-gate.test.ts` にリテラル固定）。
 */
export const RATIONALE_TEXT_MIN_CHARS = 38;
/**
 * `renderRationaleText()` が生成する判定根拠文の上限文字数。
 * `renderRationaleText()` は topicAnchor + 有用度6項目のフラグから決定的に
 * 組み立てる純粋関数のため、これを超えることは仕様の上限緩和ではなく
 * テンプレート側の実装バグを意味する（`renderRationaleText()` はこの値を
 * 超えたら例外を投げる）。
 *
 * 構造的最大値（アンカー40字×フラグ6個＝206字）を上回るよう設定。テンプレート
 * やラベルを変更した場合は構造的最大値を測り直すこと。
 */
export const RATIONALE_TEXT_MAX_CHARS = 210;

// ── 再試行キュー（plan 07 §7: pending 廃止）────────────────────
/** 再試行キューの最大試行回数。超過は `retry_exhausted` で終端棄却する。 */
export const RETRY_MAX_ATTEMPTS = 3;
/** 再試行キューエントリの絶対 TTL（時間）。超過は `expireRetries` で削除・終端棄却する。 */
export const RETRY_TTL_HOURS = 72;
/** 指数バックオフの各試行での待機時間（時間）。`attempts`（0始まり）に対応する。 */
export const RETRY_BACKOFF_HOURS: readonly number[] = [1, 6, 24];
/**
 * 非終端状態（"pending" 等、既知の終端状態 published/rejected/retracted 以外）
 * のまま留まってよい最大時間。`reapStaleNonTerminal` がこれを超えた行を
 * status="rejected" + post_removals(kind="dropped", reason="stale_pending") に
 * 収束させる（plan 07 §7）。
 */
export const STALE_NON_TERMINAL_HOURS = 72;

// ── 公開レート上限（暴走検知サーキットブレーカー。spec §11 項4）────────────
/**
 * 1 日あたりの公開上限件数。**供給スロットルではなくサーキットブレーカー**。
 *
 * 2026-08-29 の方針転換（オーナー判断）: 旧来この上限は「1 ホストがフィードを
 * 埋めると集約レベルで中立キュレーションの主張が偽になる」ことを防ぐ安全弁
 * （plan 07 §6-Q4）と位置づけられ、`HOST_DAILY_SHARE_MAX` と組で運用していた。
 * 集約レベルの中立性を運用ポリシーから外すことに伴い:
 * - `HOST_DAILY_SHARE_MAX` を廃止（単一ホスト偏りの抑止は行わない）。
 * - `DAILY_PUBLISH_CAP` は供給目標（旧 15 件/日）から切り離し、DOM 変更等で
 *   一晩に数百件を誤公開する相関カスケード事故だけを止める上限として 150 に
 *   設定する。通常運用でこの値に達することは想定しない。
 * - 到達時の挙動は従来どおり「公開せず rate_capped リトライキューへ繰り延べ」。
 */
export const DAILY_PUBLISH_CAP = 150;

// ── ホスト allowlist（plan 07 §6-Q3）────────────────────────
/**
 * discovery レーンで取得を許可するホストの allowlist。新規ホストの自動追加は
 * 禁止し、追加は明示的なコミットでのみ行う（アフィリエイトサイト等の混入を
 * 構造的に防ぐ）。既存の稼働ホスト（`src/lib/sources/sitemap-discovery.ts` /
 * `shared_plan/06-rationale-and-scraping.md` で検証済み）を列挙する。
 *
 * `tosUrl` は M3-K2（規約変更検知）が監視する規約ページの URL。自動発見は
 * しない（誤ったページを規約と誤認すると K2 が無意味なノイズを出し続ける
 * ため）。確証が持てないホストは `tosUrl: null` とし、確認でき次第埋める。
 */
export type AllowlistedHost = {
  readonly host: string;
  readonly tosUrl: string | null;
  /**
   * このホストで収集を許可する記事パス（pathname）のパターン。
   * いずれのパターンにも一致しない URL は取得しない（ホスト単位だけでなく
   * パス単位でもホワイトリスト方式を採る——ブラックリストはサイト側が
   * 新しい URL 構造を追加したときに静かに破れるため）。
   *
   * ホスト同様、**新規パターンの追加は明示的なコミットでのみ**行う。sitemap
   * の指定を変えるだけで未知のセクション（例: 口コミ投稿ページ）が収集対象に
   * 混入することを構造的に防ぐのが目的（shared_plan/06 §10「サイト単位での
   * 対象指定は採用しない——セクション＋パス接頭辞で定義する」）。
   */
  readonly articlePathPatterns: readonly RegExp[];
  /**
   * 記事本文コンテナを特定する CSS セレクタ（優先順）。実 HTML の構造ダンプで
   * 確定した「記事本体を囲む最小の要素」を先頭から試し、最初にマッチした
   * 要素の innerHTML を本文抽出の対象にする（`src/lib/sources/article-text.ts`
   * の `extractArticleContainer()`）。ページ全体を測るとナビ・フッター・
   * 第三者コンテンツ（口コミ等）が Q1 ゲートの指標に混入するため、
   * このセレクタでサブツリーを切り出してから指標を計算する。
   *
   * どのセレクタにも一致しない場合はテンプレート変更等による破損とみなし
   * `null` を返す（サイレントにページ全体へフォールバックしない）。
   */
  readonly articleContainerSelectors: readonly string[];
};
export const HOST_ALLOWLIST: readonly AllowlistedHost[] = [
  // www.mwed.jp: 規約 URL は実地調査で確認済み（HTTP 200、ページタイトル
  // 「みんなのウェディング サイト利用規約」、robots.txt 上 /kiyaku は
  // Disallow されていない）。
  //
  // articlePathPatterns: sitemap_stories.xml から実測で確認できた記事パスは
  // 次の2パターンのみ（`/story/cases/{id}/` と式場レビュー配下の
  // `/hall/{hallId}/rev/story/{id}/`）。同ホストには一般ユーザーの口コミ投稿
  // ページ `/hall/{hallId}/rev/{commentId}/`（`rev` の直後が `story` ではなく
  // 数値のコメント ID）も存在し、robots.txt では Disallow されていないため、
  // パスのホワイトリストが無いと sitemap の指定変更だけで UGC の口コミが
  // 混入する。両パターンは `rev` の直後のセグメントが固定リテラル `story`
  // かどうかで区別する（`hallId` / 末尾 ID 自体は数値が実測値だが、桁数や
  // 将来の英数字混在に対しても脆くならないよう `[^/]+` で受ける——区別に
  // 効いているのは ID の形ではなく `story` セグメントの有無）。
  {
    host: "www.mwed.jp",
    tosUrl: "https://www.mwed.jp/kiyaku",
    articlePathPatterns: [/^\/story\/cases\/[^/]+\/?$/, /^\/hall\/[^/]+\/rev\/story\/[^/]+\/?$/],
    // 実 HTML の構造ダンプで確定: div.story-detail が記事本体（見出し・
    // タイムライン・スタッフ紹介等）のみを含む最小コンテナ。口コミ・費用明細
    // （div#point-section-top）やサブナビ（nav.renewal-2023-place-menu）は
    // 兄弟ノードであり、このセレクタで自動的に除外される。
    // div.produce-story-detail はそのフォールバック（story-detail 自体が
    // テンプレート変更で消えた場合に一段広い範囲を試す）。
    articleContainerSelectors: ["div.story-detail", "div.produce-story-detail"],
  },
];
/** allowlist のホスト名のみを取り出した配列（ホスト判定用）。 */
export const HOST_ALLOWLIST_HOSTS: readonly string[] = HOST_ALLOWLIST.map((h) => h.host);
/** allowlist からホストの登録済み ToS URL を引く。未登録ホストや未設定は null。 */
export function getAllowlistedTosUrl(host: string): string | null {
  return HOST_ALLOWLIST.find((h) => h.host === host)?.tosUrl ?? null;
}

/**
 * URL がホスト allowlist かつ記事パスのホワイトリストの両方を満たすかを判定する。
 * ホストが allowlist に無い場合、またはパスがどのパターンにも一致しない場合は
 * false。URL のパースに失敗した場合も安全側で false。
 */
export function isAllowedArticleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const entry = HOST_ALLOWLIST.find((h) => h.host === parsed.hostname);
  if (!entry) return false;
  return entry.articlePathPatterns.some((pattern) => pattern.test(parsed.pathname));
}

// ── 抽出品質の決定的ゲート（plan 07 §6-Q1）──────────────────
/**
 * リンクテキスト長 / 全テキスト長。これを超えたら本文抽出破損（ナビ誤認等）とみなす。
 *
 * この値はページ全体を測っていた旧実装時代のもの。`computeEvidenceSignals()`
 * は今はホストの `articleContainerSelectors` で切り出したコンテナ HTML の
 * 内側でのみリンク密度を計算する（ナビ・フッターは既にサブツリー除外済み）。
 * コンテナ内基準へ変更済み。2026-08-29 のゲート緩和で 0.25 → 0.70 に緩め、
 * 純粋なリンク集約ページ・ナビだけを弾く水準にした（§11-1）。
 */
export const MAX_LINK_DENSITY = 0.7;
/** 本文と判定するために必要な最小段落数。2026-08-29 のゲート緩和で 3 → 1。 */
export const MIN_PARAGRAPH_COUNT = 1;

// ── yield 崩壊検知（plan 07 §6-Q2 / K8）─────────────────────
/** ホストのベースライン算出に必要な最小日数。これ未満は小標本ノイズとして扱わない。 */
export const YIELD_BASELINE_MIN_DAYS = 7;
/** ベースラインからの乖離係数。実測値がベースラインのこの倍率を下回ったら発火する。 */
export const YIELD_DEVIATION_FACTOR = 0.5;

// ── 本文ハッシュドリフト（plan 07 §5-M4）────────────────────
/** 本文の類似度がこれを下回ったら「大幅変化」とみなし自動撤回する。 */
export const BODY_DRIFT_SIMILARITY_MIN = 0.7;
/** RSS フィード取得のタイムアウト。 */
export const RSS_FETCH_TIMEOUT_MS = 10_000;
/** 1 ソースあたり取得する記事数の上限。 */
export const SOURCE_ITEM_LIMIT = 20;
/** RSS 取得時に付与する User-Agent。 */
export const RSS_USER_AGENT = "wedding-trend-bot/1.0 (+https://github.com/ponkansh6/wedding-trend)";
/** originalExcerpt に保存する本文抜粋の最大文字数（LLM プロンプトの肥大化を防ぐ）。 */
export const EXCERPT_MAX_CHARS = 600;

// ── oEmbed（SNS 埋め込み）──────────────────────────────────────
/** oEmbed API 呼び出しのタイムアウト。 */
export const OEMBED_TIMEOUT_MS = 8_000;
/** oEmbed 取得結果のキャッシュ有効日数（embedFetchedAt からの経過日数で判定）。 */
export const OEMBED_CACHE_TTL_DAYS = 30;

// ── フィード表示 ──────────────────────────────────────────────
/** フィード 1 ページあたりのカード数。 */
export const FEED_PAGE_SIZE = 24;

// ── Sitemap Discovery ──────────────────────────────────────────
/** Sitemap 差分検出時の lastmod 逸脱検知閾値（これを超えたら lastmod を不信任とする）。 */
export const LASTMOD_DIFF_ALERT_THRESHOLD = 100;

// ── アクセス規律（クロール）──────────────────────────────────
/**
 * クロール時に付与する User-Agent。連絡先を必ず含める（plan 06 §5.4）。
 * 本番ドメインの /about はオーナー判断待ち（§13-4）のため、当面は GitHub リポジトリを連絡先とする。
 */
export const CRAWLER_USER_AGENT =
  "WeddingTrendBot/1.0 (+https://github.com/ponkansh6/wedding-trend)";
/** 同一ホストへの最小リクエスト間隔（ms）。robots.txt の Crawl-delay が大きい場合はそちらを下限として尊重する。 */
export const MIN_HOST_INTERVAL_MS = 5_000;
/** ホストあたり日次リクエストのハードキャップ（日次リクエスト予算 B1・soft stop）。間隔だけでなく総量を見る。 */
export const DAILY_REQUEST_CAP_PER_HOST = 50;
/** 記事取得の本文サイズ上限（plan 06 §5.2）。超過は打ち切る（kill gate ではない）。 */
export const MAX_BODY_BYTES = 512 * 1024;
/**
 * 発見ランナー 1 回あたりの処理時間予算（plan 06 §5.5: ジョブは 15〜20 分を上限）。
 * Actions ジョブ全体の timeout より短くし、残り pending は次回ランに委ねる。
 */
export const DISCOVERY_INGEST_TIME_BUDGET_MS = 15 * 60 * 1000;

// ── 収集トリガー（cooldown / lease）────────────────────────────
/** 非RSS エバーグリーン摂取経路（手動キュレーションキュー）で投入する投稿の sourceId。 */
export const EVERGREEN_SOURCE_ID = "evergreen";
// 詳細な設計判断（なぜ claim/extend の 2 段階か、CAS の必要性など）は
// `src/lib/pipeline/cooldown.ts` の JSDoc を参照。

/**
 * 収集トリガーの実行権を確保（claim）した時点で最低限押さえるクールダウン幅。
 *
 * 収集ボタンはオーナー限定（`/admin` の Basic 認証配下）に閉じるため、以前の
 * ような「無認証の公開ボタン濫用を fail-closed で防ぐ」目的の値ではない。
 * ここでの役割は、Gemini を実際に呼ばなかった「空振り」実行（例: 新着ゼロで
 * 何もキュレーションしなかった）の再実行間隔を短く保つこと。空振りはコストが
 * 掛かっていないので、長時間ブロックする理由がない。
 */
export const INGEST_BASE_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * 収集ラン中に Gemini を実際に呼んだ場合、完了後にクールダウンを延長する幅。
 * Gemini API の予算焼き付きを防ぐための実質的なレートリミットはこちらが担う
 * （`INGEST_BASE_COOLDOWN_MS` は空振り用の短い間隔に過ぎない）。
 */
export const INGEST_FULL_COOLDOWN_MS = 4 * 60 * 60 * 1000;

/**
 * 収集パイプラインの実行排他（同時実行禁止）ロックの TTL。
 *
 * 以前は 10 分だったが、Route Handler の `maxDuration` が 60 秒である以上
 * 10 分は過剰に長く、タイムアウトやクラッシュでリースが解放されないまま
 * 残った場合に、最大で 9 分近く「実行中」の実体がないまま収集ボタンが
 * 押せなくなっていた（不必要な機会損失）。2 分あれば実測実行時間
 * （長くても 60 秒程度）に対して十分な回復余裕を保ちつつ、この機会損失を
 * 大幅に縮小できる。
 */
export const INGEST_LEASE_TTL_MS = 2 * 60 * 1000;

// ── 有用度スコアリング（体験談レーンの掲載順）─────────────────
// 計算式・各重みの根拠（確信度に比例させている理由等）は
// `src/lib/scoring/usefulness.ts` の JSDoc、編集方針全体は
// `openspec/specs/wedding-trend/spec.md` を参照。ここでは値のみを持つ。

/**
 * ゲート分（`ceremonyDecision >= 1 かつ weddingDayContent >= 1` のときに加算）。
 *
 * 2026-08-30 の 0-2 三段階化に伴い 12 → 16 に再計算。同日 0-9 拡張に伴い 16 → 70。
 * **強支配不変条件**（ゲート通過帯は常にゲート不通過帯に優先する）:
 * - ゲート不通過の最大 = `9×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)` = 9×(3+2+2) = 63
 *   （`ceremonyDecision = 0` かつ他が最大の場合。`weddingDayContent = 0` かつ
 *   `ceremonyDecision = 9` の場合も `9×(W_CEREMONY + W_FIRSTHAND + W_SPECIFIC)` = 63）
 * - ゲート通過の最小 = `GATE_BONUS + W_CEREMONY×1 + W_WEDDING_DAY×1 - PROMO_PENALTY`
 *   （`cd=1, wdc=1, firsthand=0, specific=0, promotional=9`）= 70 + 2 + 2 - 4 = 70
 * - 70 > 63 で成立。不変条件
 *   `GATE_BONUS + W_CEREMONY + W_WEDDING_DAY - PROMO_PENALTY > 9×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)`
 *   を `tests/usefulness-score.test.ts` で定数から式を組み立てて固定している。
 */
export const USEFULNESS_GATE_BONUS = 70;

/** 実体験に基づく記事であることの加点（`weight × value(0-9)`）。抜粋段階で判定しやすいため重め。 */
export const USEFULNESS_WEIGHT_FIRSTHAND = 3;

/**
 * `ceremonyDecision`（挙式・披露宴の中身の意思決定に効くか）の加点
 * （`weight × value(0-9)`）。2026-08-30 の 0-2 化以前はゲート専用でこの加点は無かった。
 */
export const USEFULNESS_WEIGHT_CEREMONY_DECISION = 2;

/** 当日の実施内容の具体性の加点（`weight × value(0-9)`）。本文中盤以降でないと判定しにくいため firsthand より軽め。 */
export const USEFULNESS_WEIGHT_SPECIFIC = 2;

/** フルパッケージ結婚式（挙式＋披露宴）の当日内容を扱っているかの加点（`weight × value(0-9)`）。
 * `value` は強支配不変条件（`USEFULNESS_GATE_BONUS` の JSDoc 参照）を維持する必要から 2 に据え置く。 */
export const USEFULNESS_WEIGHT_WEDDING_DAY = 2;

/** 事業者による集客が主目的の記事に対する減点。`promotional >= 7`（過剰かつ明確な誘導）のときのみ発火する。 */
export const USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY = 4;

// ── HTTP ステータス ───────────────────────────────────────────
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_SERVER_ERROR_MIN = 500;

// ── ログ ──────────────────────────────────────────────────────
export const DEBUG_LOG_TRUNCATE_LENGTH = 100;

// ── 管理者が編集する取得元リスト ───────────────────────────────
// 以下の値はすべて 2026-08-22 に実リクエストで件数と内容を検証済み。
// 追加・変更する場合は `node scripts/check-sources.mjs` で死活を確認すること。

/**
 * Hatena Bookmark タグ検索の対象タグ。
 *
 * **現在は無効化している（意図的に空）。**
 *
 * 2026-08-22 の実データ検証で、はてブ経由の結婚系エントリは体験談ではなく
 * 議論・炎上寄りに強く偏ることが判明した。実際に取り込まれた 6 件は全件が
 * LLM に `classic` と分類され「満足度の高い王道・定番」レーンに流入したが、
 * 内容は「招待取消でヴィーガン家族が難色」「見積もり 900 万円」といった話題で、
 * このレーンの趣旨（卒花の満足度の高い体験談）と合致しなかった。
 *
 * 費用感の実データが得られる利点はあるため、恒久的な削除ではなく空で停止する。
 * 再開する場合はここにタグを戻すだけでよい（アダプタとテストは維持している）。
 *
 * 検証済みの件数: 結婚式 41件 / ブライダル 12件 / ウェディング 37件。
 * `結婚式準備` `卒花` `プレ花嫁` は 0 件。`結婚` は 41 件返るが内容は
 * 夫婦の愚痴・恋愛論・漫画で本企画と無関係。
 */
export const HATENA_BOOKMARK_TAGS: readonly string[] = [];

/**
 * Google News 検索クエリ（ウエディング関連）。
 *
 * 検証結果: 本企画で最も内容が合致するソース。ドレスのトレンド特集、
 * ウエディングケーキの新潮流、披露宴の演出トレンドなどが実際に取得できる。
 *
 * 既知の制約: `<link>` は news.google.com のリダイレクト URL であり元記事の
 * 直接 URL ではない。人間がクリックすれば元記事に到達するため導線と著作者
 * クレジット（`author` に媒体名を格納）は保たれるが、他ソースとの URL 重複
 * 排除は効かない。同一記事が複数媒体で配信された場合も別エントリとして残る。
 */
export const GOOGLE_NEWS_QUERIES = ["結婚式 トレンド", "ウエディング 演出"] as const;

/**
 * note.com のハッシュタグ RSS (https://note.com/hashtag/{tag}/rss)。
 *
 * 検証結果: 7 タグすべて稼働、各 25〜26 件。延べ 182 件に対しユニーク 146 件で
 * 重複は約 20% にとどまり、タグ同士は相補的。内容も式場見学の判断基準、
 * Canva での結婚式 DIY、ブライダル美容など「卒花の体験談」そのもので、
 * 本企画の体験談レーンにおける主力ソース。
 */
export const NOTE_HASHTAGS: readonly string[] = [
  "結婚式準備",
  "卒花",
  "結婚式",
  "ウェディング",
  "花嫁",
  "プレ花嫁",
  "結婚式レポ",
];

/**
 * アメーバブログの個別ブログ RSS (https://rssblog.ameba.jp/{blogId}/rss.html)。
 *
 * **意図的に空にしている。** エンドポイント自体は稼働しており、
 * https://blogger.ameba.jp/genres/wedding からブログ ID を発見できることも
 * 確認済み（kei-konkatsu / ar-saa / dapanda45 / lehaim-diamond は本日更新・RSS 稼働）。
 *
 * しかし ameblo の「wedding」ジャンルはブログ単位の分類であり、実際の投稿は
 * 婚活・日記・店舗販促が混在して卒花レポではなかった。取得はできるが内容が
 * 使えないため、プレースホルダーを残さず空で運用する。
 * 実在しない ID を残すと死活監視が「正常」と誤報するため、空であることが正しい。
 *
 * 運用者が個別に良質なブログを見つけた場合はここに ID を追加する。
 */
export const AMEBLO_BLOG_IDS: readonly string[] = [];
