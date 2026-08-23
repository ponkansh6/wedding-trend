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
  - `/admin`（`src/middleware.ts` の Basic 認証配下。オーナー限定）から叩く Server Action (`src/app/actions.ts`) と、`vercel.json` の Vercel Cron による定期実行。両者とも実処理は `src/lib/pipeline/ingest.ts` / `src/lib/pipeline/submit-url.ts` に一本化されている（詳細は §6）。収集ボタンは以前、無認証で本番の公開トップページに置かれていたが、デプロイをまたいで残る ISR の stale ページが原因の誤解（「体験談 0 件なのに更新制限」）をきっかけに `/admin` へ移した。加えて、両経路とも同時実行を防ぐ排他ロック（lease）と、`/admin` 経路のみ連打防止のクールダウンを DB 側で必ず取得する（`src/lib/pipeline/cooldown.ts`。詳細は §6.4）
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
  - `src/middleware.ts` および `src/lib/auth.ts` によるベーシック認証等の保護、`src/lib/constants.ts` や `src/lib/url.ts` 等の共通ユーティリティ。`src/lib/auth.ts` の `isBearerAuthorized` は **fail-closed**: 検証用の secret（既定 `CRON_SECRET`）が未設定の場合、実行環境（`NODE_ENV` / `VERCEL_ENV` 等）によらず常にリクエストを拒否する。環境によって認証ロジックが変わる設計（未設定時はローカル開発向けに無認証で許可する fail-open）を避けるための意図的な制約であり、ローカル開発でも `.env.local` に secret を設定しない限り `/api/ingest` `/api/submit-url` は 401 を返す。
- **FR-006: 収集トリガーの管理画面化と定期実行**
  - `src/app/actions.ts` の Server Action（`triggerIngest` / `submitSnsUrl`）により、`/admin`（`src/middleware.ts` の Basic 認証配下・オーナー限定）上のボタン操作から `src/lib/pipeline/ingest.ts` / `src/lib/pipeline/submit-url.ts` を直接呼び出す。加えて `vercel.json` の Vercel Cron 設定により `GET /api/ingest` を定期実行する。両トリガー経路の詳細・認可モデルは §6 を参照。
- **FR-007: 収集トリガーの排他ロックとクールダウン**
  - 収集パイプラインを起動する両経路（`/admin` の手動トリガー・Cron）は、`src/lib/pipeline/cooldown.ts` の `acquireIngestLease()` により実行排他ロック（lease）を必ず取得する。取得できなければ「実行中」として `runIngest()` を呼ばずに返す（`/admin` 経路では `IngestResult.busy: true`）。加えて `/admin` 経路のみ、`claimIngestSlot()` により 15 分のクールダウンを DB 側で原子的に確保し、`runIngest()` が実際に Gemini を呼んでいれば `extendIngestCooldownAfterRun()` が 4 時間へ延長する。クールダウン中は lease を解放し `runIngest()` を呼ばずに待機状態を返す。詳細は §6.4 を参照。

---

## 4. Non-Functional Requirements

- **NFR-001: 型安全性**: TypeScript strict モードの完全遵守。
- **NFR-002: テストカバレッジ**: 各モジュールレイヤーに応じた厳格なカバレッジ要件の達成。
- **NFR-003: 法的・倫理的安全性の担保**: ゼロクリック要約の回避と、元ソースへの導線・クレジットの強制。
- **NFR-004: パフォーマンス**: Next.js 16 App Router の標準機能を活かした高速なサーバーサイド描画およびキャッシュ制御。

---

## 5. Data Model

データベースは Turso (libSQL) および Drizzle ORM (`src/lib/db/schema.ts`, `src/lib/db/index.ts`, `src/lib/db/query.ts`, `src/lib/db/repository.ts`, `src/lib/db/migrations/0000_stormy_harrier.sql`, `src/lib/db/migrations/0001_supreme_dark_phoenix.sql`, `src/lib/db/migrations/0002_dry_forge.sql`) によって管理されます。

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

### `config` テーブル

アプリケーション全体のメタ情報を保持する key-value テーブル（`src/lib/db/schema.ts`）。
現状 4 つの key を持つ:

- `key: "ingest_cooldown_until"` — クールダウンの**期限そのもの**（起点時刻ではなく
  絶対時刻の ISO8601 文字列）。`/admin` の手動トリガー経路のみが評価する。
  `claimIngestSlot()` が実行開始時に 15 分だけ確保し（claim）、`runIngest()` が
  実際に Gemini を呼んでいれば `extendIngestCooldownAfterRun()` が 4 時間へ
  延長する（extend）。
- `key: "ingest_lease_until"` — 現在保持されているリース（実行排他ロック）の
  期限（ISO8601 文字列）。全経路（`/admin` の手動トリガー・Cron）が実行前に
  必ず取得し、実行完了後に解放する。
