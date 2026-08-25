# ウエディング・トレンド ＆ リアルフィード (Wedding Trend & Real Feed) - 仕様書

## 1. Executive Summary

結婚式準備の「今」のトレンドと「リアル」な体験談を、1 分で俯瞰できるキュレーションフィードアプリケーションです。
Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS v4, Drizzle ORM + Turso (libSQL), Google Gemini, Zod, Vitest を採用しています。

本プロジェクトの最大の特長は、**記事本文を一切書かず、公開されている外部の SNS 投稿やブログ記事に対して、元記事・投稿への導線とセットでカード表示する点**にあります。体験談レーンのタイトルは AI 生成ではなく**元記事タイトルの逐語表示**であり、AI が出力するのはトピックアンカーと短い判定根拠文（記事の性質についての言明であり、内容の配達ではない）です（詳細は §10 を参照）。これにより、著作権やハルシネーションのリスクを最小限に抑えつつ、ユーザーに価値あるキュレーションを提供します。

---

## 2. Scope (In / Out)

### In Scope

- **2つのレーンによるキュレーション表示**:
  - 上段: 最新トレンド速報 (`sourceType: "sns"`) — 演出・衣装・DIY等のビジュアル情報
  - 下段: 満足度の高い王道・定番 (`sourceType: "blog"`) — 体験談・費用感・アドバイス
- **自動巡回コレクター**:
  - RSS フィードに基づくブログ・体験談の収集 (`src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`, `src/lib/sources/base/rss-fetcher.ts`, `src/lib/sources/base/feed-parser.ts`, `src/lib/sources/registry.ts`)
- **sitemap 差分による発見・本文取得（discovery 経路）**:
  - RSS フィードが存在しないセクション（第1対象: `mwed.jp` 体験談）を sitemap の差分から発見し、アクセス規律レイヤー経由で本文を取得して判定する。本文は判定後に破棄し永続化しない (`src/lib/sources/sitemap-discovery.ts`, `src/lib/sources/access-discipline.ts`, `src/lib/sources/article-text.ts`, `src/lib/pipeline/discovery-ingest.ts`, `scripts/run-discovery.mjs`)。詳細は §6.3 を参照。
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
- **FR-008: sitemap 差分発見と本文取得による判定（discovery 経路）**
  - RSS フィードが存在しないセクションを対象に、`src/lib/sources/sitemap-discovery.ts` の `discoverNewUrls()` が sitemap の差分から新規 URL を発見して `discovery_seen` に記録し、`src/lib/pipeline/discovery-ingest.ts` の `ingestDiscoveredUrls()` が `pending` 状態の URL を `src/lib/sources/access-discipline.ts` の `disciplinedFetch()` 経由で取得し本文を判定に用いる。実行は GitHub Actions（`.github/workflows/discovery.yml`、日次）であり、`/admin`・Vercel Cron の収集トリガー（FR-006/FR-007）とは独立した第3の摂取経路である。取得した本文は判定にのみ用い、`posts.original_excerpt` を含むいかなるカラムにも永続化しない（§10-5）。アクセス規律（robots.txt 遵守・レート制限・kill gate）の詳細は §10-6、保存先テーブルは §5 を参照。

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

### 判定根拠・discovery 系の 5 テーブル（`src/lib/db/schema.ts`）

いずれも `post_usefulness_criteria` と同じ制約下（本番 Turso が news-watch と
DB を共有しており、`scripts/apply-migrations-remote.mjs` が `ALTER TABLE` を
一切許可せず `CREATE TABLE` / `CREATE INDEX` のみ許可）で追加された。
`posts` テーブル自体には一切カラムを追加しておらず、すべてサイドテーブルで
拡張している（`src/lib/db/migrations/0004_post_rationales.sql` 〜
`0008_host_gate_state.sql`。5本とも `CREATE TABLE`（一部 `CREATE INDEX` 併記）
のみで構成され、`ALTER TABLE` 文を含まない）。

#### `post_rationales` テーブル（判定根拠。§10-3）

`ceremonyDecision`/`preDecisionOrPhotoShoot` 等の 6 boolean（`post_usefulness_criteria`
側）とは別に、公開カードに表示するトピックアンカーと判定根拠文を保持する。

- `post_id`: `posts.id` と同じ型の主キー。
- `topic_anchor`: トピックのアンカー（40字以内、`src/lib/llm/schemas.ts` の
  `CurationItemSchema` が検証）。結論のアンカーであってはならない（§10-3）。
- `rationale_text`: 判定根拠文（60〜90字、記事固有の具体数値禁止。
  半角・全角数字を含む場合は zod の `refine` で機械的に拒否される）。
- `evidence_sufficient`: LLM が判定に足る原文テキストを得られたか
  （boolean。`false` の投稿には rationale 行自体を作らない運用のため、
  実質的にこのテーブルに存在する行は常に `true`）。
- `model_id`: 判定した Gemini モデル ID。
- `prompt_version`: プロンプト版（`RATIONALE_PROMPT_VERSION`、
  `src/lib/constants.ts`）。将来プロンプト文言を変更した際の
  バックフィル判定に使う。
- `created_at`: ISO8601 文字列。

#### `discovery_seen` テーブル（既知 URL 集合の正本。§6.3）

sitemap 差分発見における「正しさの根拠」そのもの。`lastmod` は
child sitemap の絞り込みに使う最適化に過ぎず、正本はこのテーブルが持つ
既知 URL 集合である。

- `host`: 対象ホスト名。
- `url_hash`: URL のハッシュ（主キー）。
- `url`: 元 URL。
- `first_seen_at`: 初めて sitemap 上で観測した ISO8601 時刻。
- `sitemap_lastmod`: sitemap 上の `lastmod`（無ければ null。最適化専用で
  正しさの判定には使わない）。
- `status`: `"pending"`（未取得）/ `"fetched"`（取得試行済み）/
  `"skipped"`（robots 拒否・404/410・取得サイズ超過等で今後も取得しない）。
- インデックス: `(host, status)`（`ingestDiscoveredUrls()` が
  `pending` 行をホスト単位で取得する際に使う）。

#### `discovery_run` テーブル（発見ランの観測記録）

