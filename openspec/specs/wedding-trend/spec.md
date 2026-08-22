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
  - UI の取得ボタンから叩く Server Action (`src/app/actions.ts`) と、`vercel.json` の Vercel Cron による定期実行。両者とも実処理は `src/lib/pipeline/ingest.ts` / `src/lib/pipeline/submit-url.ts` に一本化されている（詳細は §6）。取得ボタンは無認証で本番の公開トップページに置かれるため、DB 側で強制する 4 時間のグローバルクールダウンで濫用を防ぐ。加えて、両経路とも同時実行を防ぐ排他ロック（lease）を必ず取得する（`src/lib/pipeline/cooldown.ts`。詳細は §6.4）
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
- **FR-006: 収集トリガーの UI 化と定期実行**
  - `src/app/actions.ts` の Server Action（`triggerIngest` / `submitSnsUrl`）により、UI 上のボタン操作から `src/lib/pipeline/ingest.ts` / `src/lib/pipeline/submit-url.ts` を直接呼び出す。加えて `vercel.json` の Vercel Cron 設定により `GET /api/ingest` を定期実行する。両トリガー経路の詳細・認可モデルは §6 を参照。
- **FR-007: 収集トリガーの排他ロックとグローバルクールダウン**
  - 収集パイプラインを起動する両経路（公開ボタン・Cron）は、`src/lib/pipeline/cooldown.ts` の `acquireIngestLease()` により実行排他ロック（lease）を必ず取得する。取得できなければ「実行中」として `runIngest()` を呼ばずに返す（公開ボタン経路では `IngestResult.busy: true`）。加えて公開ボタン経路のみ、`claimIngestSlot()` により 4 時間のグローバルクールダウンを DB 側で原子的に強制する。クールダウン中は lease を解放し `runIngest()` を呼ばずに待機状態を返す。詳細は §6.4 を参照。

---

## 4. Non-Functional Requirements

- **NFR-001: 型安全性**: TypeScript strict モードの完全遵守。
- **NFR-002: テストカバレッジ**: 各モジュールレイヤーに応じた厳格なカバレッジ要件の達成。
- **NFR-003: 法的・倫理的安全性の担保**: ゼロクリック要約の回避と、元ソースへの導線・クレジットの強制。
- **NFR-004: パフォーマンス**: Next.js 16 App Router の標準機能を活かした高速なサーバーサイド描画およびキャッシュ制御。

---

## 5. Data Model

データベースは Turso (libSQL) および Drizzle ORM (`src/lib/db/schema.ts`, `src/lib/db/index.ts`, `src/lib/db/query.ts`, `src/lib/db/repository.ts`, `src/lib/db/migrations/0000_stormy_harrier.sql`, `src/lib/db/migrations/0001_supreme_dark_phoenix.sql`) によって管理されます。

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
現状の用途は収集トリガーの排他ロックとグローバルクールダウンの 2 つで、
それぞれ独立した key を持つ:

- `key: "last_ingest_at"` — 直近の実行**開始**時刻（ISO8601 文字列）。公開ボタン
  経路のみが評価するグローバルクールダウン（4 時間）の起点。
- `key: "ingest_lease_until"` — 現在保持されているリース（実行排他ロック）の
  期限（ISO8601 文字列）。全経路が実行前に必ず取得し、実行完了後に解放する。

詳細は §6.4 を参照。

- `key`: 主キー (Text)
- `value`: 値。ISO8601 文字列で文字列比較の大小判定が成立する形式に統一する (Text)
- `updated_at`: タイムスタンプ (Text)

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