- `key: "last_cron_ingest_at"` — Vercel Cron 経路が最後に実行された時刻の
  観測用記録。cooldown・lease とは独立しており、何の判定にも使われない。
- `key: "last_run_summary"` — 直近の収集ラン結果を保持する JSON 文字列
  （`src/lib/pipeline/ingest.ts` の `LastRunSummary`）。`/admin` の
  `IngestStatusPanel` の表示に使う。他の 3 key と異なり値は ISO8601 ではなく
  JSON（`value` の一般則の例外。`assertIso8601` の検証をスキップする）。

詳細は §6.4 を参照。

- `key`: 主キー (Text)
- `value`: 値。ISO8601 文字列で文字列比較の大小判定が成立する形式に統一する
  （`last_run_summary` のみ JSON 文字列で例外） (Text)
- `updated_at`: タイムスタンプ (Text)

### `post_usefulness_criteria` テーブル（体験談レーンの有用度採点結果）

体験談レーン（`sourceType: "blog"`）の掲載順を決めるための採点結果を保持する
（判定項目・重み・掲載順ルールの詳細は §9 編集方針を参照）。`posts` へのカラム
追加ではなく別テーブルにしているのは、本番 Turso が news-watch と DB を共有
しており、追加専用の安全装置 (`scripts/apply-migrations-remote.mjs`) が
`ALTER TABLE` を含む文を一切許可しない（`CREATE TABLE` / `CREATE INDEX` の
みを許可し、それ以外が現れると exit 1 する）ためである。さらに、将来的な
判定項目の追加・変更に際して DDL の変更（マイグレーション）を不要にするため、
判定結果は個別のカラムではなく単一の JSON カラム `criteria_json` にシリアライズ
して保存する設計（shared_plan/02 案C）を採用している。

- `post_id`: `posts.id` と同じ型（Integer）の主キー。採点対象の投稿。
- `criteria_json`: 6つの判定項目（`UsefulnessCriteria` 型）のブール値オブジェクトを
  `JSON.stringify()` したテキスト（`firsthand`, `ceremonyDecision`, `specific`, `tradeoff`, `promotional`, `preDecisionOrPhotoShoot`）。
- `signature`: 採点時点の `computeCurationSignature()`（`src/lib/llm/signature.ts`）
  の値。`posts.curation_signature` と比較し、プロンプト/モデルが変わった
  記事を再スコア対象として検出する。
- `model_id`: 採点した Gemini モデル ID。
- `scored_at`: ISO8601 文字列（`config` / `posts` と同じ規約）。

**合計スコアはこのテーブルに保存しない。** 重みは `src/lib/scoring/usefulness.ts`
の純関数 `computeUsefulnessScore()` に置き、DB には判定項目 6 つの JSON オブジェクト
のみを保存する設計とした。合計スコアを保存すると、重みを調整するたびに
既存データのマイグレーションが必要になってしまうため、表示時に毎回その場で
計算する。旧 `post_usefulness` テーブルは過去のマイグレーション履歴に残るが実運用では
使用されず孤立している（削除しない）。

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
  - `src/lib/pipeline/ingest.ts`（`runIngest`）: RSS 巡回 → 正規化 URL での重複排除 → upsert → 未キュレーション/再キュレーション対象の予算内選定 → LLM 一括キュレーション、までの一連の処理。`/` は `export const dynamic = "force-dynamic"` でキャッシュを経由しないため、以前ここにあったフィードキャッシュの明示的失効（`revalidateTag`）は不要になった（詳細は §6.5）。
  - `src/lib/pipeline/submit-url.ts`（`runSubmitUrl`）: URL 正規化 → oEmbed 取得 → LLM 単体キュレーション（失敗時は原文ベースのフォールバックで `"pending"` 保存）→ upsert → 埋め込み保存、までの一連の処理。
  - どちらも「呼び出し元（Route Handler か Server Action か）に依存しない」ことを目的に切り出されており、`src/app/api/ingest/route.ts` / `src/app/api/submit-url/route.ts` および `src/app/actions.ts` はいずれもこれらの薄いラッパーに過ぎない。ロジックを二重実装しないことが本設計の前提。

### §6.1 収集トリガーの 2 経路

収集パイプラインを起動する経路は次の 2 つのみであり、いずれも最終的に上記の pipeline モジュールを呼ぶ。

