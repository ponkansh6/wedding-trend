import type { UsefulnessCriteria } from "@/lib/scoring/usefulness";

/**
 * 共有ドメイン型。UI レイヤーとデータ／パイプラインレイヤーの唯一の契約点。
 * ここを変更する場合は必ず両レイヤーを同期させること。
 */
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

/**
 * 公開ステータス。plan 07 §7 により "pending" は廃止（TTL 付き再試行キュー
 * `post_retry_queue` に置き換え）。
 * - "published": 公開中。
 * - "rejected": 公開に至らなかった終端。必ず `drop_reason` を伴う。
 * - "retracted": 一度公開後、客観トリガで自動撤回された状態。自動復帰しない
 *   （sticky）。復帰は人間の判断でのみ行う。
 */
export type PostStatus = "published" | "rejected" | "retracted";

/** `posts.status = "rejected"` の理由コード（plan 07 §7）。 */
export type DropReasonBase =
  | "extraction_insufficient" // Q1 決定的ゲート不合格（`EvidenceFailedCondition` の詳細内訳は `src/lib/sources/article-text.ts` 参照）
  | "title_filter" // M1 タイトルフィルタ
  | "anchor_ungrounded" // M1 topicAnchor の語彙的接地に失敗
  | "anchor_prohibited_term" // topicAnchor に禁止用語・煽り・数値等が含まれる
  | "anchor_redundant_with_title" // topicAnchor がタイトルと完全に重複している
  | "anchor_too_short" // topicAnchor が短すぎる
  | "not_useful" // LLM が有用でないと判定
  | "host_not_allowed" // Q3 allowlist 外
  | "retry_exhausted" // 再試行キューの TTL/回数超過
  | "stale_pending"; // reapStaleNonTerminal による定常収束（旧 pending 含む）

/**
 * `post_removals.reason`（kind="dropped"）に実際に書き込まれる値。
 *
 * `DropReasonBase` の裸の値に加え、`"<base>:<detail>"` 形式（コロン区切り）で
 * 診断用の詳細を付与した値も許容する（例: `extraction_insufficient:link_density`、
 * `retry_exhausted:llm_transient`）。detail 部分の組み立ては
 * `withDropReasonDetail`（`src/lib/db/publication.ts`）に集約し、
 * 呼び出し側で `as DropReason` のような型キャストを増やさないこと。
 */
export type DropReason = DropReasonBase | `${DropReasonBase}:${string}`;

/**
 * `posts.status = "retracted"` の理由コード（plan 07 §5-M4）。
 *
 * `takedown_request` を除く 4 値はすべて客観的トリガ（404/410・robots 変化・
 * ToS 変化・本文ハッシュのドリフト）であり、自動検知パイプラインが機械的な
 * 証拠に基づいて設定する。`takedown_request` だけが例外で、**人間の判断による
 * 撤回**（削除要請の受領、plan 07 §5-M4）を表す。plan 07 §10 は「モデルの意見
 * をトリガとする個別記事の自動撤回」を禁じ、個別＝客観的証拠・集団＝統計的証拠
 * という切り分けを規則としており、`takedown_request` はこの原則に従い**自動
 * トリガからは決して設定されない**（`scripts/retract.mjs` 経由で人間が CLI から
 * 明示的に指定した場合のみ設定される）。
 */
export type RetractionReason =
  | "source_gone" // 404 / 410
  | "robots_disallowed" // robots.txt で不許可に転じた
  | "tos_changed" // K2 / K3 発火
  | "body_changed" // 本文ハッシュの大幅変化
  | "takedown_request"; // 削除要請の受領（人間判断・CLI 専用。自動トリガからは設定されない）

/**
 * `post_publications.body_hash` の種別（plan 07 D3 是正・`post_publication_kind`）。
 * `"body"` = 実際に取得した記事本文のハッシュ（`discovery-ingest.ts`、
 * `HOST_ALLOWLIST` のホストのみ）。`"surrogate"` = 本文を取得しないレーン
 * （rss/evergreen/submit）が代替として入れる `computeContentHash(title, excerpt)`。
 * `"surrogate"` は本文ドリフト判定（`body_changed`）に使ってはならない。
 */
export type BodyHashKind = "body" | "surrogate";

/** 再試行キュー（`post_retry_queue`）のレーン識別子。 */
export type RetryLane = "rss" | "evergreen" | "discovery";

/**
 * 再試行キューから取り出した既存エントリの文脈（plan 07 D5）。
 * `attempts` / `firstQueuedAt` を読み戻さず常に 0 件目として扱うと、
 * TTL・最大試行回数の会計が実行をまたいで蓄積しない（Q4 の
 * 「上限到達分は翌日に回す」約束が空手形になる）。各レーンの
 * enqueue ヘルパ（`enqueueRssRetry` 等）は、初回失敗時は `null`、
 * 再試行キューからの再処理時はこれを渡すことで attempts を正しく
 * インクリメントする。
 */
export type RetryContext = {
  urlHash: string;
  attempts: number;
  firstQueuedAt: string;
};

/** 再試行キューに積む理由。一時的技術障害のみ（§7・§10: 安全チェックへの再試行は禁止）。 */
export type RetryReason = "fetch_transient" | "llm_transient" | "rate_capped";

/** TTL 付き再試行キュー1件分。`src/lib/db/repository.ts` の再試行系関数の入出力型。 */
export type RetryQueueEntry = {
  urlHash: string;
  url: string;
  host: string;
  lane: RetryLane;
  reason: RetryReason;
  attempts: number;
  firstQueuedAt: string;
  nextAttemptAt: string;
  expiresAt: string;
};

/** Q2（K8 yield 崩壊検知）用の、ホスト単位ベースライン集計。 */
export type HostMetricsBaseline = {
  host: string;
  days: number;
  /** published / processed */
  publishRate: number;
  /** promotional / processed */
  promotionalRate: number;
  /** author_present / published */
  authorCoverageRate: number;
};

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
  /** 元記事のオリジナルタイトル（逐語表示）。 */
  originalTitle: string;
  /** 元投稿者名。判明した場合は必ずクレジット表示する（著作権上の要件）。 */
  author: string | null;
  /** ISO 8601 文字列。不明な場合は null。 */
  publishedAt: string | null;
  thumbnailUrl: string | null;
  /** @deprecated aiTitle is deprecated; originalTitle is used instead. */
  aiTitle?: string;
  /** LLM 生成要約（100〜150 文字目安）。 */
  aiSummary: string | null;
  category: Category;
  tag: TrendTag;
  embedProvider: EmbedProvider;
  /** oEmbed から取得した HTML。null の場合はリンクボタンにフォールバックする。 */
  embedHtml: string | null;
  /** 判定根拠: トピックアンカー（≤40字）。根拠未生成なら null。 */
  topicAnchor: string | null;
  /** 判定根拠文（60〜90字）。根拠未生成なら null。 */
  rationaleText: string | null;
  /** 6 boolean の有用性判定。criteria 未保存・解析失敗なら null。 */
  usefulness: UsefulnessCriteria | null;
  /** トピックタグのリスト。 */
  topics?: string[];
};