`discoverNewUrls()` の1回の実行ごとに1行。ゲート判定（`lastmod` を
不信任にしたか等）と観測の根拠を残す。

- `id`: 主キー（自動採番）。
- `host`: 対象ホスト名。
- `started_at` / `finished_at`: ISO8601 文字列（`finished_at` は実行中は null）。
- `sitemaps_fetched`: 取得した sitemap（ルート＋子）の数。
- `urls_new`: このランで新規発見した URL 数。
- `urls_fetched`: 予約フィールド（discovery ラン自体は本文取得を行わず
  `discovery_seen` への seed のみを行うため、現状は常に 0）。
- `status_counts`: `discovery_seen` のステータス別件数を JSON 文字列化したもの。
- `outcome`: `"seeded"`（初回。取得はせず既知集合の記録のみ）/
  `"completed"` / `"completed_lastmod_distrusted"`（1回の差分件数が
  `LASTMOD_DIFF_ALERT_THRESHOLD` を超え、`lastmod` を信用せず全件再取得した）/
  `"failed"`。
- インデックス: `(host, started_at)`。

#### `source_policy` テーブル（robots/ToS のスナップショット）

kill gate K1（robots.txt 変化検知）の入力。取得のたびに内容ハッシュを
既存の保存値と比較し、変化していれば K1 を発火させる（§10-6）。

- `host`: 主キー。
- `robots_hash` / `robots_body`: 直近取得した robots.txt の SHA-256 ハッシュと本文。
- `tos_url` / `tos_hash`: 利用規約のスナップショット用フィールド（列は
  存在するが、変化を自動検知する処理は未実装。K2 は今後の課題）。
- `checked_at`: ISO8601 文字列。

#### `host_gate_state` テーブル（kill gate の永続状態。§10-6）

`config` KV は単一スカラーの ISO8601 カーソル専用（`discovery:cursor:<host>`
のみ）であり、gate 識別子やストライク数のような非 ISO の状態値は保持できない
（`writeConfigValue` が値を ISO8601 文字列に強制するため）ため、専用テーブルで
永続化する。

- `host`: 主キー。
- `gate_id`: 直近発火した gate（`K1`/`K3`/`K4`/`K5`/`K6`/`K7`。未発火なら null）。
- `state_kind`: `null`（稼働中）/ `"cooloff"`（`until_at` まで一時停止）/
  `"stopped"`（K1 由来の人手復帰待ち）/ `"permanent"`（恒久停止）。
- `until_at`: `cooloff` の期限（ISO8601。他の state では null）。
- `k4_strikes`: K4（記事取得 403）の連続回数。2 回で `permanent` に遷移する。
- `last_429_at`: 直近の 429 応答時刻（K6 の 24 時間窓判定に使う）。
- `count_day` / `count_value`: K7（日次リクエスト上限）用のカウンタ
  （UTC 日付キー、`post_usefulness_criteria` 同様この日を跨いだらリセット）。
- `updated_at`: ISO8601 文字列。

---

## 6. Architecture

投稿の摂取経路は 3 本ある: (1) RSS フィードの自動巡回（`src/lib/pipeline/ingest.ts`）、
(2) `/admin` からの手動 URL 投入（`src/lib/pipeline/submit-url.ts`）、
(3) sitemap 差分による発見・本文取得（`src/lib/pipeline/discovery-ingest.ts`、GitHub Actions
の日次実行）。(1)(2) は §6.1 の収集トリガー（Vercel Cron・Server Action）を経由するが、
(3) は Vercel Cron を増やさず GitHub Actions で独立して動く（§6.3 を参照）。

- **2-lane design**:
  - SNS トレンド速報レーン: `src/components/feed/feed-lane-trend.tsx`, `src/components/feed/sns-embed.tsx`
  - ブログ定番レーン: `src/components/feed/feed-lane-classic.tsx`, `src/components/feed/feed-card.tsx`
- **Collection pipeline**:
  - `src/lib/sources/registry.ts` -> 各アダプタ (`src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`) -> RSS フェッチャー (`src/lib/sources/base/rss-fetcher.ts`, `src/lib/sources/base/feed-parser.ts`)
  - discovery 経路（RSS が無いセクション向け）: `src/lib/sources/sitemap-discovery.ts` -> `src/lib/sources/access-discipline.ts` -> `src/lib/sources/article-text.ts` -> `src/lib/pipeline/discovery-ingest.ts`（§6.3）
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

#### 非 RSS のエバーグリーン経路（§6.1 のトリガー外・手動実行）

「式決定後の意思決定」に特化した定番記事は RSS フィードが構造的に存在しないため、
§6.1 の収集トリガーとは独立した手動経路で摂取する。運営が CLI
`node scripts/submit-evergreen.mjs <url> [--source-name <出典名>]` で URL を投入すると、
`src/lib/pipeline/evergreen.ts` の `curateEvergreenUrl()` が URL 正規化 → OGP/JSON-LD
メタデータ取得（本文 DOM は読まない）→ 原文テキスト（og:description）の有無で分岐し、
LLM キュレーションまたは pending 保存を行う。原文テキスト不在時の挙動と出典クレジットの
解決規則は §10-4 に定義する。対象トピックの選定基準（商用排除・当事者の体験談限定）は
§9 の編集方針に従う。

#### sitemap 差分発見・本文取得経路（discovery、§6.1 のトリガー外・GitHub Actions）

RSS フィードが構造的に存在しないセクション（第1対象: `mwed.jp` の体験談セクション、
`sitemap_stories.xml`）を対象に、sitemap の差分から新規記事を発見し本文を取得して
判定する。エバーグリーン経路（`og:description` のみを読む）と異なり、この経路は
「判定に足るだけの本文」を実際に取得する（§10-4・§10-5）。

- **発見（`src/lib/sources/sitemap-discovery.ts` の `discoverNewUrls()`）**:
  sitemap（`fast-xml-parser` で新規依存なしにパース）を読み、`discovery_seen`
  （§5）にある既知 URL 集合に無い URL を「新規」として `discovery_seen` に
  `pending` で記録する。**正しさの根拠は既知 URL 集合であり、`lastmod` では
  ない。** `lastmod` は「どの子 sitemap を読むか」を絞る最適化としてのみ使い、
  取りこぼしても次回の全件走査で回収される。1回の差分件数が
  `LASTMOD_DIFF_ALERT_THRESHOLD`（`src/lib/constants.ts`）を超えたら、その
  ランは `lastmod` を信用せず全件を再走査する（`discovery_run.outcome` が
  `"completed_lastmod_distrusted"` になる）。初回実行はその媒体の URL 全件を
  `pending` として記録するのみで本文取得は行わない（seeding。
  `discovery_run.outcome` が `"seeded"`）。
