# ウエディング・トレンド ＆ リアルフィード (Wedding Trend & Real Feed) - 仕様書

## 1. Executive Summary

結婚式準備の「今」のトレンドと「リアル」な体験談を、1 分で俯瞰できるキュレーションフィードアプリケーションです。
Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS v4, Drizzle ORM + Turso (libSQL), Google Gemini, Zod, Vitest を採用しています。

本プロジェクトの最大の特長は、**記事本文を一切書かず、公開されている外部の SNS 投稿やブログ記事に対して AI が見出しと短い要約を生成し、元記事・投稿への導線とセットでカード表示する点**にあります。これにより、著作権やハルシネーションのリスクを最小限に抑えつつ、ユーザーに価値あるキュレーションを提供します。

---

## 2. Scope (In / Out)

### In Scope

- **2つのレーンによるキュレーション表示**:
  - 上段: 最新トレンド速報 (`sourceType: "sns"`) — 演出・衣装・DIY等のビジュアル情報
  - 下段: 満足度の高い王道・定番 (`sourceType: "blog"`) — 体験談・費用感・アドバイス
- **自動巡回コレクター**:
  - RSS フィードに基づくブログ・体験談の収集 (`src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`, `src/lib/sources/base/rss-fetcher.ts`, `src/lib/sources/base/feed-parser.ts`, `src/lib/sources/registry.ts`)
- **管理者による URL 投入 API**:
  - SNS 投稿等の URL を受け取り、oEmbed を取得してカード化 (`src/app/api/submit-url/route.ts`, `src/lib/embed/oembed.ts`, `src/lib/embed/providers.ts`)
- **AI による見出し・要約生成**:
  - Google Gemini API を用いた一括抽出・サマライズ (`src/lib/llm/client.ts`, `src/lib/llm/batch.ts`, `src/lib/llm/prompts.ts`, `src/lib/llm/schemas.ts`, `src/lib/llm/signature.ts`)
- **定期巡回 API**:
  - `src/app/api/ingest/route.ts` による一括インジェスト
- **ヘルスチェック**:
  - `src/app/api/health/route.ts`

### Out of Scope

- **本文を生成しない**（最大の制約。外部コンテンツの全文転載や独自記事の執筆は行わない）
- パーソナライズやユーザーごとの嗜好スコアリング（中立的キュレーションのため）
- Instagram / TikTok のハッシュタグ自動スクレイピング（API の規約・仕様上の制約により手動 URL 投入を採用）
- ゼクシィ等の非公開プラットフォームの自動巡回

---

## 3. Functional Requirements

- **FR-001: 記事・投稿の自動巡回とインジェスト**
  - `src/app/api/ingest/route.ts` を呼び出すことで、`src/lib/sources/registry.ts` に登録された各アダプタから RSS データを取得し、データベースに保存する。
- **FR-002: 管理者 URL 投入と oEmbed 取得**
  - `src/app/api/submit-url/route.ts` を介して手動で投稿 URL を登録し、`src/lib/embed/oembed.ts` で埋め込みデータを取得して保存する。
- **FR-003: AI による要約・見出し生成**
  - Google Gemini API (`src/lib/llm/client.ts`) を用い、取得したコンテンツから短尺の要約、カテゴリ、タグ等を抽出・生成する。
- **FR-004: 2レーン構成のフィード表示**
  - `src/app/page.tsx` において、SNS トレンド速報 (`src/components/feed/feed-lane-trend.tsx`) とブログ定番 (`src/components/feed/feed-lane-classic.tsx`) を分けて表示する。
- **FR-005: セキュリティおよび環境検証**
  - `src/middleware.ts` および `src/lib/auth.ts` によるベーシック認証等の保護、`src/lib/constants.ts` や `src/lib/url.ts` 等の共通ユーティリティ。

---

## 4. Non-Functional Requirements

- **NFR-001: 型安全性**: TypeScript strict モードの完全遵守。
- **NFR-002: テストカバレッジ**: 各モジュールレイヤーに応じた厳格なカバレッジ要件の達成。
- **NFR-003: 法的・倫理的安全性の担保**: ゼロクリック要約の回避と、元ソースへの導線・クレジットの強制。
- **NFR-004: パフォーマンス**: Next.js 16 App Router の標準機能を活かした高速なサーバーサイド描画およびキャッシュ制御。

---

