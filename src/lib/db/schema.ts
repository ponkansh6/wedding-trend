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
 * 現状の唯一の用途は収集トリガーのグローバルクールダウン
 * （key: "last_ingest_at" — `src/lib/pipeline/cooldown.ts` 参照）。
 * 行数がごく少数の想定のため、値の型ごとにカラムを分けず単一の
 * key-value 構造に寄せている。
 */
export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});