- **本文取得と判定（`src/lib/pipeline/discovery-ingest.ts` の
  `ingestDiscoveredUrls()`）**: `discovery_seen` の `pending` URL を、
  `src/lib/sources/access-discipline.ts` の `disciplinedFetch()`（§10-6）
  経由で 1 件ずつ取得する。取得した HTML から `src/lib/sources/article-text.ts`
  の `extractHtmlTitle()` で元タイトルを、`extractVisibleText()` +
  `selectJudgmentSlice()`（先頭 1,200 字をスキップした後続 1,500 字）で
  判定スライスを得る。判定スライスが `hasSufficientEvidence()`（文字数閾値
  `MIN_EVIDENCE_INPUT_CHARS`）未満、または `<title>` が取得できない場合は
  LLM を呼ばずに `pending` 保存（または `skipped`）とする。閾値を満たせば
  `curateSingle()` に判定スライスを渡し、`evidenceSufficient: true` で
  返った場合のみ `published` として `post_rationales`（§5）を含めて保存する。
  **`posts.original_excerpt` には常に `null` を保存し、抽出した本文は
  いかなるカラムにも永続化しない**（§10-5。DB への書き込みは
  `upsertPosts()` に渡す直前のオブジェクトで `originalExcerpt: null` を
  明示している）。`sourceId` は既存のエバーグリーン経路と同じ
  `EVERGREEN_SOURCE_ID`（`"evergreen"`）を共有する。
  ランは 1 回の実行時間予算（`DISCOVERY_INGEST_TIME_BUDGET_MS`、既定 15分）を
  超えたら残りを次回ランに委ねる。kill gate 発火（§10-6）または
  `Retry-After` 指定を受けたホストは、そのランの残り URL の処理を即座に
  中断する（継続は無意味かつ無礼であるため）。
- **実行基盤**: GitHub Actions（`.github/workflows/discovery.yml`）が
  UTC 18:00（JST 3:00）に日次実行する。`timeout-minutes: 20` と
  `concurrency: { group: discovery, cancel-in-progress: false }` により、
  1ジョブの上限時間と二重実行の防止を両立する。薄い CLI ラッパーは
  `scripts/run-discovery.mjs`（対象ホストごとの起点 sitemap は同スクリプト内の
  `SITEMAPS_BY_HOST` に定義する）。**Vercel Cron は増やさず**、`/api/ingest`
  への相乗りもしない（§6.1 の認可付き単一エントリに条件分岐を生やさない）。
  cron の遅延・欠落・重複は前提とし（Vercel も GitHub Actions も
  best-effort）、既知 URL 集合ベースの設計により取りこぼしても壊れない。
  GitHub Actions の scheduled workflow は 60 日 inactivity で自動停止する
  ため、`scripts/check-discovery-freshness.mjs`（`.github/workflows/weekly-monitor.yml`
  経由で週次実行）が `discovery_run` の最終実行時刻を監視する。
- **アクセス規律・kill gate**: §10-6 を参照。

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
に定義する。同じ式が純関数 `src/lib/scoring/usefulness.ts` の
`computeUsefulnessScore()` と SQL 文字列 `src/lib/db/query.ts` の
`USEFULNESS_SCORE_SQL` の2箇所に手書きで存在し、両者の一致は
`tests/feed-order-parity.test.ts` が 64 通りの判定組み合わせで検証する）:

```
gate  = (ceremonyDecision && !preDecisionOrPhotoShoot) ? USEFULNESS_GATE_BONUS(12) : 0
score = gate
      + USEFULNESS_WEIGHT_FIRSTHAND(3)   * firsthand
      + USEFULNESS_WEIGHT_SPECIFIC(2)    * specific
      + USEFULNESS_WEIGHT_TRADEOFF(2)    * tradeoff
      - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY(4) * promotional
      - USEFULNESS_WEIGHT_PRE_DECISION_PENALTY(3) * preDecisionOrPhotoShoot
```

`ceremonyDecision` と `preDecisionOrPhotoShoot` によるゲート条件（`ceremonyDecision && !preDecisionOrPhotoShoot`）は加算項の一つではなく**ゲート**である。単純な加算項に
すると、「衣装だけの記事だが実体験・具体的・トレードオフあり」（3+2+2=7）が
「式の中身に触れているが浅い記事」（12）を上回ってしまい、「これから式の
中身を決める読者に効く記事を優先する」という編集方針そのものが反転する。
挙式・披露宴の中身に関する記事であり、かつフォトウェディング・前撮りや式場探し等の事前検討に偏っていないことを他の加点の前提条件にすることで、この逆転を構造的に防ぐ。

**強支配（strong domination）不変条件**: 「挙式・披露宴の中身の記事は、
ゲート不通過の記事に常に優先する」——ゲートを通過した記事は、たとえ
`promotional` 判定を受けていても、ゲート不通過帯の中でどれだけ質が高い
記事（`firsthand`/`specific`/`tradeoff` を総取り）にも常に勝つ。式で書くと
`USEFULNESS_GATE_BONUS - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY >
USEFULNESS_WEIGHT_FIRSTHAND + USEFULNESS_WEIGHT_SPECIFIC +
USEFULNESS_WEIGHT_TRADEOFF`（12-4=8 > 7）。`USEFULNESS_GATE_BONUS` を
10→12 に引き上げたのは、10 だとこの不変条件が破れていた（10-4=6 < 7）ため。
この不変条件は `tests/usefulness-score.test.ts` で定数から式を組み立てて
固定している（数値をテストに直書きしない。定数を変更したときにテストが
連動して壊れるようにするため）。

`preDecisionOrPhotoShoot` は陽性識別極性（positive-identification polarity: 該当しない場合は false）を採用しており、抜粋から情報が得られない場合は false となる。これにより、情報不足の記事を誤って重く罰することを防いでいる。

