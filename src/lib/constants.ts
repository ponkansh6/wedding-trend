/**
 * 全チューニング値の集約ファイル。
 * lib 配下のコードにマジックナンバーを直書きしない — 必ずここに定数化する。
 */

// ── LLM (Gemini) ──────────────────────────────────────────────
/** キュレーションに使う Gemini モデル ID。 */
export const LLM_MODEL = "gemini-3.1-flash-lite";
/** 生成温度。低めにして事実からの逸脱・創作的表現を抑える。 */
export const LLM_GEN_TEMPERATURE = 0.2;
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
/** プロンプト本文を変更したら bump する（curationSignature に反映）。 */
export const CURATION_PROMPT_VERSION = 1;

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
/** getFeedCards の unstable_cache タグ。ingest / submit-url からの revalidateTag に使う。 */
export const FEED_CACHE_TAG = "feed-cards";

// ── HTTP ステータス ───────────────────────────────────────────
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_SERVER_ERROR_MIN = 500;

// ── ログ ──────────────────────────────────────────────────────
export const DEBUG_LOG_TRUNCATE_LENGTH = 100;

// ── 管理者が編集する取得元リスト ───────────────────────────────
/** Hatena Bookmark タグ検索の対象タグ。 */
export const HATENA_BOOKMARK_TAGS = ["結婚式", "結婚式準備", "卒花"] as const;
/** Google News 検索クエリ（ウエディング関連）。 */
export const GOOGLE_NEWS_QUERIES = ["結婚式 トレンド", "ウエディング 演出"] as const;
/**
 * note.com のハッシュタグ RSS (https://note.com/hashtag/{tag}/rss) は
 * 実開発時に実リクエストで動作確認済み（RSS 2.0 を返す）。
 * 管理者がここにタグを追加/削除することで取得元を調整する。
 */
export const NOTE_HASHTAGS: readonly string[] = ["結婚式", "卒花", "ウエディング"];
/**
 * アメーバブログの個別ブログ RSS (https://rssblog.ameba.jp/{blogId}/rss.html) を
 * 購読する対象ブログ ID。エンドポイント自体（RDF 形式で返る）は実リクエストで
 * 動作確認済みだが、以下の ID はプレースホルダーであり実在のウエディング系
 * ブログではない。管理者が実際に活動中のブログ ID に差し替えて運用する。
 */
export const AMEBLO_BLOG_IDS: readonly string[] = ["wedding-diary", "hanayome-note"];
