import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core";
import { CATEGORIES } from "@/lib/types";

/**
 * 収集した投稿 1 件分のレコード。
 * - url は正規化済み URL（lowercase + utm_* / fbclid 除去）で UNIQUE。重複排除の要。
 * - aiTitle / aiSummary / category / tag はキュレーション前は null。
 * - status は既定で "published"（自動公開）。"pending" は plan 07 §7 により
 *   廃止済み（TTL 付き再試行キュー `post_retry_queue` に置き換え）。
 * - contentHash / curationSignature は再キュレーションのスキップ判定に使う
 *   （内容が変わっておらず、プロンプト/モデルも変わっていなければ再実行しない）。
 */
export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    url: text("url").notNull().unique(),
    sourceType: text("source_type", { enum: ["sns", "blog"] }).notNull(),
    /** アダプタ ID（例: "hatena-bookmark", "note", "ameblo", "instagram"）。 */
    sourceId: text("source_id").notNull(),
    /** 表示用のソース名（例: "アメーバブログ"）。 */
    sourceName: text("source_name").notNull(),

    originalTitle: text("original_title").notNull(),
    originalExcerpt: text("original_excerpt"),
    author: text("author"),
    thumbnailUrl: text("thumbnail_url"),
    /** ISO 8601 文字列。不明な場合は null。 */
    publishedAt: text("published_at"),

    // ── キュレーション結果（未処理の間は null）──
    aiTitle: text("ai_title"),
    aiSummary: text("ai_summary"),
    category: text("category", { enum: CATEGORIES }),
    tag: text("tag", { enum: ["trend", "classic"] }),

    // ── 埋め込み（SNS レーン）──
    embedProvider: text("embed_provider", { enum: ["instagram", "tiktok", "youtube", "none"] })
      .notNull()
      .default("none"),
    embedHtml: text("embed_html"),
    embedFetchedAt: text("embed_fetched_at"),

    // ── 公開ステータス ──
    // plan 07 §7: "pending" は廃止（TTL 付き再試行キュー `post_retry_queue` に
    // 置き換え、および `reapStaleNonTerminal` による定常的な吸収に置き換え）。
    // "published" と "rejected"（`post_removals` に kind="dropped" の行を伴う
    // 終端棄却）に加え、一度公開後に客観トリガで自動撤回された "retracted"
    // （`post_removals` に kind="retracted" の行を伴う。sticky・自動復帰しない）
    // を持つ。
    //
    // `status` は「読み取り側のフェイルセーフ」であり、副テーブル
    // `post_removals`（真実の源・PK により上書きされない）とは役割が異なる。
    // 両者を併用する理由は `src/lib/db/repository.ts` の `markRetracted` /
    // `markDropped` / `isRemoved` の JSDoc を参照。
    status: text("status", { enum: ["published", "rejected", "retracted"] })
      .notNull()
      .default("published"),

    // ── 再処理スキップ用シグネチャ ──
    contentHash: text("content_hash"),
    curationSignature: text("curation_signature"),

    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    sourceStatusPubIdx: index("idx_source_status_pub").on(
      table.sourceType,
      table.status,
      table.publishedAt,
    ),
    categoryIdx: index("idx_category").on(table.category),
    tagIdx: index("idx_tag").on(table.tag),
    createdAtIdx: index("idx_created_at").on(table.createdAt),
  }),
);

/**
 * アプリケーション全体のメタ情報を保持する key-value テーブル。
 * 行数がごく少数の想定のため、値の型ごとにカラムを分けず単一の
 * key-value 構造に寄せている。現状 4 つの key を持つ
 * （詳細は `src/lib/db/repository.ts` および `src/lib/pipeline/cooldown.ts` 参照）:
 *
 * - `"ingest_cooldown_until"` — 収集トリガーのクールダウンの**期限そのもの**
 *   （起点時刻ではなく絶対時刻の ISO8601 文字列）。`claimIngestSlot()` が
 *   実行開始時に 15 分だけ確保し（claim）、`runIngest()` が実際に Gemini を
 *   呼んでいれば `extendIngestCooldownAfterRun()` が 4 時間へ延長する（extend）。
 * - `"ingest_lease_until"` — 収集パイプラインの実行排他ロック（lease）の期限。
 *   全経路（`/admin` の手動トリガー・Vercel Cron）が実行前に必ず取得し、
 *   実行完了後に解放する。
 * - `"last_cron_ingest_at"` — Vercel Cron 経路が最後に実行された時刻の観測用
 *   記録。cooldown・lease とは独立しており、何の判定にも使われない。
 * - `"last_run_summary"` — 直近の収集ラン結果を保持する JSON 文字列
 *   （`src/lib/pipeline/ingest.ts` の `LastRunSummary`）。他の 3 key と異なり
 *   値は ISO8601 ではなく JSON。
 */