`preDecisionOrPhotoShoot` は二役を持つ。1つはゲート条件の AND 側（安全網）
——`ceremonyDecision=true` かつ `preDecisionOrPhotoShoot=true` の記事を
ゲート不通過にする。もう1つは `USEFULNESS_WEIGHT_PRE_DECISION_PENALTY` に
よる**独立減点**——`ceremonyDecision` の値に関わらず、`preDecisionOrPhotoShoot=true`
の記事を一律に押し下げる。既知の事実として、AND 側の安全網は現行の定義
（「フォトウェディング・前撮り・式場探し等、式決定前/別撮影の話題に
**限られる**場合」）では `ceremonyDecision=true` とほぼ両立せず、実測データ
（本番 43 件）でもこの組み合わせは 0 件——つまり AND 側はほぼ発火しない。
以前（本項目追加当初）はこの AND 条件だけで運用しており、その結果
`preDecisionOrPhotoShoot=true` の記事群（本番 8 件）は `ceremonyDecision=false`
の記事群（本番 28 件）と常に同点になり、掲載順に一切反映されていなかった。
独立減点はこれを是正するために追加した（オーナー方針:
「ゲートというよりは、ソートさえできればよいので」）。AND 側の安全網は
**発火していないことを理由に将来削ってはならない**——`ceremonyDecision` の
定義が将来広がった場合に備えた保険として意図的に残している。

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
の `UNSCORED_USEFULNESS_SCORE`（固定値 3）を用いる。この値は現在の式では
「ゲート通過帯の下限（`USEFULNESS_GATE_BONUS` のみ = 12）より下、かつ全項目
false（0点）より上」の**楽観的な中位**に意図的に置いており、無条件で最下位
に落とすことはしない。最下位に固定してしまうと、一時的な LLM 失敗によって
新着の良記事が静かに埋もれてしまうためである。次回 ingest で
`post_usefulness_criteria.signature` が `posts.curation_signature` と
不一致になった投稿として再スコア対象に検出され、自然に正しい位置へ移動する。

### §9.6 掲載順の決定規則

- **体験談レーン**（`sourceType: "blog"`）: 有用度スコア（§9.3）降順 →
  `publishedAt` 降順 → `posts.id` 降順（最終タイブレーク）。SQLite の
  `ORDER BY` は同値行の順序を保証しないため、スコアも `publishedAt`（null
  同士を含む）も同点になった場合に備え、常に一意な `posts.id` で最終確定
  させる。これが無いと `limit()` によるページングのたびに順序が入れ替わり、
  重複・欠落の原因になる。
  - この並び順キーを組み立てる SQL（`src/lib/db/query.ts` の
    `USEFULNESS_SCORE_SQL`）は、`json_extract(criteria_json, '$.key')` の
    結果を必ず `COALESCE(..., 0)` で包む。`criteria_json` にキーが1つでも
    欠けていると `json_extract` は SQL の `NULL` を返し、`NULL` は加減算式
    全体に伝播して、エラーも出さずにその行を（実質的に）最下位へ沈める。
    `COALESCE` により「未知の判定項目は加点も減点もしない」という意味論に
    統一し、将来判定項目を追加したときに旧バックフィル分の行が全滅する
    事故を防ぐ。**この式を `json_extract(x,'$.k')` から `x -> '$.k'` へ
    書き換えてはならない**——SQLite の `->` は JSON テキスト（真偽値なら
    `'true'`/`'false'`）を返すため `= 1` の比較が常に false になり、
    ゲート条件が静かに常時不通過になる（`->>` なら等価だが、実績のある
    `json_extract` に統一する）。純関数 `computeUsefulnessScore()` との
    一致は `tests/feed-order-parity.test.ts` が 64 通りの判定組み合わせで
    検証する。
  - 同じ SQL は `json_valid(criteria_json)` も検査し、不正 JSON の行は
    `UNSCORED_USEFULNESS_SCORE` にフォールバックする（`post_usefulness_criteria`
    に行が無い場合と同じ意味論）。`json_extract` は不正 JSON に対して
    runtime error を投げ、`getFeedCards()` の fail-soft 契約（`try/catch` +
    `[]` を返す）がそれを拾うと**体験談レーン全体**が消えてしまう——1行の
    JSON 破損がページの1セクションを丸ごと空にするという実害の大きい故障
    モードだったため、`json_valid` の判定を `json_extract` より手前の
    `WHEN` 節に置き、壊れた行だけを個別にフォールバックさせている。破損した
    行は次回 ingest で signature 不一致として再スコア対象に検出され、自然に
    正しい位置へ復帰する。
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

### §9.9 表示可否条件（`RATIONALE_DISPLAY_PHASE` による2段階移行）

`src/lib/db/query.ts` の `getFeedCards()` は、投稿を公開面に出す条件を
`RATIONALE_DISPLAY_PHASE`（`src/lib/constants.ts`、既定 `"phase1"`）で
2段階に切り替える。これは要約前提（`aiTitle`/`aiSummary`）から判定根拠
前提（`post_rationales`）への移行期のためのサーバ側1本のスイッチである。

- **phase1（既定）**: `(posts.ai_title IS NOT NULL AND posts.ai_summary IS NOT NULL) OR post_rationales.post_id IS NOT NULL`。
  旧方式（`aiTitle`/`aiSummary` が揃っている投稿）と新方式（`post_rationales`
  行が存在する投稿）のいずれかを満たせば表示する。**§10-3 の転換より前に
  作られた既存記事を暗転させないための移行的条件**であり、`aiTitle` の
  生成自体は §10-3 の転換により全経路で停止済みのため、phase1 下で新規に
  この OR の左辺（`aiTitle IS NOT NULL`）を満たす投稿が今後生まれることはない。
- **phase2**: `post_rationales.post_id IS NOT NULL` のみ。バックフィル完了後に
  切り替える、判定根拠のみを表示条件とする最終形。
- 描画は判定根拠（`topicAnchor`/`rationaleText`）を優先し、無ければ
  `aiSummary` にフォールバックする（`src/components/feed/feed-card.tsx`）。
