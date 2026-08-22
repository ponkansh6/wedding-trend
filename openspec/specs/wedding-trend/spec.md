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
  - SNS 投稿等の URL を受け取り、oEmbed を取得してカード化 (`src/app/api/submit-url/route.ts`, `src/lib/pipeline/submit-url.ts`, `src/lib/embed/oembed.ts`, `src/lib/embed/providers.ts`)
- **AI による見出し・要約生成**:
  - Google Gemini API を用いた一括抽出・サマライズ (`src/lib/llm/client.ts`, `src/lib/llm/batch.ts`, `src/lib/llm/prompts.ts`, `src/lib/llm/schemas.ts`, `src/lib/llm/signature.ts`)
- **定期巡回 API**:
  - `src/app/api/ingest/route.ts` / `src/lib/pipeline/ingest.ts` による一括インジェスト
- **収集トリガー（2 経路）**:
  - UI の取得ボタンから叩く Server Action (`src/app/actions.ts`) と、`vercel.json` の Vercel Cron による定期実行。両者とも実処理は `src/lib/pipeline/ingest.ts` / `src/lib/pipeline/submit-url.ts` に一本化されている（詳細は §6）
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
  - `src/app/api/ingest/route.ts` を呼び出すことで、`src/lib/sources/registry.ts` に登録された各アダプタから RSS データを取得し、データベースに保存する。実処理本体は `src/lib/pipeline/ingest.ts` の `runIngest()` に実装されている。
- **FR-002: 管理者 URL 投入と oEmbed 取得**
  - `src/app/api/submit-url/route.ts` を介して手動で投稿 URL を登録し、`src/lib/embed/oembed.ts` で埋め込みデータを取得して保存する。実処理本体は `src/lib/pipeline/submit-url.ts` の `runSubmitUrl()` に実装されている。
- **FR-003: AI による要約・見出し生成**
  - Google Gemini API (`src/lib/llm/client.ts`) を用い、取得したコンテンツから短尺の要約、カテゴリ、タグ等を抽出・生成する。
- **FR-004: 2レーン構成のフィード表示**
  - `src/app/page.tsx` において、SNS トレンド速報 (`src/components/feed/feed-lane-trend.tsx`) とブログ定番 (`src/components/feed/feed-lane-classic.tsx`) を分けて表示する。
- **FR-005: セキュリティおよび環境検証**
  - `src/middleware.ts` および `src/lib/auth.ts` によるベーシック認証等の保護、`src/lib/constants.ts` や `src/lib/url.ts` 等の共通ユーティリティ。
- **FR-006: 収集トリガーの UI 化と定期実行**
  - `src/app/actions.ts` の Server Action（`triggerIngest` / `submitSnsUrl`）により、UI 上のボタン操作から `src/lib/pipeline/ingest.ts` / `src/lib/pipeline/submit-url.ts` を直接呼び出す。加えて `vercel.json` の Vercel Cron 設定により `GET /api/ingest` を定期実行する。両トリガー経路の詳細・認可モデルは §6 を参照。

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
- **Pipeline modules（実処理の単一実装）**:
  - `src/lib/pipeline/ingest.ts`（`runIngest`）: RSS 巡回 → 正規化 URL での重複排除 → upsert → 未キュレーション/再キュレーション対象の予算内選定 → LLM 一括キュレーション → `revalidateTag(FEED_CACHE_TAG, { expire: 0 })` によるフィードキャッシュ即時失効、までの一連の処理。
  - `src/lib/pipeline/submit-url.ts`（`runSubmitUrl`）: URL 正規化 → oEmbed 取得 → LLM 単体キュレーション（失敗時は原文ベースのフォールバックで `"pending"` 保存）→ upsert → 埋め込み保存 → 同様のキャッシュ失効、までの一連の処理。
  - どちらも「呼び出し元（Route Handler か Server Action か）に依存しない」ことを目的に切り出されており、`src/app/api/ingest/route.ts` / `src/app/api/submit-url/route.ts` および `src/app/actions.ts` はいずれもこれらの薄いラッパーに過ぎない。ロジックを二重実装しないことが本設計の前提。

### §6.1 収集トリガーの 2 経路

収集パイプラインを起動する経路は次の 2 つのみであり、いずれも最終的に上記の pipeline モジュールを呼ぶ。

1. **UI の取得ボタン（Server Action）**: `src/app/actions.ts` の `triggerIngest()` / `submitSnsUrl(url)` を、トップページ上の管理者向けボタン（別コンポーネントが所有）が呼び出す。
2. **Vercel Cron（定期実行）**: `vercel.json` の `crons` 設定により、Vercel が `GET /api/ingest` を定期的に呼び出す（スケジュールは `0 */6 * * *` = 6 時間ごと、UTC 0:00/6:00/12:00/18:00 = JST 9:00/15:00/21:00/翌3:00）。挙動が急変しやすい SNS トレンドを日中〜深夜にかけて数回拾いつつ、Gemini API 呼び出し回数と RSS ソースへの負荷を抑えるための頻度。Vercel の Hobby プランでは Cron の実行頻度が 1 日 1 回に制限される場合があるため、Hobby で運用する場合は `schedule` を `0 21 * * *`（JST 6:00 の 1 日 1 回）に変更すること。
   - `src/app/api/ingest/route.ts` の `GET` ハンドラは単なるヘルスチェック/案内スタブではなく、`POST` と全く同じ認可チェック・同じ `runIngest()` 呼び出しを行う。Vercel Cron は `CRON_SECRET` 環境変数が設定されていれば `Authorization: Bearer <CRON_SECRET>` ヘッダーを自動付与するため、`src/lib/auth.ts` の `isBearerAuthorized` がそのまま両方の HTTP メソッドを検証できる。