1. **`/admin` の収集ボタン（Server Action）**: `src/app/actions.ts` の `triggerIngest()` / `submitSnsUrl(url)` を、`src/app/admin/page.tsx` 上のボタン（`src/components/admin/ingest-status-panel.tsx` / `src/components/admin/operator-panel.tsx`）が呼び出す。`/admin/:path*` は `src/middleware.ts` が Basic 認証（`ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD`）で保護しており、オーナー限定の操作である。UI・ミドルウェアだけでは防御にならないため、`triggerIngest()` / `submitSnsUrl()` はそれ自身の実行時にも `src/lib/auth.ts` の `isBasicAuthorized()` で同じ資格情報を再検証する多層防御を取る（§6.2 参照）。`triggerIngest()` の濫用防止はこれに加えて §6.4 の lease（排他ロック）と DB クールダウンが担う。
2. **Vercel Cron（定期実行）**: `vercel.json` の `crons` 設定により、Vercel が `GET /api/ingest` を定期的に呼び出す（スケジュールは `0 21 * * *` = UTC 21:00、JST 6:00 の 1 日 1 回）。本番は Vercel Hobby プランで運用しており、Hobby は Cron の実行頻度が 1 日 1 回までに制限される（それを超えるスケジュールを指定すると `vercel deploy` 自体が拒否され、デプロイが失敗する）ため、この頻度としている。
   - `src/app/api/ingest/route.ts` の `GET` ハンドラは単なるヘルスチェック/案内スタブではなく、`POST` と全く同じ認可チェック・同じ `runIngest()` 呼び出しを行う。Vercel Cron は `CRON_SECRET` 環境変数が設定されていれば `Authorization: Bearer <CRON_SECRET>` ヘッダーを自動付与するため、`src/lib/auth.ts` の `isBearerAuthorized` がそのまま両方の HTTP メソッドを検証できる。**`CRON_SECRET` が未設定の場合、この経路は fail-closed により常に 401 を返す**（詳細は §6.4 直前の認証方針、および `src/lib/auth.ts` を参照）。
   - この経路は `/admin` 経路のクールダウンの**評価・更新のどちらにも触れない**が、**lease（排他ロック）は迂回しない**。`acquireIngestLease()` に失敗した場合（＝`/admin` 経路や他の Cron 呼び出しが実行中）は `runIngest()` を呼ばずに `409` を返す。代わりに、Cron が最後にいつ動いたかを観測するためだけの独立したキー `last_cron_ingest_at` を無条件で記録する（`config` の他のキーとは独立しており、何の判定にも使われない）。

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

### §6.2 管理操作の認可モデル（Basic 認証・多層防御）

収集トリガー（`triggerIngest`）・SNS URL 投入（`submitSnsUrl`）はいずれも `/admin` 配下（オーナー限定）に置かれ、同一の認可モデルを共有する。以前は 2 つの異なる仕組み（収集ボタン: 無認証で公開 + DB クールダウンのみ、URL 投入: `ENABLE_ADMIN_CONTROLS` 環境変数フラグ）を使い分けていたが、収集ボタンを `/admin` へ移したことで両者を Basic 認証に一本化した。`ENABLE_ADMIN_CONTROLS` は廃止し、`adminControlsEnabled()` は削除した。

**多層防御は 2 段構成**:

1. **ミドルウェア（入口）**: `src/middleware.ts` が matcher `/admin/:path*` で Basic 認証（`ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD`）を強制する。Edge ランタイムのため Web Crypto (`crypto.subtle`) でタイミングセーフに比較する。未設定の場合、本番環境は `503`、開発環境は無認証で通す（`NODE_ENV` で分岐。ページの入口としてローカル開発の利便性を優先している）。
2. **Server Action（多層防御）**: `src/lib/auth.ts` の `isBasicAuthorized()` が `triggerIngest()` / `submitSnsUrl()` それぞれの実行時にも同じ資格情報を再検証する。**実際のアクセス制御はこの再検証である**。ミドルウェアだけでは防御にならない（Server Action は URL さえ知っていれば UI・ミドルウェアを経由せず直接呼び出せるため）。`isBasicAuthorized()` は `isBearerAuthorized`（CRON_SECRET）と同じ **fail-closed** 方針を取り、環境変数が未設定なら無条件に拒否し、`NODE_ENV` によって認証ロジックを分岐させない。**そのためミドルウェアと異なり、ローカル開発でも `ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD` を設定しない限り、収集ボタン・SNS URL 投入フォームの実行は常に失敗する**（詳細は `.env.local.example`）。認証に失敗した場合、両 Server Action とも生の認証エラーの内部情報を含まない固定文言（`ADMIN_DISABLED_MESSAGE`）を返す。

Server Action 自身（Node ランタイム）は `node:crypto` の `timingSafeEqual` を使い、ミドルウェア（Edge ランタイム）とはロジックが別実装になる。ランタイム制約により一本化できない。

### §6.4 収集トリガーの排他ロック（lease）とクールダウン（cooldown: claim + extend の 2 段階）