- 両フェーズとも `posts.status = "published"` が前提条件であり、
  `evidenceSufficient=false`（LLM の棄権）の投稿は `post_rationales` 行を
  持たない・`status` が `"pending"` のまま留まるため、いずれのフェーズでも
  表示されない（§10-4 の不変条件と整合する）。

---

## 10. 法務制約 (Legal Constraints)

本章は本プロジェクトの唯一の法務仕様である。改訂履歴: 当初 AI 要約を出力する
設計だったため §10-3/§10-4 は「要約の表現制限」を前提に書かれていた。判定根拠
（トピックアンカー＋根拠文）への転換（`shared_plan/06-rationale-and-scraping.md`）
に伴い、§10-3 を「出力は記事の性質についての言明であり内容の配達ではない」に、
§10-4 を摂取経路に依存しない一般形に、それぞれ書き換えた。§10-5・§10-6 は
本文取得による discovery 経路（§6.3）の追加に伴う新設項目である。

1. **元ソースへの導線が最優先 CTA**: すべてのカードにおいて、元投稿・記事へのリンク（または公式埋め込み）を明確なメインアクションとして配置する。
2. **著作者名の必須クレジット**: 引用（著作権法第32条）の要件を満たすため、カード上に著者名・情報源名を必ず表示する。`sourceName` は常時表示し、`author` は非 null の場合に表示する。
3. **出力は記事の性質についての言明であり、内容の配達ではない**（ゼロクリック化の回避）:
   - **タイトルは `originalTitle`（元記事タイトル）の逐語表示**。AI によるタイトルの生成・書き換えは行わない（`src/components/feed/feed-card.tsx` は `card.originalTitle` をそのまま表示する）。他人の記事タイトルを AI が書き換えて表示する行為は同一性保持権（著作権法第20条、非営利免除の無い人格権）への配慮上、本システムで最も改変に近い操作になるため。`aiTitle` カラムは `posts` に残っているが、`ALTER TABLE` 不可の制約上休眠カラムとして残しているだけで、いずれの摂取経路（RSS 自動巡回・`/admin` 手動投入・discovery）も `markCurated()` 呼び出し時に `aiTitle` を渡さず、値は常に null のままである。
   - **判定根拠文（`rationaleText`、`post_rationales.rationale_text`）は 60〜90字**とし、記事固有の具体数値（半角・全角数字）を含めてはならない。`src/lib/llm/schemas.ts` の `CurationItemSchema` が zod の `refine` で `/[0-9０-９]/` を機械的に拒否する（プロンプト指示だけに依拠しない）。
   - **トピックアンカー（`topicAnchor`、`post_rationales.topic_anchor`）は 40字以内**とし、**トピックのアンカーであって結論のアンカーであってはならない**（可: 「持ち込み料の交渉について書いている」／不可: 「持ち込み料〇万円が交渉で免除された」のような結論の開示）。この制約はプロンプト（`src/lib/llm/prompts.ts` の `RATIONALE_RULES`）で指示するのみで、文字数以外は機械的な検証を持たない。
   - **判定テスト**: 読者がクリックせずに情報要求を満たせる出力は、原文の代替物になっている。カードあたり事実は最大1つ、否定的評価（`promotional=true` 等）は公開画面に一切出さない（§9.8 のスコア非公開と一貫させる）。
4. **判定に足る原文テキストが存在しない場合は LLM 判定結果を公開しない（経路非依存の不変条件）**: すべての摂取経路において、LLM キュレーション（`curateSingle`）を呼び出す前に「判定対象となる原文テキストが存在するか」を判定する。「原文テキスト」の定義は経路ごとに異なり、新たな摂取経路を追加する際は必ず本項に定義を追記する。
   - **SNS 手動投入経路**（`src/lib/pipeline/submit-url.ts` の `runSubmitUrl`）: oEmbed が返すキャプション（`embed.title`）と、運営が投稿時に添える補足メモ（`note`、空白のみは「補足なし」として扱う）の 2 つのみを指す。
   - **エバーグリーン経路**（`src/lib/pipeline/evergreen.ts` の `curateEvergreenUrl`）: OGP メタデータの `og:description` / `<meta name="description">`（`meta.description`）のみを指す。`<title>` / `og:title` は表示ラベルであり判定の材料にしない。本文 DOM は一切読まない（`src/lib/sources/ogp.ts` は meta タグと JSON-LD のみを走査する。`tests/ogp.test.ts` がこの不変条件を固定する）。
   - **discovery 経路**（`src/lib/pipeline/discovery-ingest.ts` の `ingestDiscoveredUrls`）: 取得した記事 HTML から `src/lib/sources/article-text.ts` の `extractVisibleText()` + `selectJudgmentSlice()` で抽出した**判定スライス**（先頭 1,200 字をスキップした後続 1,500 字）のみを指す。§10-5 の禁止事項と対になる規律であり、この判定スライスは LLM 入力としてのみ使い DB には一切保存しない。
   - Instagram のキーなし oEmbed エンドポイント（`graph.facebook.com/.../instagram_oembed`）はキャプション本文を一切返さない（`version` / `provider_name` / `provider_url` / `type` / `width` / `html` のみで `title` が欠落する。2026-08-22 の実リクエストで確認済み）。これに対し YouTube の oEmbed は `title` を返す。
   - SNS 経路で原文テキストが両方とも存在しない場合、`runSubmitUrl` は `curateSingle` を一切呼ばず、`status: "pending"` のまま投稿を保存する（`aiSummary` は null のまま）。取得済みの embed（`embedProvider` / `embedHtml` / `embedFetchedAt`）と `url` は保存し、再取得コストを避ける。呼び出し元には安定コード `"needs_source_text"` を返す。
   - エバーグリーン経路で原文テキストが存在しない場合も同様に、`curateEvergreenUrl` は `curateSingle` を一切呼ばず、取得済みのメタデータ（タイトル・著者・サムネイル・公開日）と `url` を `status: "pending"` で保存する。呼び出し元には安定コード `"needs_source_text"` を返す。LLM 失敗時のフォールバック要約も原文テキスト（excerpt）のみから生成し、title へのフォールバックは行わない。
   - discovery 経路で判定スライスが `hasSufficientEvidence()`（`MIN_EVIDENCE_INPUT_CHARS` 文字未満）を満たさない場合、または `<title>` が取得できない場合は、`curateSingle` を呼ばず `pending` 保存（`<title>` 不在時は保存すらせず `skipped`）とする。
   - **LLM 自身による棄権（`evidenceSufficient: false`）でも公開しない。** 判定対象の原文テキストが存在していても、LLM が判定に足る情報が無いと判断した場合は `evidenceSufficient: false` を返し、呼び出し元は `status: "pending"` で保存する（`post_rationales` 行は作らない）。「原文テキストの有無」というゲート単独ではなく、LLM の判定不能宣言も等しく非公開理由になる（`src/lib/llm/schemas.ts` の `CurationItemSchema.evidenceSufficient`）。
   - 公開の可否は最終的に §9.9 の表示条件（`RATIONALE_DISPLAY_PHASE`）に従う。`status: "pending"` の投稿と `post_rationales` 行が無い投稿はいずれのフェーズでも表示されない。
   - 原文テキストが存在し、かつ LLM が `evidenceSufficient: true` を返した場合は、従来通り `curateSingle` によるキュレーション結果を `published` として保存する。
   - **出典クレジット（第 2 項）の解決規則（エバーグリーン経路）**: 出典名は「運営の明示指定（CLI の `--source-name`、前後空白は trim）→ `og:site_name` → URL ホスト名（`www.` を除去した実在ドメイン）」の順で解決する。いずれも解決できない場合、架空のソース名を捏造せずに保存を拒否する（安定コード `"no_source_name"`）。サイト名を示さない固定文字列へのフォールバック生成は禁止。discovery 経路の `sourceName` は `registrableDomain(url)`（解決できなければ対象ホスト名）で決定する（`src/lib/pipeline/discovery-ingest.ts`）。
