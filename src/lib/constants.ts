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
 * （firsthand / ceremonyDecision / specific / tradeoff / promotional の5つの
 * ブール値。`src/lib/scoring/usefulness.ts` 参照）を1コールで行う設計のため、
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
 * v2: 有用度判定5項目（firsthand / ceremonyDecision / specific / tradeoff /
 * promotional）の判定指示を追加し、想定読者ペルソナをプロンプトに載せた
 * （openspec/specs/wedding-trend/spec.md §9 編集方針）。bump により全投稿の
 * curationSignature が不一致になり、次回以降の ingest で段階的に、または
 * scripts/backfill-usefulness.mjs で一括して再キュレーションされる。
 */
export const CURATION_PROMPT_VERSION = 2;

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

// ── RSS / ソース取得 ──────────────────────────────────────────
/** RSS フィード取得のタイムアウト。 */
export const RSS_FETCH_TIMEOUT_MS = 10_000;
/** 1 ソースあたり取得する記事数の上限。 */
export const SOURCE_ITEM_LIMIT = 20;
/** RSS 取得時に付与する User-Agent。 */
export const RSS_USER_AGENT = "wedding-trend-bot/1.0 (+https://github.com/menonaki2/wedding-trend)";
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

// ── 収集トリガー（cooldown / lease）────────────────────────────
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
 * `ceremonyDecision`（挙式・披露宴の中身に関する記事か）を満たした場合にのみ
 * 加算するゲート分。他の加点項目の合計（firsthand + specific + tradeoff =
 * 3+2+2=7）を上回る値にすることで、「中身に関する記事」であることを他の
 * 加点の前提条件として機能させ、衣装のみの記事等が逆転して上位に来ることを防ぐ。
 */
export const USEFULNESS_GATE_BONUS = 10;

/** 実体験に基づく記事であることの加点。話題性・宣伝性と同様に抜粋段階で判定しやすいため重め。 */
export const USEFULNESS_WEIGHT_FIRSTHAND = 3;

/** 具体（固有の選択・数字・実際の行動）を含むことの加点。本文中盤以降でないと判定しにくいため firsthand より軽め。 */
export const USEFULNESS_WEIGHT_SPECIFIC = 2;

/** 判断理由・後悔・評価が述べられていることの加点。specific と同様の理由で軽め。 */
export const USEFULNESS_WEIGHT_TRADEOFF = 2;

/** 事業者による集客が主目的の記事に対する減点。ゲート通過後でも上位に出さない編集方針の強さを反映し、他の加点より大きい。 */
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