`/admin` はミドルウェア＋ Server Action の Basic 認証で保護されているが（§6.2）、認証済みのオーナーであっても、複数タブでの連打や Gemini API 予算の焼き付きは防ぐ必要がある。`src/lib/pipeline/cooldown.ts` は目的の異なる 2 つの機構を組み合わせてこれをサーバー側で強制する。**この 2 つは互いに独立した概念であり、混同しないこと**。

| 機構     | 何を守るか                      | 対象経路                                             | key（`config` テーブル） | 幅                                                                                         |
| -------- | ------------------------------- | ---------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| lease    | **同時実行の禁止**（排他）      | `/admin` の手動トリガー・Cron の**両方**             | `ingest_lease_until`     | `INGEST_LEASE_TTL_MS`（2 分）                                                              |
| cooldown | **連打防止・Gemini 予算の保護** | **`/admin` の手動トリガー経路のみ**（Cron は対象外） | `ingest_cooldown_until`  | `INGEST_BASE_COOLDOWN_MS`（15 分）→ `INGEST_FULL_COOLDOWN_MS`（4 時間、Gemini 使用時のみ） |

#### lease（排他ロック）

「今まさに `runIngest()` を実行しているのは高々 1 経路だけ」を保証する。**全経路（`/admin` の手動トリガー・Cron）が実行前に必ず取得し、実行完了後（成功・失敗いずれも）に必ず解放する。**

- **`INGEST_LEASE_TTL_MS`**: リースの TTL（2 分 = `2 * 60 * 1000` ミリ秒）。`runIngest()` の実測実行時間は長くても 60 秒程度（Route Handler / Server Action の `maxDuration` も 60 秒）であるため、タイムアウトやクラッシュでリースが解放されないまま残っても、この程度の余裕で十分に回復できる（以前は 10 分だったが、`maxDuration` に対して過剰に長く、不必要な機会損失を生んでいたため縮小した）。
- **`acquireIngestLease(now?)`**: リースの原子的な取得。`src/lib/db/repository.ts` の `claimIngestLease()` が発行する単一の `INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE config.value <= ?` により、保存されているリース期限が現在時刻以下（＝期限切れ）の場合にのみ、新しいリース期限（`now + INGEST_LEASE_TTL_MS`）で上書きして true を返す。取得に失敗したら false（＝別の経路が実行中）。
- **`releaseIngestLease(now?)`**: リース期限を過去日時で無条件上書きし、即座に解放する。取得に成功した経路は `finally` で必ず呼ぶこと。

#### cooldown（claim → extend の 2 段階）

**`/admin` の手動トリガー経路のみ**に課す。Cron 経路はクールダウンの評価・更新のどちらにも一切触れない（1 日 1 回しか叩かれない Cron の実行有無と、認証済みの手動実行を短時間に連打しないためのこのクールダウンの間に本来因果関係はないため）。代わりに Cron は独立した観測用キー `last_cron_ingest_at` を無条件で記録する（§6.1 参照）。

`config.ingest_cooldown_until` は「クールダウンの起点時刻」ではなく**期限そのもの**（絶対時刻の ISO8601 文字列）を保持する。読み取り（`getCooldownUntil`）は保存値と `now` を比較するだけで、算術（時刻の加算）を一切行わない。

- **`claimIngestSlot(now?)`**: 実行開始時に `INGEST_BASE_COOLDOWN_MS`（15 分）だけ確保する（claim）。目的は Gemini 予算の保護ではなく、同時多重実行の防止と空振り実行（新着ゼロ等で Gemini を一切呼ばなかった実行）の連打防止。`src/lib/db/repository.ts` の `claimIngestCooldown()` が発行する単一の条件付き `INSERT ... ON CONFLICT DO UPDATE ... WHERE` により、保存済みの値が `now` 以下（＝期限切れ、または行が存在しない）のときだけ `now + INGEST_BASE_COOLDOWN_MS` を書き込んで `{ claimed: true, cooldownUntil }` を返す。経過していなければ DB を書き換えずに `{ claimed: false, cooldownUntil }` を返す。`ClaimResult` は `{ claimed: boolean; cooldownUntil: string }`。奪取に失敗した場合の `cooldownUntil` は `getCooldownUntil()` に計算を委譲しており、重複実装しない。この関数は**呼び出し前に lease を取得済みであることが前提**。
- **`extendIngestCooldownAfterRun(claimedCooldownUntil, geminiCalls, now?)`**: ラン完了後、`runIngest()` が実際に Gemini を呼んでいれば（`geminiCalls > 0`）クールダウンを `INGEST_FULL_COOLDOWN_MS`（4 時間）へ延長する。Gemini 予算の保護という実質的なレートリミットはこちらが担う（`claimIngestSlot()` の 15 分は空振り用の短い間隔に過ぎない）。延長は `src/lib/db/repository.ts` の `extendIngestCooldown()` による **CAS（Compare-And-Swap）** で行う: `claimedCooldownUntil`（`claimIngestSlot()` が返した値）と保存済みの値が完全一致し、かつ新しい値の方が新しい（単調増加）ときのみ書き換える。これにより、自分の claim 後に他の呼び出しが新たに cooldown を確保していた場合にそれを無条件延長で上書きしてしまう事故と、期限を短縮する方向への書き込み事故の両方を防ぐ。戻り値は持たない（void）ため、延長後の実際の値を知りたい呼び出し元は `getCooldownUntil()` を読み直す（`src/app/actions.ts` の `resolveCooldownAfterRun()` を参照）。
- **`getCooldownUntil(now?)`**: 読み取り専用。実行はせず、現在のクールダウン状態（クールダウン中でなければ `null`）を返す。`/admin` の初期描画（`src/app/actions.ts` の `getIngestCooldown()`）に使う。