1. **UI の取得ボタン（Server Action）**: `src/app/actions.ts` の `triggerIngest()` / `submitSnsUrl(url)` を、トップページ上のボタン（別コンポーネントが所有）が呼び出す。`triggerIngest()` は無認証で本番の公開トップページに置かれる公開 Server Action であり、`submitSnsUrl()`（管理者向け・§6.2 参照）とは認可モデルが異なる。`triggerIngest()` の濫用防止は §6.4 の lease（排他ロック）と DB クールダウンが担う。
2. **Vercel Cron（定期実行）**: `vercel.json` の `crons` 設定により、Vercel が `GET /api/ingest` を定期的に呼び出す（スケジュールは `0 21 * * *` = UTC 21:00、JST 6:00 の 1 日 1 回）。本番は Vercel Hobby プランで運用しており、Hobby は Cron の実行頻度が 1 日 1 回までに制限される（それを超えるスケジュールを指定すると `vercel deploy` 自体が拒否され、デプロイが失敗する）ため、この頻度としている。
   - `src/app/api/ingest/route.ts` の `GET` ハンドラは単なるヘルスチェック/案内スタブではなく、`POST` と全く同じ認可チェック・同じ `runIngest()` 呼び出しを行う。Vercel Cron は `CRON_SECRET` 環境変数が設定されていれば `Authorization: Bearer <CRON_SECRET>` ヘッダーを自動付与するため、`src/lib/auth.ts` の `isBearerAuthorized` がそのまま両方の HTTP メソッドを検証できる。**`CRON_SECRET` が未設定の場合、この経路は fail-closed により常に 401 を返す**（詳細は §6.4 直前の認証方針、および `src/lib/auth.ts` を参照）。
   - この経路は公開ボタン経路の 4 時間クールダウンの**評価**を迂回するが、**lease（排他ロック）は迂回しない**。`acquireIngestLease()` に失敗した場合（＝公開ボタン経路や他の Cron 呼び出しが実行中）は `runIngest()` を呼ばずに `409` を返す。

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

SNS URL 投入フォームは `ENABLE_ADMIN_CONTROLS` 環境変数で有効/無効を切り替える。判定は `src/app/actions.ts` の `adminControlsEnabled()` が行い、`NODE_ENV !== "production"`（開発環境）では常に有効、本番では `ENABLE_ADMIN_CONTROLS === "1"` のときのみ有効になる。

**実際のアクセス制御は Server Action 側の再検証である。** UI がフォームを描画するかどうかの判定に `adminControlsEnabled()` を使うのは見た目の制御にすぎず、それ自体は防御にならない（Server Action は URL さえ知っていれば UI を経由せず直接呼び出せるため）。そのため `submitSnsUrl()` は自身の実行時にも必ず `adminControlsEnabled()` を再評価し、無効であれば処理を行わずに `ok: false` と日本語メッセージを返す。UI 側で該当フォームを非表示にする実装は、この再検証があって初めて意味を持つ補助的な措置として扱うこと。

**`triggerIngest()`（収集ボタン）はこのフラグの対象外である。** 収集ボタンは本番でも常に公開され、`adminControlsEnabled()` によるガードを持たない。これは意図した設計であり、代わりの濫用防止策は §6.4 の DB クールダウンである。

### §6.4 収集トリガーの排他ロック（lease）とグローバルクールダウン（cooldown）

`triggerIngest()` は無認証で本番の公開トップページに置かれるため、UI 側の表示制御（連打防止のボタン無効化等）だけでは、複数タブや直接の Server Action 呼び出しによる濫用（Gemini API 予算の焼き付き）を防げない。`src/lib/pipeline/cooldown.ts` は目的の異なる 2 つの機構を組み合わせてこれをサーバー側で強制する。**この 2 つは互いに独立した概念であり、混同しないこと**（以前はこれらを 1 つの機構に混ぜており、Cron 経路が両方を迂回できてしまうバグがあった。詳細は次項）。

| 機構     | 何を守るか                           | 対象経路                              | key（`config` テーブル） | 幅                             |
| -------- | ------------------------------------ | ------------------------------------- | ------------------------ | ------------------------------ |
| lease    | **同時実行の禁止**（排他）           | 公開ボタン・Cron の**両方**           | `ingest_lease_until`     | `INGEST_LEASE_TTL_MS`（10 分） |
| cooldown | **実行頻度の制限**（レートリミット） | **公開ボタン経路のみ**（Cron は免除） | `last_ingest_at`         | `INGEST_COOLDOWN_MS`（4 時間） |

#### lease（排他ロック）

「今まさに `runIngest()` を実行しているのは高々 1 経路だけ」を保証する。**全経路（公開ボタン・Cron）が実行前に必ず取得し、実行完了後（成功・失敗いずれも）に必ず解放する。**

