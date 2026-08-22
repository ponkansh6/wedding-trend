import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { CATEGORIES } from "@/lib/types";

/**
 * 収集した投稿 1 件分のレコード。
 * - url は正規化済み URL（lowercase + utm_* / fbclid 除去）で UNIQUE。重複排除の要。
 * - aiTitle / aiSummary / category / tag はキュレーション前は null。
 * - status は v1 では既定で "published"（自動公開）。将来ワンタップ承認 UI を
 *   追加してもマイグレーション無しで対応できるよう、列だけ先に用意している。
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
    status: text("status", { enum: ["pending", "published", "rejected"] })
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