export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/**
 * 体験談レーン（`sourceType: "blog"`）の有用度採点結果（判定項目の保存先）。
 *
 * 本番 Turso が news-watch と DB を共有しており、追加専用の安全装置
 * （`scripts/apply-migrations-remote.mjs`）が `ALTER TABLE` を一切許可しない
 * （`CREATE TABLE` / `CREATE INDEX` のみ許可）ため、判定項目を増やすたびに
 * カラムを追加する設計は採れない。そこで判定項目 6 つを 1 つの JSON カラム
 * `criteria_json` にまとめた（shared_plan/02 の選択肢 C）。これにより、以後の
 * 判定項目の増減は DDL 不要の純粋なコード変更になる。
 *
 * 合計スコアは保存しない。5+1 つのブール値を JSON にし、重み付けは
 * `src/lib/scoring/usefulness.ts` の純関数 `computeUsefulnessScore()` が
 * コード側で行う（表示時に毎回計算）。`criteria_json` のキーは
 * `UsefulnessCriteria` のプロパティ名（`firsthand` / `ceremonyDecision` /
 * `specific` / `weddingDayContent` / `promotional` / `preDecisionOrPhotoShoot`）と一致する。
 *
 * - `postId`: `posts.id`（採点対象の投稿）。
 * - `criteria_json`: 判定項目の JSON 文字列（SQLite に boolean 型が無いため
 *   JSON 内では true/false として表現され、`json_extract(..., '$.x')` で
 *   取り出すと 1/0 になる）。
 * - `signature`: 採点時点の `computeCurationSignature()` の値。`posts` 側の
 *   `curationSignature` と比較し、プロンプト/モデルが変わった記事を再スコア
 *   対象として検出する（混成ヴィンテージ対策）。
 * - `modelId`: 採点した Gemini モデル ID。
 * - `scoredAt`: ISO8601 文字列。
 *
 * 旧 `post_usefulness` テーブルは参照をやめた時点で孤児になる（共有 DB のため
 * ここでは DROP せず、オーナーが手動で削除するか放置するかを判断する）。
 */
export const postUsefulnessCriteria = sqliteTable("post_usefulness_criteria", {
  postId: integer("post_id").primaryKey(),
  criteriaJson: text("criteria_json").notNull(),
  signature: text("signature").notNull(),
  modelId: text("model_id").notNull(),
  scoredAt: text("scored_at").notNull(),
});