5. **抽出本文の永続化禁止**: discovery 経路で取得した本文（`extractVisibleText()` / `selectJudgmentSlice()` の出力）は LLM 判定の入力としてのみ使用し、**`posts` を含むいかなるカラムにも永続化しない**。`src/lib/pipeline/discovery-ingest.ts` の `upsertPostRow()` は `originalExcerpt: null` を常に渡し、discovery 経路由来の投稿の `originalExcerpt` は常に `null` になる。理由は3つ: (a) §10-3/§10-4 の「取得・判定は情報解析、公開は表現を含まない言明」という二層構造を維持できる、(b) 「他人の著作物のデータベース」を新たに作らない、(c) 本文が DB に存在すると将来誰かがそれを要約の材料に使う drift を構造的に防ぐ（無ければ使えない）。エバーグリーン経路・SNS 経路の `originalExcerpt`（`og:description` やキャプション等、配信者自身が公開用に提供したメタデータ）とは性質が異なるため区別すること——discovery 経路の抽出本文は配信者が要約用に提供したものではなく、記事本文からの機械的な抽出（複製）である。
6. **アクセス規律（discovery 経路の本文取得のみに適用。実装 `src/lib/sources/access-discipline.ts`）**:
   - **robots.txt の遵守**: 取得前に必ず確認し、`isAllowed()` が false を返す URL は取得しない（`blocked_robots` として `discovery_seen` を `skipped` にする）。取得結果は 24 時間以内でキャッシュする（RFC 9309 の推奨）。
   - **`Crawl-delay` を下限として尊重**: robots.txt に `Crawl-delay` の指定があれば、ホストあたり最小間隔（既定 `MIN_HOST_INTERVAL_MS` = 5秒）とその値（秒）×1000msの大きい方を実際の間隔とする。
   - **ホスト内は逐次・ホスト間は並列**: 同一ホストへの直前リクエストからの経過時間を記録し、間隔未満なら待機する。
   - **日次ハードキャップ**: ホストあたり `DAILY_REQUEST_CAP_PER_HOST`（既定50件）。間隔の遵守だけでは総量が青天井になりうるため、独立した上限として持つ。
   - **条件付き GET**: `If-Modified-Since` / `If-None-Match` を送り、304 を `not_modified` として扱う。
   - **連絡先入り User-Agent**: `CRAWLER_USER_AGENT`（`src/lib/constants.ts`。既定 `WeddingTrendBot/1.0 (+https://github.com/menonaki2/wedding-trend)`）を常に送信する。**UA 偽装は行わない**（実装上、他の UA 文字列に差し替える経路が存在しない）。
   - **取得サイズ上限**: `MAX_BODY_BYTES`（既定 512KB）。`Content-Length` またはボディの実バイト長で判定し、超過時は取得を打ち切る（`too_large`。kill gate ではなく、そのホストではなく個別 URL の事情として扱う）。
   - **kill gate**: 1つでも観測されたら該当ホストの discovery を即座に停止する。回復には人間の再判断（`host_gate_state` 行の手動解除）を要する。実装済みのゲートのみを示す:

     | #   | 観測事象                                                           | 実装上の扱い                                                                                                         |
     | --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
     | K1  | robots.txt の内容ハッシュが直近取得値から変化                      | `host_gate_state.stateKind = "stopped"`。人間の再確認を待つ（恒久停止ではない）                                      |
     | K3  | 401 / 451 応答                                                     | `stateKind = "permanent"`。即恒久停止、自動復帰なし                                                                  |
     | K4  | 記事取得（`purpose: "article"`）で 403                             | 初回は `stateKind = "cooloff"`（24時間）。連続2回目（`k4Strikes >= 2`）で `permanent`                                |
     | K5  | robots.txt / sitemap 取得（`purpose` が `robots`/`sitemap`）で 403 | `stateKind = "permanent"`。1回で即恒久停止（配信の意思そのものへの拒否と評価するため）                               |
     | K6  | 429 応答                                                           | `Retry-After` を厳密に守って1回だけ再開（`retry_after` verdict）。24時間以内に2回目の429で `stateKind = "permanent"` |
     | K7  | ホストあたり日次リクエスト数が `DAILY_REQUEST_CAP_PER_HOST` 超過   | `stateKind` は変更せず、その日の残り時間は `kill_gate` verdict で拒否し続ける（UTC日次でリセット）                   |
     | K9  | 根拠文が §10-3 の数値禁止制約に違反                                | `src/lib/llm/schemas.ts` の zod `refine` により LLM 応答のバリデーション自体が失敗する（保存前に機械的に拒否）       |
     | K2  | 利用規約テキストが変化                                             | `checkTermsOfServiceChange()`（`src/lib/sources/access-discipline.ts`）。詳細は §10-7 K2                             |

     **403 を「1回で恒久停止」にしない理由（K4 のみ）**: GitHub Actions の
     Azure IP では WAF 起因の 403 が定常的に起きうるため、1回で恒久停止する
     ゲートは早期に「毎回止まる」状態になり形骸化する。K5（robots/sitemap
     への 403）はこの理由が当てはまらない——媒体側が明示的にアクセス制御用
     エンドポイントへのアクセスを拒否している以上、配信意思そのものへの
     拒否とみなし1回で恒久停止する。
     **未実装のゲート**: K8（採用率低下によるフィルタ/抽出破損の検知）・
     K10（判定根拠と元記事の内容不一致の自動検知）は、本仕様時点でコードと
     して実装されていない。