#### 読み取り＝フェイルソフト／書き込み＝fail-closed（`config` テーブル未作成時の非対称な挙動）

`config` テーブルが存在しない環境（マイグレーション未適用の本番、`scripts/smoke-test.sh` が意図的に空にする DB 等）では、`src/lib/db/repository.ts` の読み取り関数と書き込み関数を**意図的に非対称**に扱う。

- **読み取り（`getIngestCooldownValue()` / `readLastRunSummary()`）はフェイルソフト**: クエリが失敗したら（`src/lib/db/query.ts` の `getFeedCards` と同じ `try/catch` + `console.warn` + 安全側デフォルトのパターンで）例外を投げずに `null` を返す。`null` は「一度も実行していない／未保存」を意味し、テーブルが無い状態は意味的にもこれと一致する。これにより `getCooldownUntil()` → `getIngestCooldown()` と伝播して `{ cooldownUntil: null }` になり、`src/app/admin/page.tsx` の初期描画がテーブル未作成でもクラッシュしない。
- **書き込み（`claimIngestCooldown()` / `extendIngestCooldown()` / `claimIngestLease()` / それらが経由する `writeConfigValue()`）は fail-closed のまま**: 例外を握りつぶさず、そのまま呼び出し元に伝播させる。ここを読み取りと同様にフェイルソフトにしてしまうと、テーブルが無い環境で「クールダウン/lease の取得（＝書き込み）に成功した」と誤認し、濫用防止（レートリミット・排他ロック）そのものが丸ごと無効化されてしまうため。
- `triggerIngest()`（`src/app/actions.ts`）は `acquireIngestLease()` / `claimIngestSlot()` / `extendIngestCooldownAfterRun()` の呼び出しをそれぞれ `try/catch` で囲み、これらが例外を投げても Server Action 自体は未処理例外で落とさず、安全な `IngestResult` を返す。生の例外は `console.error` にのみ出力する。

#### 両経路の実行順序

```
0. /admin の手動トリガー経路のみ: Basic 認証の再検証（isBasicAuthorized）
   失敗 → 認証エラーとして即座に返す（lease/cooldown に一切触れない）
1. lease 取得（acquireIngestLease）
   失敗 → 「実行中」として即座に返す（runIngest() を呼ばない）
2. /admin の手動トリガー経路のみ: cooldown 判定（claimIngestSlot、15分を確保）
   クールダウン中 → lease を解放して返す（runIngest() を呼ばない）
3. runIngest("manual" | "cron") 実行
4. /admin の手動トリガー経路のみ: Gemini を実際に呼んでいれば cooldown を
   4時間へ延長（extendIngestCooldownAfterRun）。呼んでいなければ15分のまま。
   runIngest() が例外を投げた場合は Gemini を呼んだ可能性を否定できないため、
   安全側に倒し無条件で4時間へ延長する（予算保護を優先する判断）。
5. finally で lease を解放（releaseIngestLease）
```

- `triggerIngest()`（`src/app/actions.ts`）は上記を実装し、`IngestResult` で 4 つの終端状態を区別する: 認証失敗（`ran: false, busy: false, cooldownUntil: null`）、lease 取得失敗（`busy: true, ran: false`）、cooldown 中の見送り（`busy: false, ran: false, errors: []`）、実行（`ran: true`。成功時 `ok: true` で `errors` は `runIngest()` の `summary.errors` を件数のみに要約したもの、例外時 `ok: false` で `errors` は固定文言 `["収集処理でエラーが発生しました。時間をおいてお試しください。"]`）。
- `src/app/api/ingest/route.ts`（Cron・curl 経路）は lease 取得失敗時に `409` を返す。cooldown の評価・更新は一切行わない。

#### 公開面への例外メッセージの非漏洩