## 5. Data Model

データベースは Turso (libSQL) および Drizzle ORM (`src/lib/db/schema.ts`, `src/lib/db/index.ts`, `src/lib/db/query.ts`, `src/lib/db/repository.ts`, `src/lib/db/migrations/0000_stormy_harrier.sql`) によって管理されます。

### `posts` テーブル

主なカラムと定義:

- `id`: 主キー (UUID / Text)
- `title`: 生成された見出し (Text)
- `summary`: 生成された短い要約 (Text)
- `url`: 元記事・投稿のURL (Text, ユニーク制約)
- `source_type`: 情報源の種類 (`"sns"` | `"blog"`)
- `source_name`: 情報源名（例: `"Instagram"`, `"TikTok"`, `"note"`, `"はてなブックマーク"` 等）
- `author_name`: 著作者・アカウント名
- `thumbnail_url`: サムネイル画像URL
- `embed_html`: oEmbedのHTML（保持している場合）
- `category`: カテゴリ
- `tags`: タグ配列/文字列
- `content_hash`: 重複排除用のコンテンツハッシュ
- `curation_signature`: キュレーション署名
- `status`: 公開状態 (`"published"` | `"pending"`)
- `created_at` / `updated_at`: タイムスタンプ

---

## 6. Architecture

- **2-lane design**:
  - SNS トレンド速報レーン: `src/components/feed/feed-lane-trend.tsx`, `src/components/feed/sns-embed.tsx`
  - ブログ定番レーン: `src/components/feed/feed-lane-classic.tsx`, `src/components/feed/feed-card.tsx`
- **Collection pipeline**:
  - `src/lib/sources/registry.ts` -> 各アダプタ (`src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`) -> RSS フェッチャー (`src/lib/sources/base/rss-fetcher.ts`, `src/lib/sources/base/feed-parser.ts`)
- **oEmbed fallback**:
  - `src/lib/embed/oembed.ts` 及び `src/lib/embed/providers.ts` による堅牢な埋め込み取得と障害時フォールバック。

---

## 7. Test Strategy

### §7.1 Tiered Coverage Targets

| Tier                  | 対象モジュール・ファイル                                                                                                                                                                         | ターゲット網羅率         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Tier 1 純粋ロジック   | `src/lib/url.ts`, `src/lib/llm/signature.ts`, `src/lib/llm/schemas.ts`, `src/lib/constants.ts`                                                                                                   | 95%                      |
| Tier 2 パース・判定   | `src/lib/sources/base/feed-parser.ts`, `src/lib/embed/providers.ts`                                                                                                                              | 85%                      |
| Tier 3 収集アダプタ   | `src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`, `src/lib/sources/base/rss-fetcher.ts`, `src/lib/embed/oembed.ts` | 80%                      |
| Tier 4 LLM 制御       | `src/lib/llm/batch.ts`, `src/lib/llm/client.ts`                                                                                                                                                  | 80%                      |
| Tier 5 API ルート     | `src/app/api/ingest/route.ts`, `src/app/api/submit-url/route.ts`                                                                                                                                 | 70%                      |
| Tier 6 データアクセス | `src/lib/db/repository.ts`, `src/lib/db/query.ts`                                                                                                                                                | 65%                      |
| Tier 7 RSC/UI         | `src/app/page.tsx`, `src/app/layout.tsx`, `src/components/**`                                                                                                                                    | 除外 (smoke test で担保) |

---

## 8. Non-Goals

- 独自に結婚式関連記事の本文を作成・執筆すること。
- プラットフォーム独自の非公式スクレイピングによるデータ収集。
- 個別のユーザー嗜好に基づくレコメンド・パーソナライズ。

---

## 9. 法務制約 (Legal Constraints)

1. **元ソースへの導線が最優先 CTA**: すべてのカードにおいて、元投稿・記事へのリンク（または公式埋め込み）を明確なメインアクションとして配置する。
2. **著作者名の必須クレジット**: 引用（著作権法第32条）の要件を満たすため、カード上に著者名・情報源名を必ず表示する。
3. **要約の表現制限**: AI による要約は原文のクリエイティブな表現（言い回し）をそのまま再現せず、客観的な事実や要点の抽出に留める（翻案権・複製権への配慮）。これらは `src/lib/llm/prompts.ts` 内のプロンプトおよび UI 表示において厳格に担保される。