7. **著作者クレジット要件についての記録（2026-08-25 訂正）**: 2026-08-25 の初版では、本項に「要件が達成しようとしていた目的（著作者への出所明示）は `www.mwed.jp` に関しては達成されていない」と記載していた。**この評価は撤回する。** 誤りの経緯: 第2項の原文を逐語で確認せず、要約された記憶（「著作者クレジットを必ず表示する」）のみを根拠に「要件が満たせない」と判断した。しかし第2項の原文は当初から条件付きである——「`sourceName` は常時表示し、`author` は非 null の場合に表示する」。`www.mwed.jp` は `author` が構造上取得できないため常に null であり、**要件は「表示しない」を正しく指示しており、実装（§10-4 の「クレジットは構造化メタデータのみから取得し、解決できなければ捏造せず非表示にする」方針）はこれを仕様どおり満たしている。**
   - **法的な裏付け**: 著作権法48条1項1号が求めるのは「利用の態様に応じ合理的と認められる方法及び程度による出所の明示」であり、媒体名＋元記事への明示的リンク（要件1・`sourceName` 常時表示）はこれに十分該当しうる。48条2項が求めるのは「当該著作物につき**表示されている**著作者名を示すこと」——すなわち**ソース側が表示している著作者名を転記する義務**であり、**表示されていない著作者を特定・調査する義務ではない**。したがって §10-4 の「構造化メタデータから取得できなければ捏造せず非表示にする」方針は 48条2項の建付けと整合する。
   - **既知の限界（撤回しない）**: 48条2項が見ているのは「著作物につき表示されている著作者名」であり、構造化メタデータに入っているか否かではない。**ページ本文中に可視のバイラインが存在するのに構造化メタデータに存在しない場合**、現在の実装（構造化メタデータのみを走査する。§10-4）はそのバイラインを拾わない。この場合、仕様（第2項）の文言上は満たすが、48条2項の趣旨からはズレうる。実地調査（4サンプル）ではクレジット表記（「取材・文」等）自体が存在しなかったため今回この限界は顕在化していないが、他ホスト追加時には確認が必要な既知の未解決点として記録する。
8. **対象コーパスについての記録（2026-08-25 訂正）**: 2026-08-25 の初版では、本項に「`www.mwed.jp` の discovery 対象パスは一般利用者（結婚式を挙げた本人）による UGC 投稿である」と記載していた。**この判定は撤回する。** 誤りの経緯: 「口コミを投稿する」導線（サイト共通ナビであり当該ページ固有の性質の証拠にならない）と「投稿日」表記（編集記事にも付きうる）という弱い根拠のみで UGC と判定し、以後の記述・専門家評価をこの前提で進めてしまった。実地再調査（4ページ）の結果、**対象パス（`/story/cases/{id}/`）はすべて (A) 運営／編集部による取材記事**と判定される。判定根拠:
   - 本文が全ページ三人称（例:「新婦マイさんは、幼少期から結婚式への強い憧れがあり」）。ユーザー投稿であれば一人称になるはずが、そうなっていない
   - 「スタッフのコメント」は各ページ固有の本体コンテンツであり、ページごとに内容が異なる（テンプレート的な定型文ではない）
   - カップルのコメントは「おふたりからのメッセージ」として地の文から明確に分離されている——取材記事の本文＋インタビュー引用という構造
   - カップルは「このストーリーの主役」＝取材対象として表記されており、著作者としての表記ではない
   - クレジット表記（「取材・文」等）は存在しない
   - したがって規約 第5条第1項③の「投稿コンテンツ（会員が本サービスに投稿、送信、アップロードしたコンテンツ）」には該当せず、運営が制作した「本コンテンツ」に当たる。**著作権者は単一の法人であり、削除要請の宛先も一意に定まる。**
   - **`author` メタデータが null であることは UGC であることの証拠にならない**——日本語圏の編集系 CMS は `og:site_name` は出すが author 系メタデータを出さないものが多数派であり、null は媒体の実装習慣を反映しているにすぎない。誤りの一因は `author = null` にこの意味を負わせすぎたことにある。
   - **ただし個人情報・人格的利益への配慮は撤回しない。** 記事本文にはカップルの氏名・ニックネーム・式場・費用・挙式日等が含まれる。UGC ではなく取材記事であっても、これらは取材対象個人に関する情報であることに変わりはない。discovery 経路は本文を保存しない（§10-5）が、`originalTitle` と `meta.description` 由来の `originalExcerpt` は保存対象であり、個人を特定しうる記述が含まれる可能性を排除できない。要約・トピックアンカーに個人識別情報を含めない制約が別途必要である（実装は並行作業中）。
9. **非営利であることの設計上の意味（§13-1 のオーナー判断を前提とする）**: 対象ホストの利用規約第5条第10項・第12項は営利利用を要件とするため、**非営利である限りこれらの条項は発動しない**。一方、**第5条第11項（無断転載・無断利用の一般禁止）は営利を要件としない**。したがって「非営利だから触れない」という命題は成立しない。非営利という前提は**違反の成否そのものには効かず、違反が顕在化した場合の実害（財産的請求権の薄さ）にのみ効く**、という区別を維持する。
   - **収益化（広告・アフィリエイト・有料化を含む一切のマネタイズ）は、本項を含む法務前提の全面再評価を必須とする。** 将来の実装者が本項の存在を知らないまま広告枠を追加する事態を避けるため、収益化に関わる変更を検討する前に必ず本節（§10-7〜§10-11）と §13-1 を読むこと。