`runIngest()` や `triggerIngest()` の `try/catch` が投げる例外（Gemini SDK / libSQL / undici 等）の `message` にはホスト名・URL・リクエスト断片が混ざり得るため、`IngestResult.errors`（`/admin` の画面に返る）には**生の例外メッセージを一切含めない**。実際の例外は `console.error` でサーバーログにのみ出力する。`runIngest()` の `summary.errors`（ソースごとの取得・キュレーション失敗メッセージ）も同様の理由で公開前に要約する（`src/app/actions.ts` 側でサニタイズし、件数のみの日本語メッセージに置換する。原文は `console.error` に残す）。

### §6.5 `/` の動的レンダリング（ISR の撤去）

`src/app/page.tsx` は `export const dynamic = "force-dynamic"` を宣言しており、`src/lib/db/query.ts` の `getFeedCards()` は毎リクエスト DB を直接読む（`unstable_cache` は使わない）。

**経緯**: 以前は ISR（`unstable_cache` による 5 分キャッシュ + `ingest` / `submit-url` からの `revalidateTag` による明示的失効）だった。しかしデプロイをまたいで残った stale なキャッシュエントリが stale-while-revalidate で配信され続け、「体験談 0 件なのに更新制限」という誤解を招く報告につながった（実測では本番 DB に投稿が存在し収集自体は成功していたが、訪問するたびに前回訪問時点のスナップショットが配信される状態になっていた）。

**判断根拠**: このページのトラフィックはほぼゼロで、`getFeedCards()` のクエリも最大12件×2レーンの単純な SELECT に過ぎない。ISR の利得（DB 負荷の軽減）より、「オーナーが `/admin` から収集した直後に結果をここで確認できない」ことの損失の方が大きいと判断し、キャッシュ層ごと撤去した。これに伴い `FEED_CACHE_TAG` 定数と、`ingest.ts` / `submit-url.ts` の `revalidateTag()` 呼び出しも削除した。`/admin`（`src/app/admin/page.tsx`）も同様に `force-dynamic` とし、クールダウン状態と直近ラン結果（`last_run_summary`）を常に最新の DB 状態で表示する。

---

## 7. Test Strategy

### §7.1 Tiered Coverage Targets

| Tier                  | 対象モジュール・ファイル                                                                                                                                                                         | ターゲット網羅率         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Tier 1 純粋ロジック   | `src/lib/url.ts`, `src/lib/llm/signature.ts`, `src/lib/llm/schemas.ts`, `src/lib/constants.ts`, `src/lib/scoring/usefulness.ts`                                                                  | 95%                      |
| Tier 2 パース・判定   | `src/lib/sources/base/feed-parser.ts`, `src/lib/embed/providers.ts`                                                                                                                              | 85%                      |
| Tier 3 収集アダプタ   | `src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`, `src/lib/sources/base/rss-fetcher.ts`, `src/lib/embed/oembed.ts` | 80%                      |
| Tier 4 LLM 制御       | `src/lib/llm/batch.ts`, `src/lib/llm/client.ts`                                                                                                                                                  | 80%                      |
| Tier 5 API ルート     | `src/app/api/ingest/route.ts`, `src/app/api/submit-url/route.ts`, `src/lib/pipeline/ingest.ts`, `src/lib/pipeline/submit-url.ts`, `src/lib/pipeline/cooldown.ts`                                 | 70%                      |
| Tier 6 データアクセス | `src/lib/db/repository.ts`, `src/lib/db/query.ts`                                                                                                                                                | 65%                      |
| Tier 7 RSC/UI         | `src/app/page.tsx`, `src/app/layout.tsx`, `src/components/**`                                                                                                                                    | 除外 (smoke test で担保) |

---

## 8. Non-Goals

- 独自に結婚式関連記事の本文を作成・執筆すること。
- プラットフォーム独自の非公式スクレイピングによるデータ収集。
- 閲覧者ごとに出し分けるレコメンド・パーソナライズ（Cookie / ログイン / 行動履歴に基づく順序・内容の変更）。掲載順は全閲覧者に対して同一である。

---

## 9. 編集方針 (Editorial Policy)

体験談レーン（`sourceType: "blog"`）の掲載順は「何が話題か」ではなく「これから
式の中身を決める読者にとって役に立つか」で決める。本セクションはその判定
基準・重み・掲載順ルールを定義する唯一の参照先であり、第2段（LLM プロンプト
変更・並び順の実装・既存データのバックフィル）はここに従って実装する。

### §9.1 想定読者

> 想定読者は、挙式日・会場が決まっており、衣装（ドレス・和装）もおおむね
> 決まっている。これから決めるのは挙式・披露宴の**中身**である —— 進行と
> タイムライン、演出、席次と席札、余興、スピーチや余興の依頼、BGM、装花、
> 料理、引出物、ペーパーアイテム、写真と映像、ゲストの過ごしやすさ、当日の
> 段取り。この読者が求めているのは「何が人気か」ではなく「実際に式を挙げた
> 人が、何を、なぜそう判断したか」である。

