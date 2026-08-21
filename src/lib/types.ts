/**
 * 共有ドメイン型。UI レイヤーとデータ／パイプラインレイヤーの唯一の契約点。
 * ここを変更する場合は必ず両レイヤーを同期させること。
 */

/** カードの出自。トップページの上段/下段のレーン分岐に使う。 */
export type SourceType = "sns" | "blog";

/** LLM が付与する「トレンド」/「定番」バッジ。 */
export type TrendTag = "trend" | "classic";

/** カテゴリ分類。LLM はこの配列のいずれかを必ず返す。 */
export const CATEGORIES = [
  "演出・進行",
  "衣装・ドレス",
  "ヘアメイク・ビューティー",
  "会場・装花",
  "DIY・ペーパーアイテム",
  "費用・節約",
  "準備・段取り",
  "引き出物・ギフト",
  "写真・映像",
  "ゲスト・マナー",
  "その他",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** 埋め込みプロバイダ。"none" はリンクボタンのみで表示する。 */
export type EmbedProvider = "instagram" | "tiktok" | "youtube" | "none";

/** 公開ステータス。v1 は既定で published。将来のワンタップ承認用に予約。 */
export type PostStatus = "pending" | "published" | "rejected";

/**
 * フィードカード 1 件分の表示用 DTO。
 * RSC からクライアントコンポーネントへ渡るためすべてシリアライズ可能な値のみ。
 */
export type FeedCard = {
  id: number;
  sourceType: SourceType;
  /** アダプタ ID（例: "ameblo", "hatena", "instagram"）。 */
  sourceId: string;
  /** 表示用のソース名（例: "アメーバブログ"）。 */
  sourceName: string;
  /** 元ソースの URL。必ず表示動線を確保すること（著作権上の要件）。 */
  url: string;
  /** 元投稿者名。判明した場合は必ずクレジット表示する（著作権上の要件）。 */
  author: string | null;
  /** ISO 8601 文字列。不明な場合は null。 */
  publishedAt: string | null;
  thumbnailUrl: string | null;
  /** LLM 生成タイトル（30 文字以内）。 */
  aiTitle: string;
  /** LLM 生成要約（100〜150 文字目安）。 */
  aiSummary: string;
  category: Category;
  tag: TrendTag;
  embedProvider: EmbedProvider;
  /** oEmbed から取得した HTML。null の場合はリンクボタンにフォールバックする。 */
  embedHtml: string | null;
};