10. **discovery 中止トリガー（`www.mwed.jp` 固有）**: 以下のいずれかを満たした場合、当該ホストの discovery を停止する。
    - robots.txt に記事パス（`articlePathPatterns`）の Disallow が追加された → **即時・自動停止**（K1 が既に機械的に検知する。§10-6）
    - 運営から停止要求を受領した → **即時停止**。再開は運営からの明示的な許諾がある場合のみ
    - 利用規約に、非会員・利用者一般（「本サービスの利用者」等、会員に限定しない主体）を名宛人とする新たな禁止条項が追加された → **停止して再評価**（K2 が変化を検知するが、判断は人間が行う。§10-7）
    - ブロック（403/429 の継続）を検知した → **停止する**（K4/K5/K6 が既に機械的に検知する。§10-6）

    **禁止事項**: ブロックされた場合に、User-Agent の変更・IP ローテーション等による回避を行ってはならない。回避行為は、蓋然性の低いリスク（不法行為・刑事）を現実化させる最短経路である。

11. **新規ホストを `HOST_ALLOWLIST` に追加する際の入場基準（2026-08-25 訂正）**: 新規ホストの追加は以下を満たすことを原則とする。
    1. ~~構造化メタデータ（JSON-LD / meta / `dc:creator`）から `author` が取得できること~~ → **加点要素に格下げ**（訂正）。第2項は当初から「`author` は非 null の場合に表示する」という条件付き要件であり、`author` の取得可否そのものは要件2 の充足条件ではない。取得できれば §10-7 の既知の限界（可視バイラインの取りこぼし）を減らせるため加点はするが、必須要件ではない
    2. 記事が運営または署名ライターによる編集記事であること（UGC 主体のホストではないこと）。**判定方法は `author` メタデータの有無ではなく、本文の人称（三人称か一人称か）・取材構造（インタビュー引用の分離があるか）・投稿導線の遷移先（サイト共通ナビか当該ページ固有か）を実地確認すること。** `author` の有無だけで UGC/編集記事を判定すると誤判定しうる（§10-8 の訂正を参照）
    3. robots.txt が対象記事パスを許可していること
    4. 利用規約の適用範囲・定義条項・非会員（利用者一般）への言及の有無を、追加前に取得し記録すること
    5. UGC セクションが同一ホスト内に併存する場合、対象記事パスの**ホワイトリスト**（ブラックリストではなく）で編集記事セクションのみを分離できること
    6. RSS/Atom フィードが提供されていれば加点（必須ではない）

    **`www.mwed.jp` は基準1（加点要素・未充足）を満たさないが、基準2 は満たしている**（§10-8 のとおり運営による取材記事と判定）。2026-08-25 の初版に記載していた「基準 1・2 を満たさない例外である」という記述は誤りであり訂正する。

---

## 11. discovery アクセス規律の追加統制（2026-08-25 実装分）

以下は §10-6 のアクセス規律に対する追加実装であり、plan 07 の Stage 0（M3・M4・M5）に対応する。

1. **K2（規約変更検知）と allowlist の関係**: `source_policy.tosUrl` は `HOST_ALLOWLIST`（`src/lib/constants.ts` の各エントリの `tosUrl`）から解決する。**allowlist 側が真実の源（source of truth）であり、DB（`source_policy` テーブル）に格納された古い値は allowlist の値で上書きして解決する**（`src/lib/sources/access-discipline.ts`）。allowlist に未登録、または `tosUrl` が未設定のホストは `tosUrl: null` のまま維持され、K2 の対象にならない。
   - **既知の許容トレードオフ（遅延）**: K2 の実行間隔は「1ホストあたり1日1回」であり、`source_policy.checkedAt` 列を robots.txt チェック側と共有している。そのため **robots.txt の変化を検知した直後は、規約チェックが最大1日遅延しうる**。追加専用（append-only）のマイグレーション制約下では列を新設するだけで解決できず、テーブルを分離すると `tosHash` が再び休眠カラム化するリスクを招くため、この遅延は仕様上許容する。
2. **記事パスのホワイトリスト（`HOST_ALLOWLIST.articlePathPatterns`）**: discovery 対象の URL パスは `src/lib/constants.ts` の `AllowlistedHost.articlePathPatterns` で定義し、**取得前に**2段階で強制する——sitemap からの URL 収集（seed）段階と、本文取得直前の段階。口コミ投稿ページ（`/hall/{hallId}/rev/{commentId}/` 等、記事とはパス構造が異なる投稿単位のページ）はこのパターンに一致しないため、構造的に discovery 対象から除外される。
3. **日次公開上限とホスト別シェア上限**: `DAILY_PUBLISH_CAP = 10`・`HOST_DAILY_SHARE_MAX = 0.5`（`src/lib/constants.ts`。plan 07 §9 Stage 2 の日次上限 ≤10 に対応）。当日の公開総数が `DAILY_PUBLISH_CAP` に達している、またはあるホストの当日公開数が `Math.max(1, Math.floor(DAILY_PUBLISH_CAP × HOST_DAILY_SHARE_MAX))` に達している場合、以後そのホストの新規公開を打ち切る。SNS 手動投入・エバーグリーン・discovery の全経路（`src/lib/pipeline/submit-url.ts`・`src/lib/pipeline/evergreen.ts`・`src/lib/pipeline/ingest.ts`・`src/lib/pipeline/discovery-ingest.ts`）で共通の判定関数を用いる。
4. **`RetractionReason` と撤回 CLI**: `RetractionReason`（`src/lib/types.ts`）に `takedown_request` を追加した。4つの客観的トリガ（`source_gone` / `robots_disallowed` / `tos_changed` / `body_changed`）と異なり、**`takedown_request` のみが人間の判断による撤回**であり、自動検知パイプラインからは設定されない。撤回は `pnpm retract`（`scripts/retract.mjs`）で行う——既定は dry-run（対象一覧の表示のみ、DB 変更なし）、接続先を明示し、`--reason` は必須（既定値なし）で人間に毎回明示させる。実際に撤回するには `--yes`（または `--execute`）を要する。