- **`INGEST_LEASE_TTL_MS`**: リースの TTL（10 分 = `10 * 60 * 1000` ミリ秒）。`runIngest()` の実測実行時間は長くても 60 秒程度だが、タイムアウトやクラッシュでリースが解放されないまま残った場合に、次回の呼び出しが自動的に回復できるよう十分な余裕を持たせている。
- **`acquireIngestLease(now?)`**: リースの原子的な取得。`src/lib/db/repository.ts` の `claimIngestLease()` が発行する単一の `INSERT ... ON CONFLICT(key) DO UPDATE ... WHERE config.value <= ?` により、保存されているリース期限が現在時刻以下（＝期限切れ）の場合にのみ、新しいリース期限（`now + INGEST_LEASE_TTL_MS`）で上書きして true を返す。取得に失敗したら false（＝別の経路が実行中）。
- **`releaseIngestLease(now?)`**: リース期限を過去日時で無条件上書きし、即座に解放する。取得に成功した経路は `finally` で必ず呼ぶこと。

#### cooldown（グローバルクールダウン）

**公開ボタン経路のみ**に課すレートリミット。Cron は 1 日 1 回にしか叩かれず認証済みであるため評価を免除されるが、実行後に `last_ingest_at` を更新することで、Cron 実行の直後に公開ボタンが押されても不必要な再実行が起きないようにする。

- **`INGEST_COOLDOWN_MS`**: クールダウン幅（4 時間 = `4 * 60 * 60 * 1000` ミリ秒）。
- **`claimIngestSlot(now?)`**: cooldown 判定と `last_ingest_at` の更新を 1 呼び出しで行う。`src/lib/db/repository.ts` の `claimLastIngestAt()` が発行する単一の条件付き `INSERT ... ON CONFLICT DO UPDATE ... WHERE` により、4 時間以上経過していれば（または初回であれば）`last_ingest_at` を `now`（＝実行開始時刻）に更新して `{ claimed: true, cooldownUntil }` を返す。経過していなければ DB を書き換えずに `{ claimed: false, cooldownUntil }` を返す。`ClaimResult` は `{ claimed: boolean; cooldownUntil: string }`（両バリアントのフィールドが同一なため判別共用体にしていない）。奪取に失敗した場合の `cooldownUntil` は `getCooldownUntil()` に計算を委譲しており、重複実装しない。この関数は**呼び出し前に lease を取得済みであることが前提**（呼び出しが既に直列化されているため、内部の原子的 CAS は多重防御として働く）。
- **`getCooldownUntil(now?)`**: 読み取り専用。実行はせず、現在のクールダウン状態（クールダウン中でなければ `null`）を返す。公開ページの初期描画（`src/app/actions.ts` の `getIngestCooldown()`）に使う。
- **`markIngestStart(now?)`**: `last_ingest_at` を無条件に `now`（＝実行開始時刻）で上書きする。Vercel Cron 経路（`src/app/api/ingest/route.ts`、認証済みリクエスト）専用。cooldown の評価は迂回するが、`runIngest()` を呼ぶ**前**にこの関数で記録を更新する。

#### 読み取り＝フェイルソフト／書き込み＝fail-closed（`config` テーブル未作成時の非対称な挙動）

`config` テーブルが存在しない環境（マイグレーション未適用の本番、`scripts/smoke-test.sh` が意図的に空にする DB 等）では、`src/lib/db/repository.ts` の読み取り関数と書き込み関数を**意図的に非対称**に扱う。