export const postRationales = sqliteTable("post_rationales", {
  postId: integer("post_id").primaryKey(),
  topicAnchor: text("topic_anchor").notNull(),
  rationaleText: text("rationale_text").notNull(),
  evidenceSufficient: integer("evidence_sufficient", { mode: "boolean" }).notNull(),
  modelId: text("model_id").notNull(),
  promptVersion: text("prompt_version").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * 公開判断という単一の瞬間に必ず両方書かれる 2 値を同居させたテーブル
 * （plan 07 §6-Q4 / §5-M4）。`posts` への `ALTER TABLE` を避けるため副表方式を
 * 採る（`scripts/apply-migrations-remote.mjs` が共有本番 DB に対して
 * `CREATE TABLE` / `CREATE INDEX` 以外を許可しないため。`post_usefulness_criteria`
 * と同じ理由・同じパターン）。
 *
 * - `publishedAt`: 本システムが公開した時刻（ISO 8601）。元記事側の
 *   `posts.publishedAt` とは別物。Q4（日次公開上限・ホストシェア上限）の
 *   計測基準はこちら。
 * - `bodyHash`: 判定時点の正規化本文のハッシュ（M4 本文ドリフト検知用）。
 *
 * 既存の公開済み post にはこの表に行が無い場合がある（この表を追加する前に
 * 公開された post）。`listPublishedForRevalidation` がそれらを
 * `posts LEFT JOIN post_publications` で拾い、M4 のジョブが自己修復的に
 * シードする（`src/lib/db/repository.ts` 参照）。
 */
export const postPublications = sqliteTable(
  "post_publications",
  {
    postId: integer("post_id")
      .primaryKey()
      .references(() => posts.id),
    publishedAt: text("published_at").notNull(),
    bodyHash: text("body_hash").notNull(),
    textLength: integer("text_length"),
    linkDensity: real("link_density"),
    paragraphCount: integer("paragraph_count"),
  },
  (table) => ({
    publishedAtIdx: index("idx_post_publications_published_at").on(table.publishedAt),
  }),
);

/**
 * 終端棄却（"dropped"）と自動撤回（"retracted"）を表す真実の源（plan 07 §5-M4 /
 * §7）。`postId` を PK にすることで、1 post につき終端理由は 1 つに固定される
 * （dropped と retracted は排他 —— DB 制約として保証する）。
 *
 * **`upsertPostPublications`（本表への書き込みヘルパー）は `INSERT` に
 * `ON CONFLICT DO UPDATE` を書かないこと。** 既に行があれば静かに無視する
 * （`INSERT OR IGNORE` 相当）。「最初の終端理由が勝つ」という不可逆性を
 * エンジン側（PK 制約）に担保させるための意図的な設計であり、上書きロジックを
 * アプリ側に書くとこの不変条件が将来の変更で壊れうる。
 *
 * `status`（`posts.status`）と役割が違う: こちらは単調で上書きされない
 * 「真実の源」。`status` は読み取り側のフェイルセーフ（既存のフィードクエリが
 * 見ている `WHERE status='published'` から自動的に消すための列）。
 * 両者は必ずペアで更新する（`markRetracted` / `markDropped` 参照）。
 */
/**
 * `post_publications.body_hash` が「何の」ハッシュかを区別する副表（plan 07 D3
 * 是正）。`post_publications` は `posts` への `ALTER TABLE` を避けるための副表
 * 方式で作られており（同じ理由でこの表にも列を後から足せない）、`body_hash`
 * の意味は書き込むレーンによって異なる:
 *
 * - `"body"`: `discovery-ingest.ts`（`HOST_ALLOWLIST` のホストのみ）が実際に
 *   取得した記事本文の正規化フィンガープリント。M4 の本文ドリフト検知
 *   （`body_changed` による自動撤回）はこの種別に対してのみ意味を持つ。
 * - `"surrogate"`: `ingest.ts` / `evergreen.ts` / `submit-url.ts`（RSS/evergreen/
 *   submit の各レーン）は記事本文を一切取得しないため、代替として
 *   `computeContentHash(title, excerpt)` を入れている。これは本文の変化を
 *   検知できない（タイトル・抜粋が変わらない限り不変）ため、ドリフト判定に
 *   使ってはならない。
 *
 * この区別が無いと、`listPublishedForRevalidation` がレーンを問わず
 * `status="published"` の全 post を返すことと相まって、`surrogate` ハッシュを
 * 持つ post が本文ドリフト判定にかけられ、保存値（title+excerpt 由来）と
 * 再取得後の実ハッシュ（本文由来）が構造的に一致せず誤って自動撤回される
 * （plan 07 D3）。呼び出し側（`revalidatePublishedPosts`）はこの表と
 * `HOST_ALLOWLIST` の両方でホストを確認したうえで `"body"` の post にのみ
 * ドリフト判定を適用する。
 */
export const postPublicationKinds = sqliteTable("post_publication_kind", {
  postId: integer("post_id")
    .primaryKey()
    .references(() => posts.id),
  hashKind: text("hash_kind", { enum: ["body", "surrogate"] }).notNull(),
});

export const postRemovals = sqliteTable(
  "post_removals",
  {
    postId: integer("post_id")
      .primaryKey()
      .references(() => posts.id),
    kind: text("kind", { enum: ["dropped", "retracted"] }).notNull(),
    reason: text("reason").notNull(),
    removedAt: text("removed_at").notNull(),
  },
  (table) => ({
    removedAtIdx: index("idx_post_removals_removed_at").on(table.removedAt),
  }),
);

export const discoverySeen = sqliteTable(
  "discovery_seen",
  {
    host: text("host").notNull(),
    urlHash: text("url_hash").primaryKey(),
    url: text("url").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    sitemapLastmod: text("sitemap_lastmod"),
    status: text("status", { enum: ["pending", "fetched", "skipped"] }).notNull(),
  },
  (table) => ({
    hostStatusIdx: index("idx_discovery_seen_host_status").on(table.host, table.status),
  }),
);

export const discoveryRun = sqliteTable(
  "discovery_run",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    host: text("host").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    sitemapsFetched: integer("sitemaps_fetched").notNull(),
    urlsNew: integer("urls_new").notNull(),
    urlsFetched: integer("urls_fetched").notNull(),
    statusCounts: text("status_counts").notNull(),
    outcome: text("outcome").notNull(),
  },
  (table) => ({
    hostStartedIdx: index("idx_discovery_run_host").on(table.host, table.startedAt),
  }),
);

export const sourcePolicy = sqliteTable("source_policy", {
  host: text("host").primaryKey(),
  robotsHash: text("robots_hash").notNull(),
  robotsBody: text("robots_body").notNull(),
  tosUrl: text("tos_url"),
  tosHash: text("tos_hash"),
  checkedAt: text("checked_at").notNull(),
});

/**
 * ホスト単位のアクセス規律（kill gate）状態。`config` KV が ISO 8601 カーソル
 * 専用であるため、非 ISO の状態値（gate 識別子・ストライク数・日次カウンタ）
 * はこちらに永続化する。
 *
 * - `stateKind`: `null` = 稼働中 / `"cooloff"` = 一時停止（`untilAt` まで）/
 *   `"stopped"` = K1 由来の人手復帰待ち / `"permanent"` = 恒久停止
 * - `countDay` / `countValue`: B1 日次リクエスト予算のカウンタ（UTC 日付キー）
 */
export const hostGateState = sqliteTable("host_gate_state", {
  host: text("host").primaryKey(),
  gateId: text("gate_id"),
  stateKind: text("state_kind"),
  untilAt: text("until_at"),
  k4Strikes: integer("k4_strikes").notNull().default(0),
  last429At: text("last_429_at"),
  countDay: text("count_day").notNull().default(""),
  countValue: integer("count_value").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

/**
 * plan 07 §7: `pending` 廃止に伴う TTL 付き再試行キュー。
 * 一時的技術障害（timeout / 5xx / 429 等）のみをここに積む。抽出不足・接地失敗・
 * 判定不一致は再試行禁止で即終端棄却（`posts.status = "rejected"`）とし、
 * このキューには入れない（§7・§10 の明示的な禁止事項）。
 *
 * - `urlHash`: `hashUrl(url)`（`src/lib/db/repository.ts`）。PK。
 * - `attempts`: 現在までの再試行回数。`RETRY_MAX_ATTEMPTS` を超えたら
 *   `expireRetries` の対象（TTL 超過と同様に扱う）。
 * - `nextAttemptAt`: 次回再試行可能になる時刻（ISO 8601）。指数バックオフ
 *   （`RETRY_BACKOFF_HOURS`）で計算する。
 * - `expiresAt`: このエントリの絶対 TTL（ISO 8601、`RETRY_TTL_HOURS`）。
 *   これを超えたキューエントリは `expireRetries` が削除し、呼び出し元が
 *   `posts.status = "rejected"`（`drop_reason = "retry_exhausted"`）を確定させる。
 */
export const postRetryQueue = sqliteTable(
  "post_retry_queue",
  {
    urlHash: text("url_hash").primaryKey(),
    url: text("url").notNull(),
    host: text("host").notNull(),
    lane: text("lane", { enum: ["rss", "evergreen", "discovery", "submit"] }).notNull(),
    reason: text("reason", {
      enum: ["fetch_transient", "llm_transient", "rate_capped"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    firstQueuedAt: text("first_queued_at").notNull(),
    nextAttemptAt: text("next_attempt_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => ({
    dueIdx: index("idx_post_retry_queue_due").on(table.nextAttemptAt),
  }),
);

export const discoveryHostMetrics = sqliteTable(
  "discovery_host_metrics",
  {
    host: text("host").notNull(),
    day: text("day").notNull(),
    processed: integer("processed").notNull().default(0),
    published: integer("published").notNull().default(0),
    dropped: integer("dropped").notNull().default(0),
    promotional: integer("promotional").notNull().default(0),
    authorPresent: integer("author_present").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.host, table.day] }),
  }),
);

/**
 * plan 10 I2: シャドウ記録（オブザーベーション・モード）用のエビデンスシグナル観測データ。
 * 判定ゲートを通ったか否かに関わらず、すべての処理対象記事のシグナル値を保持する。
 * 将来の閾値キャリブレーション・分布調査のための非破壊的記録用テーブル。
 */
export const evidenceSignalObservations = sqliteTable(
  "evidence_signal_observations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    urlHash: text("url_hash").notNull(),
    host: text("host").notNull(),
    textLength: integer("text_length").notNull(),
    linkDensity: real("link_density").notNull(),
    paragraphCount: integer("paragraph_count").notNull(),
    passedGate: integer("passed_gate", { mode: "boolean" }).notNull(),
    failedConditions: text("failed_conditions"),
    observedAt: text("observed_at").notNull(),
  },
  (table) => ({
    urlHashIdx: index("idx_evidence_signal_observations_url_hash").on(table.urlHash),
  }),
);