第2段でこの文面をそのまま LLM プロンプトからも参照する（プロンプトと
spec.md とで想定読者の定義が乖離しないようにするため）。

### §9.2 語彙非依存の原則

「卒花」「プレ花嫁」等の語がタイトル・本文に含まれること自体は加点材料では
ない。これらの語が無くても、実際の挙式・披露宴の経験に基づく知見であれば
§9.3 の判定基準に従って同等に扱う。新婦本人に限らず、新郎・両家家族、および
プランナー・司会者・カメラマン・装花担当など式に立ち会う職能者が実務経験に
基づいて書いた知見も対象に含む（§9.3 `firsthand` の定義を参照）。

### §9.3 判定項目とスコア計算

LLM には次の 6 つのブール値のみを判定させ、点数そのものは出させない
（点数は `src/lib/scoring/usefulness.ts` の純関数 `computeUsefulnessScore()`
がコード側で計算する。この分離により、重み調整が再課金ゼロのコード変更で
済む）。

| 項目                      | 定義                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `firsthand`               | 書き手自身または近しい当事者が実際に挙式・披露宴を経験した立場から書かれている。新婦本人に限らず、新郎・両家家族、およびプランナー・司会者・カメラマン・装花担当など式に立ち会う職能者が実務経験に基づいて書いたものを含む                       |
| `ceremonyDecision`        | 挙式・披露宴の**中身**の意思決定に効く（進行・タイムライン・演出・席次・席札・余興・スピーチ・BGM・装花・料理・引出物・ペーパーアイテム・挙式当日の写真・映像、ゲストの過ごしやすさ・当日段取り）                                                |
| `preDecisionOrPhotoShoot` | 内容がフォトウェディング・前撮り・式場探し等、式決定前/別撮影の話題に限られるか（true ならゲート不通過）。(a) フォトウェディング・前撮り・後撮りなどの別撮影、(b) 式場探し・見積もり比較・日取り決定までの段階。挙式当日の写真・映像は含めない。 |
| `specific`                | 具体を含む（固有の選択・数字・実際にやったこと / やらなかった理由）。心構えのみは false                                                                                                                                                          |
| `tradeoff`                | 判断の理由・後悔・「やってよかった / 要らなかった」の評価が述べられている                                                                                                                                                                        |
| `promotional`             | 事業者による集客・自社サービスへの誘導が主目的（減点）。判別基準は「読者が別の会場・別の業者で式を挙げる場合にも役立つか」                                                                                                                       |

スコア計算式（`USEFULNESS_GATE_BONUS` 等の重み定数は `src/lib/constants.ts`
に定義する）:

```
gate  = (ceremonyDecision && !preDecisionOrPhotoShoot) ? USEFULNESS_GATE_BONUS(10) : 0
score = gate
      + USEFULNESS_WEIGHT_FIRSTHAND(3)   * firsthand
      + USEFULNESS_WEIGHT_SPECIFIC(2)    * specific
      + USEFULNESS_WEIGHT_TRADEOFF(2)    * tradeoff
      - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY(4) * promotional
```

`ceremonyDecision` と `preDecisionOrPhotoShoot` によるゲート条件（`ceremonyDecision && !preDecisionOrPhotoShoot`）は加算項の一つではなく**ゲート**である。単純な加算項に
すると、「衣装だけの記事だが実体験・具体的・トレードオフあり」（3+2+2=7）が
「式の中身に触れているが浅い記事」（10）を上回ってしまい、「これから式の
中身を決める読者に効く記事を優先する」という編集方針そのものが反転する。
挙式・披露宴の中身に関する記事であり、かつフォトウェディング・前撮りや式場探し等の事前検討に偏っていないことを他の加点の前提条件にすることで、この逆転を構造的に防ぐ。

`preDecisionOrPhotoShoot` は陽性識別極性（positive-identification polarity: 該当しない場合は false）を採用しており、抜粋から情報が得られない場合は false となる。これにより、情報不足の記事を誤って重く罰することを防いでいる。

重みは、抜粋（記事冒頭）から LLM が判定できる確信度に比例させている。話題
（`ceremonyDecision` / `preDecisionOrPhotoShoot`）・書き手の立場（`firsthand`）・宣伝性（`promotional`）
は記事冒頭からでも判定しやすい一方、具体性（`specific`）やトレードオフ
（`tradeoff`）は本文中盤以降にしか現れないことが多く、抜粋だけからの判定は
確信度が落ちる。そのため `firsthand`（3）を `specific`/`tradeoff`（各 2）
より重くしている。`promotional` の減点（4）を他の加点より大きくしているのは、
ゲートを通過した記事であっても宣伝目的の記事を上位に出さないという編集方針
の強さを反映したものである。