- **読み取り（`getLastIngestAt()`）はフェイルソフト**: クエリが失敗したら（`src/lib/db/query.ts` の `getFeedCards` と同じ `try/catch` + `console.warn` + 安全側デフォルトのパターンで）例外を投げずに `null` を返す。`null` は「一度も実行していない」を意味し、テーブルが無い状態は意味的にもこれと一致する。これにより `getCooldownUntil()` → `getIngestCooldown()` と伝播して `{ cooldownUntil: null }` になり、`src/app/page.tsx` の初期描画（ビルド時の SSG を含む）がテーブル未作成でもクラッシュしない。これが本来のバグ（`config` テーブル未作成の環境でトップページが 500 になる）の修正本体である。
- **書き込み（`claimLastIngestAt()` / `claimIngestLease()` / それらが経由する `writeConfigValue()`）は fail-closed のまま**: 例外を握りつぶさず、そのまま呼び出し元に伝播させる。ここを読み取りと同様にフェイルソフトにしてしまうと、テーブルが無い環境で「クールダウン/lease の取得（＝書き込み）に成功した」と誤認し、濫用防止（レートリミット・排他ロック）そのものが丸ごと無効化されてしまうため。
- `triggerIngest()`（`src/app/actions.ts`）は `acquireIngestLease()` / `claimIngestSlot()` の呼び出しを `try/catch` で囲み、これらが例外を投げても Server Action 自体は未処理例外で落とさず、`{ ok: false, ran: false, busy: false, errors: [固定文言], cooldownUntil: null }`（`ingestUnavailableResult()`）を返す。`claimIngestSlot()` が例外を投げた時点で lease は既に取得済みのため、`releaseIngestLease()` で解放してから返す（解放自体が失敗しても、その例外もここで吸収し未処理例外にしない）。生の例外は `console.error` にのみ出力する。

#### 起点の統一（実行開始時刻）

cooldown の起点は、公開ボタン・Cron の**両経路とも「実行開始時刻」に統一されている**。公開ボタン経路は `claimIngestSlot()` が奪取と同時に `now`（呼び出し時点）を書き込み、Cron 経路は `runIngest()` を呼ぶ**前**に `markIngestStart(now)` を呼ぶ。以前は Cron 経路が `runIngest()` の**完了後**に記録していたため、実行に時間がかかるとクールダウンの起点が経路によって食い違うバグがあった。

#### 両経路の実行順序

```
1. lease 取得（acquireIngestLease）
   失敗 → 「実行中」として即座に返す（runIngest() を呼ばない）
2. 公開ボタン経路のみ: cooldown 判定（claimIngestSlot）
   クールダウン中 → lease を解放して返す（runIngest() を呼ばない）
3. last_ingest_at を実行開始時刻で更新
   （公開ボタン経路は手順 2 の claimIngestSlot() が兼ねる。Cron 経路は markIngestStart()）
4. runIngest() 実行
5. finally で lease を解放（releaseIngestLease）
```

- `triggerIngest()`（`src/app/actions.ts`）は上記を実装し、`IngestResult` で 3 つの終端状態を区別する: lease 取得失敗（`busy: true, ran: false`）、cooldown 中の見送り（`busy: false, ran: false, errors: []`）、実行（`ran: true`。成功時 `ok: true` で `errors` は `runIngest()` の `summary.errors` を件数のみに要約したもの、例外時 `ok: false` で `errors` は固定文言 `["収集処理でエラーが発生しました。時間をおいてお試しください。"]`）。`claimIngestSlot()` が `{ claimed: true }` を返した後に `runIngest()` が例外を投げた場合でも、実行権（クールダウンの枠）は消費されたままにする。これは、失敗直後にユーザーがリトライを連打できてしまうと、無認証で公開しているボタンから外部 API（RSS フィード・Gemini）呼び出しが際限なく繰り返される事態を防ぐための意図的な判断である。
- `src/app/api/ingest/route.ts`（Cron・curl 経路）は lease 取得失敗時に `409` を返す。cooldown 判定は行わない。

#### 公開面への例外メッセージの非漏洩

`runIngest()` や `triggerIngest()` の `try/catch` が投げる例外（Gemini SDK / libSQL / undici 等）の `message` にはホスト名・URL・リクエスト断片が混ざり得るため、`IngestResult.errors`（無認証の公開面に返る）には**生の例外メッセージを一切含めない**。実際の例外は `console.error` でサーバーログにのみ出力する。`runIngest()` の `summary.errors`（ソースごとの取得・キュレーション失敗メッセージ）も同様の理由で公開前に要約する（`src/app/actions.ts` 側でサニタイズし、件数のみの日本語メッセージに置換する。原文は `console.error` に残す）。

---

## 7. Test Strategy

### §7.1 Tiered Coverage Targets

| Tier                  | 対象モジュール・ファイル                                                                                                                                                                         | ターゲット網羅率         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Tier 1 純粋ロジック   | `src/lib/url.ts`, `src/lib/llm/signature.ts`, `src/lib/llm/schemas.ts`, `src/lib/constants.ts`                                                                                                   | 95%                      |
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