### §6.3 収集ソースの採否（2026-08-22 実データ検証）

各アダプタの有効/無効は `src/lib/constants.ts` の対象リストが空かどうかで決まる。
リストが空のアダプタはネットワークアクセスを行わず空配列を返すため、
コードを削除せずに停止・再開できる。`node scripts/check-sources.mjs` は
停止中のソースを死活判定の対象外として扱う。

| ソース            | 状態     | 根拠                                                                                                                                                                                                                       |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google-news`     | 有効     | ドレスのトレンド特集・披露宴の演出トレンド等、企画に最も合致。実データで全 14 件が `trend` に分類された                                                                                                                    |
| `note`            | 有効     | 体験談レーンの主力。7 ハッシュタグで延べ 182 件・ユニーク 146 件（重複約 20%）。実データで 18/20 件が `classic` に分類された                                                                                               |
| `hatena-bookmark` | **無効** | エントリは体験談ではなく議論・炎上寄りに偏る。実データ 6 件は全件 `classic` と分類され「満足度の高い王道・定番」レーンに流入したが、内容が趣旨と合致しなかった。費用感の実データが取れる利点はあるため恒久削除ではなく停止 |
| `ameblo`          | **無効** | エンドポイントは稼働し `blogger.ameba.jp/genres/wedding` から実在ブログを発見できるが、ameblo の「wedding」ジャンルはブログ単位の分類のため、投稿内容は婚活・日記・店舗販促が混在し卒花レポではなかった                    |

実在しない ID やタグをプレースホルダーとして残すと死活監視が「正常」と誤報するため、
未採用のソースは必ず空リストにすること。

### §6.2 管理操作の有効化（ENABLE_ADMIN_CONTROLS）

収集トリガー UI（取得ボタン・SNS URL 投入フォーム）は `ENABLE_ADMIN_CONTROLS` 環境変数で有効/無効を切り替える。判定は `src/app/actions.ts` の `adminControlsEnabled()` が行い、`NODE_ENV !== "production"`（開発環境）では常に有効、本番では `ENABLE_ADMIN_CONTROLS === "1"` のときのみ有効になる。

**実際のアクセス制御は Server Action 側の再検証である。** UI がボタンを描画するかどうかの判定に `adminControlsEnabled()` を使うのは見た目の制御にすぎず、それ自体は防御にならない（Server Action は URL さえ知っていれば UI を経由せず直接呼び出せるため）。そのため `triggerIngest()` と `submitSnsUrl()` は自身の実行時にも必ず `adminControlsEnabled()` を再評価し、無効であれば処理を行わずに `ok: false` と日本語メッセージを返す。UI 側で該当ボタンを非表示にする実装は、この再検証があって初めて意味を持つ補助的な措置として扱うこと。

---

## 7. Test Strategy

### §7.1 Tiered Coverage Targets

| Tier                  | 対象モジュール・ファイル                                                                                                                                                                         | ターゲット網羅率         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Tier 1 純粋ロジック   | `src/lib/url.ts`, `src/lib/llm/signature.ts`, `src/lib/llm/schemas.ts`, `src/lib/constants.ts`                                                                                                   | 95%                      |
| Tier 2 パース・判定   | `src/lib/sources/base/feed-parser.ts`, `src/lib/embed/providers.ts`                                                                                                                              | 85%                      |
| Tier 3 収集アダプタ   | `src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`, `src/lib/sources/base/rss-fetcher.ts`, `src/lib/embed/oembed.ts` | 80%                      |
| Tier 4 LLM 制御       | `src/lib/llm/batch.ts`, `src/lib/llm/client.ts`                                                                                                                                                  | 80%                      |
| Tier 5 API ルート     | `src/app/api/ingest/route.ts`, `src/app/api/submit-url/route.ts`, `src/lib/pipeline/ingest.ts`, `src/lib/pipeline/submit-url.ts`                                                                 | 70%                      |
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
4. **原文テキストが存在しない場合は AI 要約を生成しない**: `src/lib/pipeline/submit-url.ts` の `runSubmitUrl` は、LLM キュレーション（`curateSingle`）を呼び出す前に「要約対象となる原文テキストが存在するか」を判定する。原文テキストとは oEmbed が返すキャプション（`embed.title`）と、運営が投稿時に添える補足メモ（`note`、空白のみは「補足なし」として扱う）の 2 つのみを指す。
   - Instagram のキーなし oEmbed エンドポイント（`graph.facebook.com/.../instagram_oembed`）はキャプション本文を一切返さない（`version` / `provider_name` / `provider_url` / `type` / `width` / `html` のみで `title` が欠落する。2026-08-22 の実リクエストで確認済み）。これに対し YouTube の oEmbed は `title` を返す。
   - 原文テキストが両方とも存在しない場合、`runSubmitUrl` は `curateSingle` を一切呼ばず、`status: "pending"` のまま投稿を保存する（`aiTitle` / `aiSummary` は null のまま）。取得済みの embed（`embedProvider` / `embedHtml` / `embedFetchedAt`）と `url` は保存し、再取得コストを避ける。呼び出し元には安定コード `"needs_source_text"` を返す。
   - `aiTitle` / `aiSummary` が null の投稿は `src/lib/db/query.ts` の `getFeedCards` が除外するため、運営が補足メモを添えて再投入するまでフィードには表示されない（意図した挙動）。
   - 原文テキストが存在する場合（oEmbed にキャプションがある、または運営が補足メモを添えた場合）は、従来通り `curateSingle` によるキュレーションを行う。