### §9.4 判断材料が無ければ false に倒す

LLM が判定に必要な情報を十分に得られない場合（抜粋が短すぎる等）、各項目は
`true` ではなく `false` に倒す。自信を持って誤判定して不適切な記事を上位に
押し上げるより、判定を保留して新着順相当の位置に留まる方が実害が小さい
という判断による。

### §9.5 未スコア投稿の扱い

LLM によるキュレーションが一時的に失敗した投稿、および原文テキストが存在せ
ず要約を生成できない投稿（次章 §10 の要件 4. 参照）には、`src/lib/scoring/usefulness.ts`
の `UNSCORED_USEFULNESS_SCORE`（固定値 3）を用いる。この値は**ゲート不通過
帯の中位**に意図的に置いており、無条件で最下位に落とすことはしない。最下位
に固定してしまうと、一時的な LLM 失敗によって新着の良記事が静かに埋もれて
しまうためである。次回 ingest で `post_usefulness.signature` が
`posts.curation_signature` と不一致になった投稿として再スコア対象に検出され、
自然に正しい位置へ移動する。

### §9.6 掲載順の決定規則

- **体験談レーン**（`sourceType: "blog"`）: 有用度スコア（§9.3）降順 →
  `publishedAt` 降順。
- **速報レーン**（`sourceType: "sns"`、手動 URL 投入）: `publishedAt` 降順を
  維持する（本セクションの採点対象外）。速報性そのものが価値であることに加え、
  SNS 投稿には体験談レーンのような本文抜粋が無く、同じルーブリックで採点
  できないため。

### §9.7 不変条件

スコアは記事単体（原文テキスト・書き手の立場）から一意に決定され、閲覧文脈
や閲覧者に依存しない。全閲覧者に対して同一の掲載順を提示する（§8 Non-Goals
の禁止対象——閲覧者ごとに出し分けるレコメンド・パーソナライズ——と対になる
不変条件）。

### §9.8 スコアは UI に公開表示しない

有用度スコアはページ上の一般公開面には表示しない。他人が書いた記事に点数を
付けて公開することは、中立キュレーションから評価メディアへ立ち位置が変わる
行為であり、著作者クレジット（次章 §10 の要件 2.）の隣に数値を置く表示は
それと異なる法的リスクを負う。順序として使うことは編集行為だが、点数その
ものの公表は評価行為であり、本プロジェクトのスコープ外とする。

---

## 10. 法務制約 (Legal Constraints)

1. **元ソースへの導線が最優先 CTA**: すべてのカードにおいて、元投稿・記事へのリンク（または公式埋め込み）を明確なメインアクションとして配置する。
2. **著作者名の必須クレジット**: 引用（著作権法第32条）の要件を満たすため、カード上に著者名・情報源名を必ず表示する。
3. **要約の表現制限**: AI による要約は原文のクリエイティブな表現（言い回し）をそのまま再現せず、客観的な事実や要点の抽出に留める（翻案権・複製権への配慮）。これらは `src/lib/llm/prompts.ts` 内のプロンプトおよび UI 表示において厳格に担保される。
4. **原文テキストが存在しない場合は AI 要約を生成しない**: `src/lib/pipeline/submit-url.ts` の `runSubmitUrl` は、LLM キュレーション（`curateSingle`）を呼び出す前に「要約対象となる原文テキストが存在するか」を判定する。原文テキストとは oEmbed が返すキャプション（`embed.title`）と、運営が投稿時に添える補足メモ（`note`、空白のみは「補足なし」として扱う）の 2 つのみを指す。
   - Instagram のキーなし oEmbed エンドポイント（`graph.facebook.com/.../instagram_oembed`）はキャプション本文を一切返さない（`version` / `provider_name` / `provider_url` / `type` / `width` / `html` のみで `title` が欠落する。2026-08-22 の実リクエストで確認済み）。これに対し YouTube の oEmbed は `title` を返す。
   - 原文テキストが両方とも存在しない場合、`runSubmitUrl` は `curateSingle` を一切呼ばず、`status: "pending"` のまま投稿を保存する（`aiTitle` / `aiSummary` は null のまま）。取得済みの embed（`embedProvider` / `embedHtml` / `embedFetchedAt`）と `url` は保存し、再取得コストを避ける。呼び出し元には安定コード `"needs_source_text"` を返す。
   - `aiTitle` / `aiSummary` が null の投稿は `src/lib/db/query.ts` の `getFeedCards` が除外するため、運営が補足メモを添えて再投入するまでフィードには表示されない（意図した挙動）。
   - 原文テキストが存在する場合（oEmbed にキャプションがある、または運営が補足メモを添えた場合）は、従来通り `curateSingle` によるキュレーションを行う。
