# ウエディング・トレンド ＆ リアルフィード (Wedding Trend & Real Feed) - 仕様書

## 1. Executive Summary

結婚式準備の「今」のトレンドと「リアル」な体験談を、1 分で俯瞰できるキュレーションフィードアプリケーションです。
Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS v4, Drizzle ORM + Turso (libSQL), Google Gemini, Zod, Vitest を採用しています。

本プロジェクトの最大の特長は、**記事本文を一切書かず、公開されている外部の SNS 投稿やブログ記事に対して、元記事・投稿への導線とセットでカード表示する点**にあります。体験談レーンのタイトルは AI 生成ではなく**元記事タイトルの逐語表示**であり、AI が出力するのはトピックアンカーと短い判定根拠文（記事が扱う具体的な判断・場面・選択肢を本文語句で名指しし、結論・数値は含まない）です（詳細は §10 を参照）。これにより、著作権やハルシネーションのリスクを最小限に抑えつつ、ユーザーに価値あるキュレーションを提供します。

---

## 2. Scope (In / Out)

### In Scope

- **単一フィードによるキュレーション表示**:
  - 体験談・費用感・アドバイス等のブログ記事を中心とした単一のキュレーションフィード表示 (`src/components/feed/feed-lane-classic.tsx`, `src/components/feed/feed-card.tsx`)
- **自動巡回コレクター**:
  - RSS フィードに基づくブログ・体験談の収集 (`src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`, `src/lib/sources/base/rss-fetcher.ts`, `src/lib/sources/base/feed-parser.ts`, `src/lib/sources/registry.ts`)
- **sitemap 差分による発見・本文取得（discovery 経路）**:
  - RSS フィードが存在しないセクション（第1対象: `mwed.jp` 体験談）を sitemap の差分から発見し、アクセス規律レイヤー経由で本文を取得して判定する。本文は判定後に破棄し永続化しない (`src/lib/sources/sitemap-discovery.ts`, `src/lib/sources/access-discipline.ts`, `src/lib/sources/article-text.ts`, `src/lib/pipeline/discovery-ingest.ts`, `scripts/run-discovery.mjs`)。また、有用度スコア等の全件バックフィルスクリプト `scripts/backfill-usefulness.mjs` にも discovery 経路由来のプレフライト・バイパス機能が統合されており、本文をメモリ上で一時取得して再スコア対象にルーティングする。詳細は §6.3 を参照。
- **AI による見出し・要約生成**:
  - Google Gemini API を用いた一括抽出・サマライズ（バッチサイズ: `LLM_BATCH_SIZE = 30`。`src/lib/llm/client.ts`, `src/lib/llm/batch.ts`, `src/lib/llm/prompts.ts`, `src/lib/llm/schemas.ts`, `src/lib/llm/signature.ts`)
- **定期巡回 API**:
  - `src/app/api/ingest/route.ts` / `src/lib/pipeline/ingest.ts` による一括インジェスト
- **収集トリガー（2 経路）**:
  - `/admin`（`src/middleware.ts` の Basic 認証配下。オーナー限定）から叩く Server Action (`src/app/actions.ts`) と、`vercel.json` の Vercel Cron による定期実行。実処理は `src/lib/pipeline/ingest.ts` に一本化されている（詳細は §6）。収集ボタンは以前、無認証で本番の公開トップページに置かれていたが、デプロイをまたいで残る ISR の stale ページが原因の誤解（「体験談 0 件なのに更新制限」）をきっかけに `/admin` へ移した。加えて、両経路とも同時実行を防ぐ排他ロック（lease）と、`/admin` 経路のみ連打防止のクールダウンを DB 側で必ず取得する（`src/lib/pipeline/cooldown.ts`。詳細は §6.4）
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
- **FR-003: AI による要約・見出し生成**
  - Google Gemini API (`src/lib/llm/client.ts`) を用い、取得したコンテンツから短尺の要約、カテゴリ、タグ等を抽出・生成する。
- **FR-004: 単一フィード表示**
  - `src/app/page.tsx` において、定番ブログ記事等を中心とした単一のフィード (`src/components/feed/feed-lane-classic.tsx` と `feed-card.tsx`) を表示する。
- **FR-005: セキュリティおよび環境検証**
  - `src/middleware.ts` および `src/lib/auth.ts` によるベーシック認証等の保護、`src/lib/constants.ts` や `src/lib/url.ts` 等の共通ユーティリティ。`src/lib/auth.ts` の `isBearerAuthorized` は **fail-closed**: 検証用の secret（既定 `CRON_SECRET`）が未設定の場合、実行環境（`NODE_ENV` / `VERCEL_ENV` 等）によらず常にリクエストを拒否する。環境によって認証ロジックが変わる設計（未設定時はローカル開発向けに無認証で許可する fail-open）を避けるための意図的な制約であり、ローカル開発でも `.env.local` に secret を設定しない限り `/api/ingest` は 401 を返す。
- **FR-006: 収集トリガーの管理画面化と定期実行**
  - `src/app/actions.ts` の Server Action（`triggerIngest`）により、`/admin`（`src/middleware.ts` の Basic 認証配下・オーナー限定）上のボタン操作から `src/lib/pipeline/ingest.ts` を直接呼び出す。加えて `vercel.json` の Vercel Cron 設定により `GET /api/ingest` を定期実行する。両トリガー経路の詳細・認可モデルは §6 を参照。
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

### 状態遷移表（Plan 23 契約対応）

| 状態                                                                                       | topics / LLM の扱い                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| evidence不足、containerなし、titleなし、robots/ToS/allowlist拒否、hard stop、oversize、304 | topics不変。LLM禁止。content-free reason のみを監査許可フィールドに記録する。304を unconditional fetch へフォールバックしてはならない。    |
| 404 / 410                                                                                  | topics不変、LLM禁止。retraction workflow へ委譲する。                                                                                      |
| 429、fetch失敗、LLM/schema/DB失敗                                                          | topics、full signature、成功 signature を不変にする。retry は規律とresume状態に従う。                                                      |
| redirect                                                                                   | final URLを独立して allowlist、robots、ToS、rate で再検証する。cross-host も同様。canonical が別記事または同一性に疑義があれば no update。 |
| 成功                                                                                       | topics だけを原的に replace し、成功後に限り dedicated signature を記録する。                                                              |

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
しており、追加専用の安全装置 (`scripts/gates/migrations-additive.mjs` の
`classifyStatement()`) が許可するのは `CREATE TABLE` / `CREATE INDEX` /
`CREATE UNIQUE INDEX` / 所有テーブルへの `ALTER TABLE ... ADD COLUMN`
（`UNIQUE` / `PRIMARY KEY` / 非定数デフォルトを伴わない形に限る）のみで、
それ以外が現れると exit 1 するためである。さらに、将来的な
判定項目の追加・変更に際して DDL の変更（マイグレーション）を不要にするため、
判定結果は個別のカラムではなく単一の JSON カラム `criteria_json` にシリアライズ
して保存する設計（shared_plan/02 案C）を採用している。

- `post_id`: `posts.id` と同じ型（Integer）の主キー。採点対象の投稿。
- `criteria_json`: 5つの判定項目（`UsefulnessCriteria` 型。すべて 0〜9 の整数）の
  オブジェクトを `JSON.stringify()` したテキスト（`firsthand`, `ceremonyDecision`,
  `specific`, `weddingDayContent`, `promotional`）。2026-08-30 に旧仕様
  （5 boolean ＋ `promotional` の `"none"/"light"/"heavy"` 3段階 enum ＋
  `preDecisionOrPhotoShoot` boolean）から全項目 0-2 整数へ変更し、
  `preDecisionOrPhotoShoot` は `weddingDayContent = 0` に吸収して廃止した。
  DB マイグレーションは行わず、旧 shape の行は読み取り時に
  `normalizeCriterion` / `normalizePromotional`（`src/lib/scoring/usefulness.ts`）が
  0-2 に吸収する（`CURATION_PROMPT_VERSION` bump ＋ 全件再キュレーションで
  速やかに置き換わる）。
- `signature`: 採点時点（その記事の有用度を計算した LLM 実行）の
  `computeCurationSignature()` の値。通常のキュレーションでは
  `posts.curation_signature` と一致するが、バックフィルのゲート下落
  （アンカー不採用：gate_degrade）では `posts.curation_signature` を据え置きつつ
  有用度だけ前進させるため、この値は `posts.curation_signature` 以上（単調増加）に
  なり得る。再スコア対象の検出はあくまで `posts.curation_signature` の
  不一致のみで行う（`posts.curation_signature` が据え置かれた記事は、有用度が
  最新でも将来の再生成候補として残る）。
- `model_id`: 採点した Gemini モデル ID。
- `scored_at`: ISO8601 文字列（`config` / `posts` と同じ規約）。

**合計スコアはこのテーブルに保存しない。** 重みは `src/lib/scoring/usefulness.ts`
の純関数 `computeUsefulnessScore()` に置き、DB には判定項目 5 つの JSON オブジェクト
のみを保存する設計とした。合計スコアを保存すると、重みを調整するたびに
既存データのマイグレーションが必要になってしまうため、表示時に毎回その場で
計算する。旧 `post_usefulness` テーブルは過去のマイグレーション履歴に残るが実運用では
使用されず孤立している（削除しない）。

### 判定根拠・discovery 系の 5 テーブル（`src/lib/db/schema.ts`）

いずれも `post_usefulness_criteria` と同じ制約下（本番 Turso が news-watch と
DB を共有しており、`scripts/gates/migrations-additive.mjs` の `classifyStatement()`
が許可するのは `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` /
所有テーブルへの `ALTER TABLE ... ADD COLUMN`（`UNIQUE` / `PRIMARY KEY` /
非定数デフォルトを伴わない形に限る）のみ。それ以外が現れると exit 1 する）で
追加された。`posts` テーブル自体には一切カラムを追加しておらず、すべてサイド
テーブルで拡張している（`src/lib/db/migrations/0004_post_rationales.sql` 〜
`0008_host_gate_state.sql`。5本とも `CREATE TABLE`（一部 `CREATE INDEX` 併記）
のみで構成され、`ALTER TABLE` 文を含まない）。

#### `post_rationales` テーブル（判定根拠。§10-3）

`ceremonyDecision`/`weddingDayContent` 等の 5 つの 0-2 判定値（`post_usefulness_criteria`
側）とは別に、公開カードに表示するトピックアンカーと判定根拠文を保持する。

- `post_id`: `posts.id` と同じ型の主キー。
- `topic_anchor`: トピックのアンカー（40字以内、`src/lib/llm/schemas.ts` の
  `CurationItemSchema` が検証）。結論のアンカーであってはならない（§10-3）。
- `rationale_text`: 判定根拠文（38〜210字、記事固有の具体数値は含めない方針。
  ただし**数字の抑止は機械的に強制されていない**（2026-08-31 訂正。
  かつて記載していた zod `refine` による拒否は実装されていない。§10 第3項参照）。
  下限は `RATIONALE_TEXT_MIN_CHARS`、上限は `RATIONALE_TEXT_MAX_CHARS`
  （いずれも `src/lib/constants.ts`）として `renderRationaleText()` が
  機械的に強制する。字数要件の改定経緯は §10 第3項を参照）。
- `evidence_sufficient`: LLM が判定に足る原文テキストを得られたか
  （boolean。`false` の投稿には rationale 行自体を作らない運用のため、
  実質的にこのテーブルに存在する行は常に `true`）。
- `model_id`: 判定した Gemini モデル ID。
- `prompt_version`: プロンプト版（`RATIONALE_PROMPT_VERSION`、
  `src/lib/constants.ts`）。将来プロンプト文言を変更した際の
  バックフィル判定に使う。
- `created_at`: ISO8601 文字列。

#### `post_topics` テーブル（トピックチップ情報）

カードに表示するトピック情報を保持するテーブル。同様にサイドテーブル方式（追加マイグレーション `0013`）で拡張する。

- `post_id`: `posts.id` との外部キー（CASCADE 削除）。
- `position`: トピックの並び順（整数）。
- `topic`: 正規化されたトピック文字列。
- `prompt_version`: タグバージョン（バッチバックフィル用）。
- PRIMARY KEY (`post_id`, `position`), UNIQUE (`post_id`, `topic`), INDEX `idx_post_topics_topic` (`topic`)
- **Note**: CREATE TABLE + indexes のみ、additive migration 0013。トピック数（0〜4個）、文字数（2〜10文字）、数字禁止等のバリデーションは LLM スキーマおよびゲート側で行われ、DB 制約としては持たせない。
- トピックは確認済みの原サイト本文から切り出した judgment slice が直接支持する 0〜4 件の短い名詞句とする。薄い入力、クリックベイト、一般助言に対する `[]` または 1 件の abstain は正しい。タイトル・既存 excerpt・既存 topics だけから topics を更新する経路は持たない。すべてのオンライン入口（RSS、evergreen、sitemap discovery）で topics の生成・更新時は disciplinedFetch `purpose: "article"` → コンテナ抽出 → evidence gate → selectJudgmentSlice の正規経路で確認する。本文・slice はメモリのみで DB・ログ・stdout・checkpoint・telemetry・例外・raw LLM に保存・出力しない。`originalExcerpt` は常に `null` 固定。トピック更新は topics の原子的な replace（他のフィールドは一切変更しない）であり、正規化されたアクセス規律に従う。dedicated signature `topicBackfillSignature = H/HMAC(recordId + normalized URL + sourceContentDigest + extractionVersion + topicPromptVersion + schemaVersion + modelId)` を用い、`curationSignature` は不変とする。UI上では `topicAnchor` の下に非対話型のチップリストとしてレンダリングされ、未設定時はプレースホルダー等を非表示とし、ヘッダーに AI 判定に関する免責事項を表示する。法務制約 §10 の「AI自由生成による短尺ラベルは許容される（非創作的な短尺ラベル）」に従う。

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
- `gate_id`: 直近発火した kill gate（`K1`/`K3`/`K4`/`K5`/`K6`。未発火なら null）。
  B1（日次リクエスト予算。kill gate ではない。下記§10-6直後の小見出しを参照）は
  `stateKind` を変更しないため、この列には記録しない。
- `state_kind`: `null`（稼働中）/ `"cooloff"`（`until_at` まで一時停止）/
  `"stopped"`（K1 由来の人手復帰待ち）/ `"permanent"`（恒久停止）。
- `until_at`: `cooloff` の期限（ISO8601。他の state では null）。
- `k4_strikes`: K4（記事取得 403）の連続回数。2 回で `permanent` に遷移する。
- `last_429_at`: 直近の 429 応答時刻（K6 の 24 時間窓判定に使う）。
- `count_day` / `count_value`: B1（日次リクエスト予算）用のカウンタ
  （UTC 日付キー、`post_usefulness_criteria` 同様この日を跨いだらリセット）。
- `updated_at`: ISO8601 文字列。

---

## 6. Architecture

投稿の摂取経路は複数ある: (1) RSS フィードの自動巡回（`src/lib/pipeline/ingest.ts`）、
(2) sitemap 差分による発見・本文取得（`src/lib/pipeline/discovery-ingest.ts`、GitHub Actions
の日次実行）。

- **Single feed design**:
  - 単一フィードレーン: `src/components/feed/feed-lane-classic.tsx`, `src/components/feed/feed-card.tsx`
- **Collection pipeline**:
  - `src/lib/sources/registry.ts` -> 各アダプタ (`src/lib/sources/hatena-bookmark.ts`, `src/lib/sources/google-news.ts`, `src/lib/sources/note.ts`, `src/lib/sources/ameblo.ts`) -> RSS フェッチャー (`src/lib/sources/base/rss-fetcher.ts`, `src/lib/sources/base/feed-parser.ts`)
  - discovery 経路（RSS が無いセクション向け）: `src/lib/sources/sitemap-discovery.ts` -> `src/lib/sources/access-discipline.ts` -> `src/lib/sources/article-text.ts` -> `src/lib/pipeline/discovery-ingest.ts`（§6.3）
- **oEmbed fallback**:
  - `src/lib/embed/oembed.ts` 及び `src/lib/embed/providers.ts` による堅牢な埋め込み取得と障害時フォールバック。
- **Pipeline modules（実処理の単一実装）**:
  - `src/lib/pipeline/ingest.ts`（`runIngest`）: RSS 巡回 → 正規化 URL での重複排除 → upsert → 未キュレーション/再キュレーション対象の予算内選定 → LLM 一括キュレーション、までの一連の処理。`/` は `export const dynamic = "force-dynamic"` でキャッシュを経由しないため、以前ここにあったフィードキャッシュの明示的失効（`revalidateTag`）は不要になった（詳細は §6.5）。
  - どちらも「呼び出し元（Route Handler か Server Action か）に依存しない」ことを目的に切り出されており、`src/app/api/ingest/route.ts` および `src/app/actions.ts` はいずれもこれらの薄いラッパーに過ぎない。ロジックを二重実装しないことが本設計の前提。

### §6.1 収集トリガーの 2 経路

収集パイプラインを起動する経路は次の 2 つのみであり、いずれも最終的に上記の pipeline モジュールを呼ぶ。

1. **`/admin` の収集ボタン（Server Action）**: `src/app/actions.ts` の `triggerIngest()` を、`src/app/admin/page.tsx` 上のボタン（`src/components/admin/ingest-status-panel.tsx` / `src/components/admin/operator-panel.tsx`）が呼び出す。`/admin/:path*` は `src/middleware.ts` が Basic 認証（`ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD`）で保護しており、オーナー限定の操作である。UI・ミドルウェアだけでは防御にならないため、`triggerIngest()` はそれ自身の実行時にも `src/lib/auth.ts` の `isBasicAuthorized()` で同じ資格情報を再検証する多層防御を取る（§6.2 参照）。`triggerIngest()` の濫用防止はこれに加えて §6.4 の lease（排他ロック）と DB クールダウンが担う。
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
`src/lib/pipeline/evergreen-via-pipeline.ts` の `curateEvergreenUrlViaPipeline()` が URL 正規化 → OGP/JSON-LD
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
  の `extractHtmlTitle()` で元タイトルを取得し、続いて**記事本文コンテナの
  切り出し → 判定スライスの抽出**の2段階で判定対象を得る（詳細は §10-4 第4項）。
  切り出しに失敗した場合、または判定スライスが `hasSufficientEvidence()`
  （文字数閾値 `MIN_EVIDENCE_INPUT_CHARS`）未満の場合、あるいは `<title>` が
  取得できない場合は LLM を呼ばずに `pending` 保存（または `skipped`）とする。
  条件を満たせば `curateSingle()` に判定スライスを渡し、キュレーション結果を
  `published` として `post_rationales`（§5）を含めて保存する。
  **`posts.original_excerpt` には常に `null` を保存し、抽出した本文は
  いかなるカラムにも永続化しない**（§10-5。DB への書き込みは
  `upsertPosts()` に渡す直前のオブジェクトで `originalExcerpt: null` を
  明示している）。`sourceId` は既存のエバーグリーン経路と同じ
  `EVERGREEN_SOURCE_ID`（`"evergreen"`）を共有する。
  ランは 1 回の実行時間予算（`DISCOVERY_INGEST_TIME_BUDGET_MS`、既定 15分）を
  超えたら残りを次回ランに委ねる。kill gate 発火（§10-6）・B1（日次リクエスト
  予算超過。§10-6 直後の小見出しを参照）または `Retry-After` 指定を受けた
  ホストは、そのランの残り URL の処理を即座に中断する（継続は無意味かつ
  無礼であるため）。
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

収集トリガー（`triggerIngest`）はいずれも `/admin` 配下（オーナー限定）に置かれ、同一の認可モデルを共有する。以前は 2 つの異なる仕組み（収集ボタン: 無認証で公開 + DB クールダウンのみ、URL 投入: `ENABLE_ADMIN_CONTROLS` 環境変数フラグ）を使い分けていたが、収集ボタンを `/admin` へ移したことで両者を Basic 認証に一本化した。`ENABLE_ADMIN_CONTROLS` は廃止し、`adminControlsEnabled()` は削除した。

**多層防御は 2 段構成**:

1. **ミドルウェア（入口）**: `src/middleware.ts` が matcher `/admin/:path*` で Basic 認証（`ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD`）を強制する。Edge ランタイムのため Web Crypto (`crypto.subtle`) でタイミングセーフに比較する。未設定の場合、本番環境は `503`、開発環境は無認証で通す（`NODE_ENV` で分岐。ページの入口としてローカル開発の利便性を優先している）。
2. **Server Action（多層防御）**: `src/lib/auth.ts` の `isBasicAuthorized()` が `triggerIngest()` それぞれの実行時にも同じ資格情報を再検証する。**実際のアクセス制御はこの再検証である**。ミドルウェアだけでは防御にならない（Server Action は URL さえ知っていれば UI・ミドルウェアを経由せず直接呼び出せるため）。`isBasicAuthorized()` は `isBearerAuthorized`（CRON_SECRET）と同じ **fail-closed** 方針を取り、環境変数が未設定なら無条件に拒否し、`NODE_ENV` によって認証ロジックを分岐させない。**そのためミドルウェアと異なり、ローカル開発でも `ADMIN_BASIC_AUTH_USER` / `ADMIN_BASIC_AUTH_PASSWORD` を設定しない限り、収集ボタンの実行は常に失敗する**（詳細は `.env.local.example`）。認証に失敗した場合、Server Action とも生の認証エラーの内部情報を含まない固定文言（`ADMIN_DISABLED_MESSAGE`）を返す。

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

`config` テーブルが存在しない環境（マイグレーション未適用の本番、`scripts/gates/smoke-test-http.sh` が意図的に空にする DB 等）では、`src/lib/db/repository.ts` の読み取り関数と書き込み関数を**意図的に非対称**に扱う。

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

**判断根拠**: このページのトラフィックはほぼゼロで、`getFeedCards()` のクエリも最大12件の単一フィードの単純な SELECT に過ぎない。ISR の利得（DB 負荷の軽減）より、「オーナーが `/admin` から収集した直後に結果をここで確認できない」ことの損失の方が大きいと判断し、キャッシュ層ごと撤去した。これに伴い `FEED_CACHE_TAG` 定数と、`ingest.ts` / `submit-url.ts` の `revalidateTag()` 呼び出しも削除した。`/admin`（`src/app/admin/page.tsx`）も同様に `force-dynamic` とし、クールダウン状態と直近ラン結果（`last_run_summary`）を常に最新の DB 状態で表示する。

---

## 7. Test Strategy

### §7.1 Tiered Coverage Targets

Tier の区分・対象モジュール・ターゲット網羅率は `scripts/gates/check-coverage-tiers.mjs`
を単一の真実とする（spec には数値を持たせない。二重管理による乖離を防ぐため）。
大枠は「法務・公開ゲート系は最も高く / パイプライン・スコア系は中位 / RSC・UI は
網羅率対象から除外」であり、正確な閾値と割り当てはスクリプトを参照。

除外された RSC・UI の担保手段は、`tests/ui/`（`feed-card.test.tsx` /
`feed-lane.test.tsx` / `loading.test.tsx` / `smoke-contract.test.tsx`）のコンポーネントテストと、二層の
smoke test である。ローカル pre-push（Codex sandbox を含む）の
`scripts/gates/smoke-test.sh` は、実際の `SiteShell` と空の `FeedLaneClassic` を
happy-dom でレンダリングする contract smoke であり、公開ヘッダー、main の空状態、
footer の AI 開示、GitHub Issues の削除要請リンクを DOM として検証する。これは
spawn・listen・build・HTTPを行わないため sandbox でも実行可能だが、production build、
RSC、runtime、cookie の検証を代替しない。

CI の quality job は `pnpm verify` の後に必ず
`scripts/gates/smoke-test-http.sh` を実行する。この HTTP smoke は in-memory DB（空）で
production build と `next start` を行い `/` を叩き、サイトタイトル・空状態テキスト・
AI 開示テキスト・RSC エラー digest の不在・cookie 書き込みエラーの不在を検証する。
HTTP smoke は必須であり、contract smoke 成功を production build 成功として扱っては
ならない。逐語タイトル表示・外部画像非描画・元記事への
`target="_blank"` + `rel="noopener noreferrer"` 導線・`sourceName` 常時表示と
`author` の非 null 時のみ表示・`rationaleText` / `aiSummary` 非表示・AI 免責の
恒常注記描画といった §10 の法務不変条件は、カードが実際に描画されて初めて検証可能
であり、これらは `tests/ui/` のコンポーネントテスト（`vitest.config.ts` の
`test.projects` における `ui` プロジェクト、`environment: "happy-dom"`）が担う。
`src/app/loading.tsx` の route-level loading UI も `loading.test.tsx` で、status の
読み上げと、`FeedReadStatusTabs` の hydration 前と同じ単一記事レーンの視覚 Skeleton
（`aria-hidden`）、4 件の記事カード一覧を検証する。ローディング中は未読・既読 tab、
件数・もっと見る等の推測情報、記事本文・要約・外部画像・元記事リンクを描画しないことも
同テストの契約とする。
2026-09-01（shared_plan/20 P3）に旧 7 段を 3 段（法務・公開ゲート系 / パイプライン・
スコア系 / その他）へ統合した。あわせて「どの実ファイルにも一致しない tier パターン」の
検出を fail から warn に変更し、未一致件数と一覧は `pnpm verify`（`scripts/gates/verify.mjs`）の
実行終了時に「未一致 tier パターン N件」として必ず表示する（ファイル改名・削除で計測
対象が静かに漏れる事故を検知するための必須の付帯出力）。

### §7.2 機械強制不変条件レジストリ

`src/lib/publish/invariants.ts` の `INVARIANTS` 配列は、パイプライン境界で
**機械的に強制されている**不変条件（`drop` / `degrade` / `throw`）の棚卸しであり、
`tests/pipeline/invariants.test.ts` がその索引として使う。型・ゲートによる強制を
伴わない「規約」はここに載せない（載せると「不変条件」の語の信頼性を損なうため）。
逐語タイトル（`aiTitle` 全経路 null）と discovery 抽出本文の非永続化
（`originalExcerpt: null` 固定＋`assertNoSliceLeak()` の許可リスト方式）は
**運用ポリシー上の規約**であり、その法務要件と実装的強制の詳細は §10 第3項・
第5項に定める。両者の回帰テスト自体は `tests/pipeline/invariants.test.ts` に
（レジストリの id とは切り離した通常の `describe` として）残している。

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

**2026-08-30 のモデル改訂（オーナー判断）**: 全判定項目を boolean → 0/1/2 の
三段階（degree）へ、さらに同日 **0〜9 の整数**へ拡張（小モデルが 0-2 では
ほぼ全項目に上限値を付けて掲載順が実質新着順になったため、分解能を上げる）。
`specific` を「当日の実施内容の具体性」、`weddingDayContent` を「厳密に
挙式・披露宴が実際に行われた当日の実施内容か」に再定義し、旧
`preDecisionOrPhotoShoot` を廃止して `weddingDayContent = 0` に吸収した
（フォト婚・前撮り・リハーサル・式場探し・準備段階・後日談のみの記事は
`weddingDayContent = 0`）。判定項目は 5 つ。

LLM には次の 5 項目を **0〜9 の整数**で判定させ（0=完全に該当しない、
1〜3=わずかに、4〜6=はっきり該当（標準的な良記事）、7〜8=同種記事の中で
明確に上位、9=ほぼ完璧で滅多に付けない）、点数（合計）そのものは出させない
（点数は `src/lib/scoring/usefulness.ts` の純関数 `computeUsefulnessScore()` が
コード側で計算する。この分離により、重み調整が再課金ゼロのコード変更で済む）。

| 項目                | 定義（0-9）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firsthand`         | 書き手が実際に挙式・披露宴を経験した立場から書いているか。新婦本人に限らず、新郎・両家家族、およびプランナー・司会者・カメラマン・装花担当など式に立ち会う職能者の実務経験も含む。9に近い=当事者本人が固有のエピソードを多数交えて書いている、中位=当事者だが概説的または近しい立場からの一般論、0=第三者・まとめ・伝聞のみ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ceremonyDecision`  | 挙式・披露宴の**中身**の意思決定（進行・タイムライン・演出・席次・席札・余興・スピーチ・BGM・装花・料理・引出物・ペーパーアイテム・挙式当日の写真/映像・ゲストの過ごしやすさ・当日段取り）に効くか。高い=複数項目について「何を・なぜそう決めたか」の判断材料が豊富、中位=関わる話題に触れる、0=ほぼ無関係                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `specific`          | **当日の実施内容の具体性**。固有の選択・数値・実際にやったこと／やらなかった理由・現場でどう進んだかの明確さ。高い=複数の場面で具体的な選択・数値・理由が詳述、中位=一部具体的だが要点は抽象的、0=心構え・一般論・感想のみ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `weddingDayContent` | **式当日に会場で実際に起きた事実**が、実体験として書かれているか。判定の第一関門は**時制**。過去形・完了形で「当日に起こったこと」が具体的に書かれている=最高（「入場曲が流れた」「料理が出た」「ゲストが泣いた」等）。当日の予定・計画・手配・準備の延長（「当日は○をする予定」「当日お渡しする」「先に出す」「〜てもらいます」等、予定形・未完了の手配）は当日の実施内容ではない（specific には効いてよいが weddingDayContent では対象外）。語の有無ではなく「当日に会場で起きた事実」対「当日に向けた準備」の区別で判定。高い=当日の複数の場面が時系列で「起こったこと」として描写、中位=当日に起きた事実が断片的・1場面だけ、**0=前撮り・後撮り・フォトウェディング等の別日撮影、リハーサル、前日までの準備・搬入、式場探し・見積もり比較・日取り決定・規模や形式の合意形成、後日談・振り返りのみ、あるいは挙式披露宴を伴わない内容、および当日の予定・準備・手配（予定形）のみ** |
| `promotional`       | 事業者の集客・自社サービスへの誘導の度合い。判別基準は「読者が別の会場・別の業者で式を挙げる場合にも役立つか」。0〜1=集客要素が実質的にない、中位=言及や導線はあるが主目的は情報提供で他式場でも役立つ（**減点なし**）、7以上=文章中で過剰かつ明確に自社サービス・特定式場への誘導（**減点対象**。実例紹介に安易に高得点を付けない）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

スコア計算式（`USEFULNESS_GATE_BONUS` 等の重み定数は `src/lib/constants.ts`
に定義する。同じ式が純関数 `src/lib/scoring/usefulness.ts` の
`computeUsefulnessScore()` と SQL 文字列 `src/lib/db/query.ts` の
`USEFULNESS_SCORE_SQL` の2箇所に手書きで存在し、両者の一致は
`tests/feed-order-parity.test.ts` が判定値の代表値 `{0,1,5,7,9}` の全
組み合わせ（5^5 = 3125 通り）で検証する）:

```
gate  = (ceremonyDecision >= 1 && weddingDayContent >= 1) ? USEFULNESS_GATE_BONUS : 0
score = gate
      + USEFULNESS_WEIGHT_CEREMONY_DECISION      * ceremonyDecision
      + USEFULNESS_WEIGHT_FIRSTHAND              * firsthand
      + USEFULNESS_WEIGHT_SPECIFIC               * specific
      + USEFULNESS_WEIGHT_WEDDING_DAY            * weddingDayContent
      - USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY    * (promotional が減点発火閾値以上)
```

これらの重み定数・ゲート分の**数値**は `src/lib/constants.ts`
（`USEFULNESS_GATE_BONUS` / `USEFULNESS_WEIGHT_CEREMONY_DECISION` /
`USEFULNESS_WEIGHT_FIRSTHAND` / `USEFULNESS_WEIGHT_SPECIFIC` /
`USEFULNESS_WEIGHT_WEDDING_DAY` / `USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY`）を
単一の真実とする（spec には値を持たせない）。`promotional` の減点発火閾値は
`src/lib/scoring/usefulness.ts` の `computeUsefulnessScore()` と
`src/lib/db/query.ts` の `USEFULNESS_SCORE_SQL` を真実とする。
各項目は `重み × 値(0〜9)` を独立に加算する。`ceremonyDecision` と
`weddingDayContent` はそれぞれ加算項でありつつ、両方 `>= 1` のときだけ
`USEFULNESS_GATE_BONUS` を付ける**ゲート**でもある。`promotional` は減点発火閾値
以上のときのみ `USEFULNESS_WEIGHT_PROMOTIONAL_PENALTY` を引く（それ未満は無罰則）。

**ゲートの意義**: 単純な加算項だけにすると「衣装だけの記事だが firsthand=2・
specific=2・weddingDayContent=2」が「式の中身に効くが浅い記事」を上回り、
「これから式の中身を決める読者に効く記事を優先する」という編集方針が反転する。
旧 `preDecisionOrPhotoShoot`（式決定前/別撮影の話題）は `weddingDayContent = 0`
に吸収済み——フォト婚・前撮り・式場探し・準備段階のみの記事は
`weddingDayContent = 0` となりゲート不通過帯（`< 70`）に沈む。

**強支配（strong domination）不変条件**: ゲートを通過した記事は、たとえ
`promotional >= 7` の減点を受けていても、ゲート不通過帯のどれだけ質が高い記事にも
常に勝つ。

- ゲート不通過の最大 = `9×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)`
  （`ceremonyDecision = 0` の場合。`weddingDayContent = 0` かつ `ceremonyDecision = 9`
  の場合も `9×(W_CEREMONY + W_FIRSTHAND + W_SPECIFIC)` で同値）
- ゲート通過の最小 = `GATE_BONUS + W_CEREMONY×1 + W_WEDDING_DAY×1 - PROMO_PENALTY`
  （`cd=1, wdc=1, firsthand=0, specific=0, promotional` は減点発火帯）
- 不変条件（**性質**。具体的な数値ではなくこの不等式の成立が要件）:
  `GATE_BONUS + W_CEREMONY + W_WEDDING_DAY - PROMO_PENALTY > 9×(W_FIRSTHAND + W_SPECIFIC + W_WEDDING_DAY)`
  を `tests/usefulness-score.test.ts` が `src/lib/constants.ts` の定数から式を組み立てて
  固定している。重み定数の値を動かす場合はこの不等式を保つこと（`USEFULNESS_GATE_BONUS`
  の JSDoc に導出あり）。

**判断材料が無ければ 0 に倒す**: どの項目も抜粋から情報が得られない場合は 0
とする（あるだろうと推測して 1/2 にしない。§9.4）。これにより情報不足の記事を
誤って重く扱わない。

**後方互換（DB マイグレーションを行わない設計判断）**: 旧 shape の
`criteria_json`（5 boolean ＋ `promotional` の文字列 enum ＋ `preDecisionOrPhotoShoot`
キー）は読み取り時に `normalizeCriterion` / `normalizePromotional`
（`src/lib/scoring/usefulness.ts`）が 0-9 に吸収する: 旧 `true → 9`、`false → 0`、
`promotional` は `heavy → 9 / light → 4 / none → 0`、旧 boolean `promotional true → 4`
（減点対象の 7 には昇格させない）。SQL 側は `json_extract` が JSON の `true`/`false`
を `1`/`0` に変換するため旧 boolean 行は自然に 0/1 として読める。この差は
`CURATION_PROMPT_VERSION` bump ＋ 全件再キュレーションが速やかに解消する。

**重み**: `firsthand`（3）> `ceremonyDecision`/`specific`/`weddingDayContent`（各 2）は、
抜粋（記事冒頭）からの判定しやすさに比例させたもの。`promotional` の減点（4）は
ゲート通過記事でも集客・誘導に支配された記事を上位に出さない編集方針の強さを
反映し、`promotional >= 7` のときのみ発火する。

### §9.4 判断材料が無ければ 0 に倒す

LLM が判定に必要な情報を十分に得られない場合（抜粋が短すぎる等）、各項目は
正の値ではなく `0` に倒す。自信を持って誤判定して不適切な記事を上位に
押し上げるより、判定を保留して新着順相当の位置に留まる方が実害が小さい
という判断による。

### §9.5 未スコア投稿の扱い

LLM によるキュレーションが一時的に失敗した投稿、および原文テキストが存在せ
ず要約を生成できない投稿（次章 §10 の要件 4. 参照）には、`src/lib/scoring/usefulness.ts`
の `UNSCORED_USEFULNESS_SCORE`（固定値 20）を用いる。この値は現在の式では
「ゲート通過帯の下限（`USEFULNESS_GATE_BONUS` = 70）より下、かつ全項目
0（0点）より上」の**楽観的な中位**に意図的に置いており、無条件で最下位
に落とすことはしない。最下位に固定してしまうと、一時的な LLM 失敗によって
新着の良記事が静かに埋もれてしまうためである。次回 ingest で
`post_usefulness_criteria.signature` が `posts.curation_signature` と
不一致になった投稿として再スコア対象に検出され、自然に正しい位置へ移動する。

### §9.5a プロンプト変更時の `CURATION_PROMPT_VERSION` bump 義務

`computeCurationSignature()`（`src/lib/llm/signature.ts:31-36`）は
`sha256("v" + CURATION_PROMPT_VERSION + "\0" + LLM_MODEL)` の先頭16文字を
返す。**入力は `CURATION_PROMPT_VERSION` と `LLM_MODEL` の2定数のみ**であり、
プロンプト本文・判定項目定義は含まれない（重み定数の除外と同設計。詳細は
`signature.ts:21-29` のコメント参照）。

したがって、`src/lib/llm/prompts.ts` のプロンプト本文や判定項目定義を
変更した場合、**必ず** `src/lib/constants.ts` の `CURATION_PROMPT_VERSION` を
bump しなければならない。bump がないと `getStaleCurationCandidates()` が
対象0件を返し、再スコアが走らない。

- **pre-commit チェック**: `scripts/check-prompt-version-bump.sh` が
  `prompts.ts` が staged なのに `CURATION_PROMPT_VERSION` が変更されていない
  場合に警告する（advisory・非ブロッキング）。
- **履歴**: v2 で有用度判定5項目追加、v3 で `preDecisionOrPhotoShoot` 追加、v4 で見出し修正、v10 で topicAnchor 緩和、**v11 (2026-08-30) で全判定項目 0-2 化・`specific`/`weddingDayContent` 再定義・`preDecisionOrPhotoShoot` 廃止**、v12 (2026-08-30) でスケール使い方の校正、**v13 (2026-08-30) で判定レンジ 0-2 → 0〜9 拡張・`weddingDayContent` を「厳密に式当日」と強調・`USEFULNESS_GATE_BONUS` 16→70**、**v14 (2026-08-30) で `weddingDayContent` 判定を「時制・実証性」基準に強化**（予定・準備・手配の予定形は当日の実施内容として上げず、過去形・完了形で当日に会場で起きた事実が具体的に描写された場合に高く評価）。
  `prompts.ts` 変更（PR要素のenum化、コミット `a8d4f0f`）では
  version bump が見落とされ、87件全件の再スコアが未実施だった
  （`shared_plan/11` §4 参照）。

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
    `json_extract` に統一する）。**`promotional` は 2026-08-30 に数値 0/1/2、さらに 0〜9 へ再変更した**が、旧レコード（文字列 enum）互換のため `USEFULNESS_SCORE_SQL` の `promotional` 減点は `CASE WHEN json_extract(criteria_json, '$.promotional') = 'heavy' OR (json_extract(...) + 0) >= 7 THEN 1 ELSE 0 END` で新旧両対応にしている。`+ 0` は数値文脈を強制するためで、これが無いと SQLite の型親和性により `'light' >= 7` のような文字列比較が予期せず真になりうる。`json_extract` は文字列値をクォート
    無しの TEXT（`heavy`）で返すため比較対象は `'heavy'` でよいが、これを
    `->` に書き換えると JSON テキストとして `'"heavy"'`（ダブルクォート
    込み）が返るようになり、`= 'heavy'` に永久に一致しなくなる——つまり
    `heavy` 判定の記事が二度と減点されなくなる。真偽値の罠（`->` が
    `'true'` を返し `= 1` に一致しない）と結果的な失敗モードは同じだが、
    原因は「型が変わる」ではなく「文字列がクォートされる」点であることに
    注意する。純関数 `computeUsefulnessScore()` との一致は `tests/feed-order-parity.test.ts` が全 3^5 = 243 通りの判定組み合わせで検証する。
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
- 判定根拠（`post_rationales` 行）の存在は掲載可否の条件として用いる。
- 公開面には `topicAnchor`（1件）と **AI 選定トピックタグ**（`post_topics`、0〜4件の短い名詞句。abstain = `[]` または 1 件は有効、validated by gate、category や trend へのフォールバックは行わない。`src/lib/publish/gate.ts` の `validateTopics()` を通過したもの）を描画する（`src/components/feed/feed-card.tsx`）。トピックタグは分類・走査性のための短ラベルであり、`topicAnchor` とは役割が異なる（重複許容・結論非開示。詳細は §10-3 と `shared_plan/18`・`shared_plan/23`）。トピックが存在しない投稿（discovery 由来で再取得に失敗した等の恒久欠損）はタグ群ごと非表示にする。
- 有用度判定 4 種（`firsthand`/`ceremonyDecision`/`specific`/`weddingDayContent`）は **並び順（`USEFULNESS_SCORE_SQL`）にのみ用い、公開面には描画しない**（旧「判定基準タグ」テキスト行は `shared_plan/18` Stage 4 で撤去）。`rationaleText`・`aiSummary`・`promotional` も公開面には描画しない。根拠文（`renderRationaleText`）のラベルは値 `>= 2` の 4 項目のみ（`promotional` は §10-3 により対象外）。
- AI 由来である旨の開示（`shared_plan/18` §5-1）: カード単位の「AI判定」バッジ（旧 `Badge` の `ai` バリアント）は撤去し、開示は (1) トピックタグのコンテナ（`<ul role="list">`）の `aria-label` と `title` 属性に免責文、(2) 各レーンヘッダ直下の恒常注記1行（`src/components/feed/feed-lane-classic.tsx`）、(3) `src/app/layout.tsx` のサイト全体注記、の3点で担保する。フッターは無限スクロールで到達不能になるため使わない。
- 参照行 `src/components/feed/feed-card.tsx` を維持する。
- タイトル取得の全経路で `normalizeTitle()`（`src/lib/sources/base/feed-parser.ts`）が改行・タブ・U+2028/2029・連続半角空白を単一空白に正規化し前後を trim する（U+3000 全角空白は逐語性維持のため正規化対象外）。
- `src/lib/publish/gate.ts` の `CONTROL_CHAR_RE` は C0/C1（タブ・改行を除く）を検知する最終防衛線ではなく、ホワイトスペースの正規化は取得段階の `normalizeTitle()` が担う旨をコメントで明記している。
- 両フェーズとも `posts.status = "published"` が前提条件であり、
  §10-4 の決定的ゲート（判定に足る原文テキストが存在しない）を満たさない
  投稿は `post_rationales` 行を持たない・`status` が `"pending"` のまま
  留まるため、いずれのフェーズでも表示されない（§10-4 の不変条件と整合する）。

### §9.10 表示件数とページング

トップページ `/`（`src/app/page.tsx`）の表示件数まわりの規則。並び順そのもの
（§9.6 のスコア降順 → `publishedAt` 降順 → `id` 降順）はここでは変更しない。

- 初期表示件数は `FEED_PAGE_SIZE`（`src/lib/constants.ts`）で、この定数を
  唯一の真実の源とする。**具体的な数値は spec に持たせない**（§7.1 のカバレッジ
  tier と同じ方針。二重管理による乖離を防ぐため）。
- 表示件数は `?count=` クエリパラメータで指定できる。「もっと見る」は状態を
  持つクライアント要素ではなく、次の件数を指す通常のリンク（例:
  `/?count=<次の件数>`）として実装されている。これによりページは Server
  Component のままとなり、JS 無効環境でも機能する。
- `?count=` は zod で検証・クランプする。整数・正数・`FEED_PAGE_SIZE_MAX`
  （`src/lib/constants.ts`）以下であることを要求し、非数値・0以下・小数・
  上限超過はすべて既定値 `FEED_PAGE_SIZE` にフォールバックする。未検証の
  値をそのまま `getFeedCards()` の `limit` に渡すと、任意の `?count=` 値で
  過大なクエリを踏ませられるため、この検証は必須の防御である。
- 「続きがあるか」の判定は `limit + 1` 件取得し、実際に返す件数を超えて
  行が取得できたかで判定する方式を用いる。総件数を数える別クエリは持たない。
- 「もっと見る」は、続きが無いときは描画しない。また `FEED_PAGE_SIZE_MAX`
  に達しており次の件数が現在の件数と変わらない場合も描画しない（押しても
  件数が増えない死んだボタンを作らないため）。
- JavaScript 初期化後のタブ UI では「もっと見る」は**未読タブだけ**に表示する。
  表示中件数は `?count=` の取得範囲全体ではなく、その範囲内で分類された未読カード数
  （「未読 N件を表示中」）とする。既読タブには表示中件数、補足文、導線を一切表示しない。
  一方、SSR と JavaScript 無効時の単一一覧フォールバックでは従来どおり総ロード済み件数と
  通常リンクの導線を維持する。
- **既知の制約**: 上記の帰結として、`FEED_PAGE_SIZE_MAX` を超える件数の
  投稿はこの画面から到達不能である。到達させるにはオフセット方式の
  ページネーションが必要だが、現時点では未実装。
- ページは引き続き `export const dynamic = "force-dynamic"` であり、
  キャッシュ方針はこの変更で変わっていない。

### §9.11 ブラウザローカルの既読状態

トップページの既読状態は、閲覧者自身のブラウザにのみ保存する。サーバー、DB、API、
収集・公開パイプラインには送信・保存しない。保存形式は localStorage の
`wedding-trend.feed-read-status` に置く V1 のカード ID 配列だけであり、数値 ID は
`String(id)` に正規化する。記事本文、`originalTitle`、トピックアンカー、URL、または
カード全体の情報を localStorage に永続化してはならない。

- 初期 HTML と JavaScript 無効時は、ロード済みカードを単一一覧として利用可能にする。
  クライアント初期化後は、保存済み ID により「未読」と「既読」へ分類する。元記事を
  開くリンクの操作時に同期的な best-effort で ID を既読として記録し、リンク遷移は
  妨げない。既読タブでは主タッチによる水平左スワイプ（48px 以上、縦方向32px以下）か
  「未読に戻す」ボタンを操作して ID を未読へ戻せる。リンクやボタンなどの操作要素を
  起点にスワイプを開始してはならず、スワイプ成功直後に生じる click は一度だけ抑止して
  元記事を誤って開かないようにする。通常のタップとリンク遷移は妨げない。
- localStorage の読み書き、JSON 解析が失敗してもフィードと外部リンクは利用可能なまま
  とする。書き込み不能時も、そのコンポーネントがマウントされている間はメモリ上の既読
  状態を維持する。未知の保存バージョンは無視し、上書きも削除もしない。
- 分類対象は現在ロード済みのカードだけである。`?count=` の取得件数・通常リンクによる
  ページング・サーバー側の並び順は変更しない。既読カードで未読件数を補充取得せず、
  ロード範囲外の既読 ID からカードを再構成しない。`?count=` により追加ロードされて
  新たに届いたカードは、その ID が保存済み既読 ID に無い限り必ず未読として分類する。
- タブは manual activation の ARIA Tabs とし、未読・既読の件数と各空状態を表示する。
  矢印キー、Home/End はフォーカス移動のみ、Enter/Space は選択に用いる。

---

## 10. 法務制約 (Legal Constraints)

本章は本プロジェクトの唯一の法務仕様である。改訂履歴: 当初 AI 要約を出力する
設計だったため §10-3/§10-4 は「要約の表現制限」を前提に書かれていた。判定根拠
（トピックアンカー＋根拠文）への転換（`shared_plan/06-rationale-and-scraping.md`）
に伴い、§10-3 を「出力は記事の性質についての言明であり内容の配達ではない」に、
§10-4 を摂取経路に依存しない一般形に、それぞれ書き換えた。§10-5・§10-6 は
本文取得による discovery 経路（§6.3）の追加に伴う新設項目である。

§9.11 のブラウザ既読状態にも非永続化原則を適用する。localStorage へ保存できるのは
カード ID のみであり、記事本文、逐語タイトル、トピックアンカー、URL、著者・出典を
含むカード情報を複製してはならない。

1. **元ソースへの導線が最優先 CTA**: すべてのカードにおいて、元投稿・記事へのリンク（または公式埋め込み）を明確なメインアクションとして配置する。
2. **著作者名の必須クレジット**: 引用（著作権法第32条）の要件を満たすため、カード上に著者名・情報源名を必ず表示する。`sourceName` は常時表示し、`author` は非 null の場合に表示する。
3. **出力は記事の性質についての言明であり、内容の配達ではない（トピックタグ等を含む。また公開は (a) 他人の表現（記事本文の逐語断片）を含まず (b) 自らの出力は非創作的な短ラベル（トピックタグ等）に限り (c) 根拠文は決定的テンプレートのみ、という自己記述）**（ゼロクリック化の回避）:
   - **タイトルは `originalTitle`（元記事タイトル）の逐語表示**。AI によるタイトルの生成・書き換えは行わない（`src/components/feed/feed-card.tsx` は `card.originalTitle` をそのまま表示する）。他人の記事タイトルを AI が書き換えて表示する行為は同一性保持権（著作権法第20条、非営利免除の無い人格権）への配慮上、本システムで最も改変に近い操作になるため。`aiTitle` カラムは `posts` に残っているが、`ALTER TABLE` 不可の制約上休眠カラムとして残しているだけで、いずれの摂取経路（RSS 自動巡回・`/admin` 手動投入・discovery）も `markCurated()` 呼び出し時に `aiTitle` を渡さず、値は常に null のままである。discovery 経路では、`extractArticleContainer()` が切り出したコンテナ内の見出し要素（`www.mwed.jp` は `h1.story-detail-main-visual-header__title`）から `originalTitle` を取得し、取得できない場合のみ従来どおり `<title>` タグ由来の値（`記事見出し - 会場名の事例 | みんなのウェディング` のようにサイト名・定型句が付随する）にフォールバックする。これは「元記事タイトルの逐語表示」という本項の要件により忠実な取得手段への変更であり、フォールバック経路自体は引き続き存在する。**この変更は今後取得する記事にのみ適用され、既に `published` として保存済みの投稿（id 233〜237 を含む）の `originalTitle` はバックフィルされない**（h1 由来の値を得るには記事本文の再フェッチが必要なため）。
   - **判定根拠文（`rationaleText`、`post_rationales.rationale_text`）は 38〜210字**とし、記事固有の具体数値（半角・全角数字）を含めないことを方針とする。**ただしこの禁止は機械的には強制されていない**（2026-08-31 訂正）。`CurationItemSchema` に `rationaleText` フィールドは存在せず（根拠文は LLM 出力ではなく `renderRationaleText()` がテンプレートから合成する設計に転換済み）、根拠文へ数字が混入しうる唯一の経路である `topicAnchor` の数値 denylist も 2026-08-29 のゲート緩和（第2段）で撤廃されている。したがって現在の抑止は `RATIONALE_RULES` のプロンプト指示のみに依拠する。下限は `RATIONALE_TEXT_MIN_CHARS`（`src/lib/constants.ts`。値 38）、上限は `RATIONALE_TEXT_MAX_CHARS`（同ファイル。値 210）として、いずれも `renderRationaleText()` 自身が機械的に強制し、逸脱した根拠文は例外を投げて公開させない。
     - **下限38字の決め方（2026-08-25）**: 上限と同じく構造的な値から決めており、実測分布からの帰納ではない。`renderRationaleText()` の出力は `topicAnchor` と有用度 5 つの 0-2 判定値のみで決まる決定的関数だが、`topicAnchor` の理論上の zod 下限（`CurationItemSchema` は `min(1)`）は公開経路には到達しない——`topicAnchor` が1字の場合、`validateTopicAnchor()`（`src/lib/publish/gate.ts`）内の `checkAnchorGrounding()` の `extractFeatureTerms()` が長さ2未満の語を特徴語として採用しないため特徴語ゼロとなり、接地失敗として扱われ、フィードバック付き再試行ののち `topicAnchor=null` で公開（`post_rationales` 行を生成しない＝デグレード）される（各パイプラインは `curateSingle` / `curateBatch` 経由で `validateTopicAnchor` を通し、アンカー検証失敗時は `topicAnchor=null` で公開する）。一方、有用度 5 項目全 0 の投稿を公開前に止める閾値ゲートは存在しない（`computeUsefulnessScore()`＝`src/lib/scoring/usefulness.ts` はソート用のスコアを返すのみで、公開可否の判定には使われない）ことも確認済み。したがって**公開経路に実際に到達しうる構造的最小値**は「`topicAnchor` が最小の2字、有用度 5 項目すべて 0」のケースであり、`renderRationaleText()` で実測すると38字（2026-08-30 のラベル 4 項目化・`weddingDayContent` ラベル文言変更後も 38 字で不変）（`「あい」に関する記事です。自動判定では特筆すべき特徴は検出されませんでした。`）になる。この値は `tests/publish-gate.test.ts` にリテラルで固定している。テンプレート文言を変更した場合はこの構造的最小値を測り直すこと。**2026-08-31 訂正**: 上記の導出は `validateTopicAnchor()` が `checkAnchorGrounding()` を含んでいた時点の記述である。2026-08-29 のゲート緩和（第3段）で接地検証は撤廃され、現在アンカー長を律するのは `checkAnchorLength`（`ANCHOR_MIN_LENGTH = 6`）のみ。したがって「2字」を起点とする導出はもはや成立しないが、実際の下限が 6 字へ上がったことで構造的最小値は 38 字以上にしかならず、`RATIONALE_TEXT_MIN_CHARS = 38` は依然として下回られない。
     - **改定の経緯（2026-08-25 当初）**: 当初の要件は 60〜90字だったが、コンテナ抽出導入後に初めて公開された5件（id 233〜237）はいずれも実測146字で、要件に違反していた。原因は `src/lib/publish/gate.ts` の `renderRationaleText()` が、`topicAnchor` と有用度判定のうち値 `>= 2` のラベルを `「{anchor}」に関する記事で、{ラベル1}、{ラベル2}…という特徴が自動判定されました。` の形で機械的に連結する**決定的テンプレート**であり、true になったフラグ数に比例して文字数が伸びる構造だったこと。今回の5件は5項目すべてが true だったため、構造的に90字を超過した。これは LLM の応答ブレではなく、テンプレート設計そのものが90字上限を満たせない構造的欠陥だった。公開が0件で続いていたため、この乖離は長期間露見しなかった。
     - **1回目の対応方針（150字。撤回済み・下記参照）**: `renderRationaleText()` の出力を短縮する実装変更ではなく、要件側の上限を150字に緩和する方針を採用した。しかしこの150字は**実測1点（id 233 の146字）のみを根拠に決めた値**であり、`topicAnchor` の長さが9〜29字とばらつくこと（true フラグ数が同じでも `topicAnchor` が長いほど出力全体も伸びる）を勘定に入れていなかった。結果として、150字への改定と同時に公開済み5件のうち3件（id 234=155字、id 235=166字、id 237=158字）が**改定直後の時点で既に上限超過**という状態になっていた（id 233=146字、id 236=146字の2件は非超過）。単一サンプルから閾値を決めると分布の裾で破綻するという教訓であり、同種の失敗は本 spec 内の他の閾値でも起きている——`boilerplateLineRatio`（閾値0.5、観測最小値0.501の直下という際どい校正）や `MAX_LINK_DENSITY`（閾値0.35、観測分布のほぼ中央に置かれた未校正の暫定値。§10-11 参照）も、実測分布の広がりを十分に見ずに数値を固定した点で同じ性質の問題を抱えている。
     - **2回目の対応方針（210字。今回・恒久対応）**: 150字も実測ベースの暫定値である以上、同じ失敗を繰り返しかねない。そこで**実測値からではなく、構造的最大値から上限を決め直した**。`renderRationaleText()` の出力を決める変数は `topicAnchor`（`CurationItemSchema` の zod 上限 40字）と、有用度ラベルのうち true になったものの列挙の2つのみであり、当時の6ラベル構成での理論上到達しうる最大値は206字だった。**210字はこの構造的最大値（206字）を上回るように決めた値であり、実測分布から帰納した値ではない。** テンプレートが変わらない限り出力は原理的に210字を超えることがなく、`RATIONALE_TEXT_MAX_CHARS` 超過時に発生する `renderRationaleText()` の例外（fail-loud）は「実際に起こりうる異常の検知」ではなく**「起こり得ないことのアサーション」**として機能する。**テンプレート文言や有用度ラベルの文言・個数を変更した場合は、構造的最大値を必ず測り直す必要がある。** この回帰は `tests/publish-gate.test.ts` にテンプレート変更時の構造的最大値検証として固定してあり、構造的最大値が210字を超えた場合はテストが失敗する。
     - **ラベル 6→5 への削減（2026-08-26。`promotional` を根拠文の対象外化）**: 下記「既知の乖離の解消」で述べる経緯により、`src/lib/publish/gate.ts` の `USEFULNESS_LABELS` / `FLAG_ORDER` から `promotional` のラベルを削除した。これにより根拠文を構成しうるラベルは `firsthand` / `ceremonyDecision` / `specific` / `weddingDayContent` / `preDecisionOrPhotoShoot` の5つになった。構造的最大値（`topicAnchor` 40字・全ラベル true）を測り直すと182字であり、削減前の206字より縮む。**`RATIONALE_TEXT_MAX_CHARS = 210` は182字を依然として上回るため変更していない。** 構造的最小値（下限38字。`preDecisionOrPhotoShoot`）はラベル削減の影響を受けず変化しない。この構造的最大値の再計測もテンプレート変更（ラベル文言・個数の変更）に該当するため、`tests/publish-gate.test.ts` のリテラル固定値を追随させる必要がある。 **2026-08-30 (v11) 追記**: `preDecisionOrPhotoShoot` の廃止と `weddingDayContent` ラベル文言変更により、ラベル対象は `firsthand`/`ceremonyDecision`/`specific`/`weddingDayContent` の 4 項目、値 `>= 2` のみが対象。構造的最大値は 169 字（40字アンカー時）、構造的最小値は 38 字で不変。`RATIONALE_TEXT_MAX_CHARS = 210` は据え置き。
     - **この緩和で維持される制約（上限の撤廃ではない）**:
       - 数字（半角・全角）を含めない方針は維持する。ただし機械的拒否は存在しない（2026-08-31 訂正。上記参照）。
       - 原文からの引用・原文固有の表現を含めないという性質は維持する。
       - 判定根拠文は決定的テンプレートのみで組み立て、LLM の自由文を根拠文として直接採用しない設計は維持する。
       - 210字という新上限も**撤廃ではなく機械的な強制**であり、`RATIONALE_TEXT_MAX_CHARS = 210`（`src/lib/constants.ts`）を超えた根拠文は公開処理で拒否される。
     - **公開済み5件（id 233〜237）の扱い**: 上記のとおり id 234・235・237 は150字上限の下では違反状態だったが、今回の210字への改定によりいずれも仕様に適合する（実測最大166字 < 210字）。したがってこれら5件の撤回・再公開処理は不要である。

- **トピックアンカー（`topicAnchor`、`post_rationales.topic_anchor`）は 40字以内**とし、記事が扱う**「具体的な判断・場面・選択肢」**と**この記事ならではの独自性（読者が続きを読みたくなる切り口）**を提示するものとする。文の形（問いかけ・体言止め・述語で結ぶ 等）は指定しない。結論・結果・具体的数値を開示してはならない（不可: 「席次表は親族優先で決めた」「持ち込み料〇万円が免除された」）。アンカーの機械的検証（`validateTopicAnchor`、`src/lib/publish/gate.ts`）は **長さ下限（`ANCHOR_MIN_LENGTH = 6` 字）と個人識別情報 denylist（SNS ハンドル・敬称付き人名）の2点のみ**。検証に失敗した場合は、アンカー生成を 1 回だけフィードバック付きで再試行し、それでも失敗すれば `topicAnchor` を `null` として**投稿を公開（デグレード）**する。公開に至るまで投稿を破棄（ドロップ）することはない。アンカーの語が原文本文に忠実であること（ハルシネーション抑制）は、プロンプト指示（`RATIONALE_RULES`：記事が扱っていない話題を作らない・煽り表現の禁止）と有用度評価タグに委ねる。- **2026-08-29 のゲート大幅緩和（オーナー判断・4段階）**: (第1段) `checkAnchorDenylist` から clickbait 語群（衝撃・必見・やばい・最高・神・感動 等 16 語）と語尾パターン（`しよう$`・`すべき$`・`\d+つの`）を撤廃。(第2段) 数値・漢数字・金額・日付・元号パターンも撤廃——漢数字パターン `/[一二三四…]/` が「二部制」「三次会」「一緒に」等の非数値語を過剰棄却していたのが契機。denylist に残すのは個人識別情報パターンのみ。(第3段) **語彙的接地検証（`checkAnchorGrounding`＝コーパス許可制度）を `validateTopicAnchor` から撤廃**——アンカーの漢字・カタカナ語が元記事本文に逐語で存在することは要求しない。`checkAnchorLength` の下限を 12 → 6 に緩和。`checkAnchorNovelty`（タイトル冗長性 `anchor_redundant_with_title`）も合否に用いない。(第4段) **プロンプト（`RATIONALE_RULES`）から本文語句の逐語使用指定と文型（「問いを立てる節」）指定を削除**し、代わりに「この記事ならではの独自性を続きを読みたくなる形で提示する」クリック誘引ルールを追加。この第4段のプロンプト変更に伴い `CURATION_PROMPT_VERSION` を 9 → 10 に bump した（`curationSignature` が全ブログ投稿で不一致になり、`scripts/backfill-usefulness.mjs --force` で一括再キュレーションできる）。**2026-09-01（shared_plan/20 P4）**: 呼び出し元の無くなった休眠関数 `checkAnchorGrounding`（語彙的接地検証）と `checkAnchorNovelty`（タイトル冗長性）を `src/lib/publish/gate.ts` から削除した（git 履歴に残る）。現在アンカーに対する機械的検証は `checkAnchorLength`（下限6字）と `checkAnchorDenylist`（PII）の2点のみ。- **改定の経緯（2026-08-28, shared_plan/16）**: §10-3 のトピックアンカー設計をさらに刷新。`shared_plan/15` が導入した「体言止め（名詞で文を終える）」方針を撤回し、読者が抱く問いの形（問いを立てる節）へ変更。接地検証を `checkAnchorGrounding`（トークンレベル＋接続詞許可リストのみ）から `validateTopicAnchor`（文字種非対称の接地＋禁止リスト `checkAnchorDenylist`＋タイトル冗長性 `checkAnchorNovelty`＋長さ `checkAnchorLength`）の合成ゲートへ置換し、検証失敗時の扱いを「終端棄却（ドロップ）」から「フィードバック付き再試行 1 回 → 失敗時は `topicAnchor=null` で公開（デグレード）」へ変更した。数字・固有名詞の禁止は維持する。
  - **判定テスト**: 読者がクリックせずに情報要求を満たせる出力は、原文の代替物になっている。カードあたり事実は最大1つ、否定的評価（`promotional = "heavy"` 等）は公開画面に一切出さない（§9.8 のスコア非公開と一貫させる）。
  - **既知の乖離の解消（2026-08-26）**: `promotional` の boolean → 3 段階 enum 化（`a8d4f0f`）の時点では、`src/components/feed/feed-card.tsx` が `card.usefulness.promotional === "heavy"` のとき「PR要素あり」バッジをカード上に表示しており、否定的評価を公開画面に一切出さないという本項の原則と実装が一致していなかった（旧仕様では `promotional === true` のときに同種のバッジを表示しており、この乖離自体は enum 化以前から存在していた）。**調査の結果、露出経路は2つあることが判明し、いずれも撤去して原則に実装を合わせた**:
    1.  **バッジ（`src/components/feed/feed-card.tsx`）**: 「PR要素あり」バッジそのものを削除した。あわせて、表示すべきバッジが1つも無い場合にバッジコンテナ自体を描画しないよう修正し、空要素・余白の残留を避けた。
    2.  **根拠文中のラベル（`src/lib/publish/gate.ts` の `renderRationaleText()`）**: `promotional === "heavy"` の記事に対して「特定のサービス・会場への誘導を含む可能性がある」という否定的ラベルを根拠文に組み込んでおり、その根拠文は `feed-card.tsx` で本文テキストとして公開表示されていた（バッジより発見しにくい経路だった）。`USEFULNESS_LABELS` / `FLAG_ORDER` から `promotional` を削除し、**根拠文が `promotional` の値に一切影響されない**よう不変条件を強めた。`RationaleUsefulnessFlags.promotional` フィールド自体は呼び出し側との互換のため残るが、根拠文生成では参照されない。この不変条件は `tests/publish-gate.test.ts` で固定する。
    - **`preDecisionOrPhotoShoot` ラベルは 2026-08-30 (v11) に廃止**: 判定項目自体が `weddingDayContent = 0` に吸収されたため、根拠文ラベルからも除去した。
    - **公開済みデータの再生成**: DB に保存済みの `post_rationales.rationale_text` には削除前の文言（`promotional` 由来のラベルを含む根拠文）が残存するため、`scripts/` 配下のバックフィルスクリプトで再生成する。

4. **判定に足る原文テキストが存在しない場合は LLM 判定結果を公開しない（経路非依存の不変条件）**: すべての摂取経路において、LLM キュレーション（`curateSingle`）を呼び出す前に「判定対象となる原文テキストが存在するか」を判定する。「原文テキスト」の定義は経路ごとに異なり、新たな摂取経路を追加する際は必ず本項に定義を追記する。
   - **SNS 手動投入経路**（現在は廃止）: 旧仕様における SNS 投稿手動投入経路の名残り。現在は Stage 2（投入経路停止）により完全撤去されている。
   - **エバーグリーン経路**（`src/lib/pipeline/evergreen-via-pipeline.ts` の `curateEvergreenUrlViaPipeline`）: OGP メタデータの `og:description` / `<meta name="description">`（`meta.description`）のみを指す。`<title>` / `og:title` は表示ラベルであり判定の材料にしない。本文 DOM は一切読まない（`src/lib/sources/ogp.ts` は meta タグと JSON-LD のみを走査する。`tests/ogp.test.ts` がこの不変条件を固定する）。
   - **discovery 経路**（`src/lib/pipeline/discovery-ingest.ts` の `ingestDiscoveredUrls`）: 取得した記事 HTML から、まず `src/lib/sources/article-text.ts` の `extractArticleContainer()` がホストごとの許可リスト `articleContainerSelectors`（`src/lib/constants.ts` の `HOST_ALLOWLIST` 各エントリ）に従って**記事本文コンテナ**（`www.mwed.jp` は `div.story-detail` を第一候補、`div.produce-story-detail` を次点とする優先順のセレクタ配列）を切り出す。いずれのセレクタにも一致しない場合は `null` を返し、コンテナが存在しない記事は判定対象にしない（破損シグナルとしての扱いは §11 参照）。切り出したコンテナの innerHTML から `extractVisibleText()` でノイズ除去後、その**先頭から最大 1,500 字**を**判定スライス**として抽出する（コンテナ抽出前段が入る以前は「ページ全体の先頭 1,200 字をスキップした後続 1,500 字」であったが、口コミ等の第三者 UGC やナビが判定対象に混入する欠陥があったため、コンテナ抽出後の先頭スライスに変更した）。§10-5 の禁止事項と対になる規律であり、この判定スライスは LLM 入力としてのみ使い DB には一切保存しない。この節は `shared_plan/06-rationale-and-scraping.md` §5.3 に対応する運用規律であり、`src/lib/sources/article-text.ts` と `src/lib/pipeline/discovery-ingest.ts` のコード内コメントが参照する「§5.3」は当該 plan ドキュメントの節番号を指す（spec.md 側の対応内容は本項 §10-3〜§10-5 である）。
   - Instagram のキーなし oEmbed エンドポイント（`graph.facebook.com/.../instagram_oembed`）はキャプション本文を一切返さない（`version` / `provider_name` / `provider_url` / `type` / `width` / `html` のみで `title` が欠落する。2026-08-22 の実リクエストで確認済み）。これに対し YouTube の oEmbed は `title` を返す。
   - SNS 経路で原文テキストが両方とも存在しない場合、`runSubmitUrl` は `curateSingle` を一切呼ばず、`status: "pending"` のまま投稿を保存する（`aiSummary` は null のまま）。取得済みの embed（`embedProvider` / `embedHtml` / `embedFetchedAt`）と `url` は保存し、再取得コストを避ける。呼び出し元には安定コード `"needs_source_text"` を返す。
   - エバーグリーン経路で原文テキストが存在しない場合も同様に、`curateEvergreenUrl` は `curateSingle` を一切呼ばず、取得済みのメタデータ（タイトル・著者・サムネイル・公開日）と `url` を `status: "pending"` で保存する。呼び出し元には安定コード `"needs_source_text"` を返す。LLM 失敗時のフォールバック要約も原文テキスト（excerpt）のみから生成し、title へのフォールバックは行わない。
   - discovery 経路では、記事本文コンテナの切り出しに失敗した場合（`extractArticleContainer()` が `null` を返す。理由コード `container_not_found`）、判定スライスが `hasSufficientEvidence()`（`MIN_EVIDENCE_INPUT_CHARS` 文字未満）を満たさない場合、または `<title>` が取得できない場合のいずれかに該当すれば、`curateSingle` を呼ばず `pending` 保存（`<title>` 不在時は保存すらせず `skipped`）とする。これらはすべて LLM 呼び出し前の**決定的ゲート**であり、LLM の自己申告による棄権には依拠しない（決定的ゲートの指標定義とコンテナ未マッチの扱いの設計意図は §11-1 を参照）。
   - 公開の可否は最終的に §9.9 の表示条件（`RATIONALE_DISPLAY_PHASE`）に従う。`status: "pending"` の投稿と `post_rationales` 行が無い投稿はいずれのフェーズでも表示されない。
   - 決定的ゲートを通過した場合は、`curateSingle` によるキュレーション結果を `published` として保存する。
   - **出典クレジット（第 2 項）の解決規則（エバーグリーン経路）**: 出典名は「運営の明示指定（CLI の `--source-name`、前後空白は trim）→ `og:site_name` → URL ホスト名（`www.` を除去した実在ドメイン）」の順で解決する。いずれも解決できない場合、架空のソース名を捏造せずに保存を拒否する（安定コード `"no_source_name"`）。サイト名を示さない固定文字列へのフォールバック生成は禁止。discovery 経路の `sourceName` は `registrableDomain(url)`（解決できなければ対象ホスト名）で決定する（`src/lib/pipeline/discovery-ingest.ts`）。
5. **抽出本文の永続化禁止**: discovery 経路で取得した本文（記事本文コンテナ抽出（`extractArticleContainer()`）を経た判定スライスの出力）は LLM 判定の入力としてのみ使用し、**`posts` を含むいかなるカラムにも永続化しない**。`src/lib/pipeline/discovery-ingest.ts` の `upsertPostRow()` は `originalExcerpt: null` を常に渡し、discovery 経路由来の投稿の `originalExcerpt` は常に `null` になる。理由は3つ: (a) §10-3/§10-4 の「取得・判定は情報解析、公開は (a) 他人の表現（記事本文の逐語断片）を含まず (b) 自らの出力は非創作的な短ラベル（トピックタグ等）に限り (c) 根拠文は決定的テンプレートのみ、という自己記述」という二層構造を維持できる、(b) 「他人の著作物のデータベース」を新たに作らない、(c) 本文が DB に存在すると将来誰かがそれを要約の材料に使う drift を構造的に防ぐ（無ければ使えない）。エバーグリーン経路・SNS 経路の `originalExcerpt`（`og:description` やキャプション等、配信者自身が公開用に提供したメタデータ）とは性質が異なるため区別すること——discovery 経路の抽出本文は配信者が要約用に提供したものではなく、記事本文からの機械的な抽出（複製）である。
   - **topics専用生成時の判定スライス非永続化**: topics専用生成時の判定スライスも同様にメモリ上のみで取り出し、LLM投入後に破棄する。DB、ログ、stdout、checkpoint、telemetry、例外、raw LLM request/response に保存・出力しない。originalExcerptは常にnull。ホスト別共有上限HOST_DAILY_SHARE_MAXは廃止済みだが sequential per-host, 20s/Crawl-delay, 200 cap, robots/ToS/allowlist再検証は維持する。redirectはfinal URLを独立してallowlist/robots/ToS/rateで再検証し、cross-hostも同様、canonicalが別記事または同一性に疑義があればno update。
   - **バックフィル修復時も非永続**: プロンプト/gate を改善した後、discovery 経路で公開済みの投稿は `originalExcerpt` が空のため通常のバックフィル（`scripts/backfill-usefulness.mjs`、プレフライト `shouldRegenerateAnchor()` が本文なし候補を一律スキップ）では再キュレーションされず、旧基準のトピックアンカーのまま固定される。この救済は `scripts/backfill-mwed-anchors.mjs` が行う——対象は `status = "published"` かつ署名不一致の投稿に限定し、`disciplinedFetch()` で本文を再取得し `extractArticleContainer()` → 判定スライスをメモリ上で復元し、1 回の Gemini バッチリクエストで再キュレーションする。**判定スライスはこの経路でも DB へ書き戻さない**: `markCurated()` へ渡す update は `scripts/lib/mwed-anchor-backfill.mjs` の `assertNoSliceLeak()` がキー許可リスト（`url` / `aiSummary` / `category` / `tag` / `contentHash` / `curationSignature` / `usefulness` / `rationale`）で検証し、違反時は throw して中断する。プレビュー出力もトピックアンカーの新旧のみで本文は表示しない。`originalTitle`・`post_publications`（bodyHash / M4）・`discovery_seen`・公開ゲート（撤回判定）は変更しないため公開状態は変わらない。
6. **アクセス規律（discovery 経路の本文取得のみに適用。実装 `src/lib/sources/access-discipline.ts`）**:
   - **robots.txt の遵守**: 取得前に必ず確認し、`isAllowed()` が false を返す URL は取得しない（`blocked_robots` として `discovery_seen` を `skipped` にする）。取得結果は 24 時間以内でキャッシュする（RFC 9309 の推奨）。
   - **`Crawl-delay` を下限として尊重**: robots.txt 内の**いずれかの User-agent グループ**に現れる `Crawl-delay` の最大値と、ホストあたり最小間隔（`MIN_HOST_INTERVAL_MS` = 20秒）の大きい方を実際の間隔とする。自 UA 向けの指定に限定しないのは、サイトが特定のクローラにのみ間隔を表明している場合でも、それはそのサイトが許容するペースの表明とみなせるため。
   - **ホスト内は逐次・ホスト間は並列**: 同一ホストへの直前リクエストからの経過時間を記録し、間隔未満なら待機する。
   - **日次ハードキャップ**: ホストあたり `DAILY_REQUEST_CAP_PER_HOST`（200件）。時間予算（バジェット）は撤廃され、インターバル制御（`MIN_HOST_INTERVAL_MS` = 20s）を主軸とする。この上限は正常時は到達しないバグ時のサーキットブレーカーとして機能する。
     - **変更根拠の限定**: キャップの変更根拠として認められるのは、対象ホストの表明（robots.txt・サイトからの連絡）のみである。**未処理数や公開予定を理由に間隔・上限・gate を緩めない。**
     - **変更履歴**: 2026-09-02: 時間予算（15分バジェット）を全面撤廃し、`MIN_HOST_INTERVAL_MS` を 20,000ms、`DAILY_REQUEST_CAP_PER_HOST` を 200 へ変更。バックフィル時の分断を解消し、インターバル制御を主軸とする設計へ簡素化。
   - **条件付き GET**: `If-Modified-Since` / `If-None-Match` を送り、304 を `not_modified` として扱う。**304はunconditional fetchへフォールバックしない。**
   - **連絡先入り User-Agent**: `CRAWLER_USER_AGENT`（`src/lib/constants.ts`。既定 `WeddingTrendBot/1.0 (+https://github.com/menonaki2/wedding-trend)`）を常に送信する。**UA 偽装は行わない**（実装上、他の UA 文字列に差し替える経路が存在しない）。
   - **取得サイズ上限**: `MAX_BODY_BYTES`（既定 512KB）。`Content-Length` またはボディの実バイト長で判定し、超過時は取得を打ち切る（`too_large`。kill gate ではなく、そのホストではなく個別 URL の事情として扱う）。
   - **同一ホスト concurrency=1**: `same-host concurrency=1` を維持する。
   - **Daily cap算入単位**: daily cap算入単位はrobots/ToS/article/redirect destination再検証ごととする。
   - **same-host concurrency、Crawl-delay、上限、gate**: 同一ホスト concurrency=1、Crawl-delayとMIN_HOST_INTERVAL_MS=20秒の大きい方を待つ、DAILY_REQUEST_CAP_PER_HOST=200、K1-K6 hard stop、B1 soft stop/UTC日次リセット、429 Retry-After、ToS hash/change、allowlist source of truth、host round-robin公平予定を維持する。
   - **kill gate**: 1つでも観測されたら該当ホストの discovery を即座に停止する。回復には人間の再判断（`host_gate_state` 行の手動解除）を要する。実装済みのゲートのみを示す:

     | #   | 観測事象                                                           | 実装上の扱い                                                                                                                           |
     | --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
     | K1  | robots.txt の内容ハッシュが直近取得値から変化                      | `host_gate_state.stateKind = "stopped"`。人間の再確認を待つ（恒久停止ではない）                                                        |
     | K3  | 401 / 451 応答                                                     | `stateKind = "permanent"`。即恒久停止、自動復帰なし                                                                                    |
     | K4  | 記事取得（`purpose: "article"`）で 403                             | 初回は `stateKind = "cooloff"`（24時間）。連続2回目（`k4Strikes >= 2`）で `permanent`                                                  |
     | K5  | robots.txt / sitemap 取得（`purpose` が `robots`/`sitemap`）で 403 | `stateKind = "permanent"`。1回で即恒久停止（配信の意思そのものへの拒否と評価するため）                                                 |
     | K6  | 429 応答                                                           | `Retry-After` を厳密に守って1回だけ再開（`retry_after` verdict）。24時間以内に2回目の429で `stateKind = "permanent"`                   |
     | K9  | （廃止）根拠文の数値禁止違反                                       | **2026-08-31 廃止**。zod `refine` は実装されておらず、この kill gate は成立していなかった。数字の抑止はプロンプト指示のみ（§10 第3項） |
     | K2  | 利用規約テキストが変化                                             | `checkTermsOfServiceChange()`（`src/lib/sources/access-discipline.ts`）。詳細は §10-7 K2                                               |

     **403 を「1回で恒久停止」にしない理由（K4 のみ）**: GitHub Actions の
     Azure IP では WAF 起因の 403 が定常的に起きうるため、1回で恒久停止する
     ゲートは早期に「毎回止まる」状態になり形骸化する。K5（robots/sitemap
     への 403）はこの理由が当てはまらない——媒体側が明示的にアクセス制御用
     エンドポイントへのアクセスを拒否している以上、配信意思そのものへの
     拒否とみなし1回で恒久停止する。
     **未実装のゲート**: K8（採用率低下によるフィルタ/抽出破損の検知）・
     K10（判定根拠と元記事の内容不一致の自動検知）は、本仕様時点でコードと
     して実装されていない。

   #### 日次リクエスト予算 B1（kill gate ではない）

   旧仕様では本項目を `K7` として上記 kill gate 表に含めていたが、**B1 を
   `K7` として kill gate 表に含めたのは誤りであり、その混同が実装（`discovery-ingest.ts`
   が K1〜K7 を同一の `kill_gate` verdict に統合していたこと）に伝播し、
   正常な予算消化のたびに GitHub Actions ワークフローを失敗扱いにする事故を
   起こした。** 上記「kill gate: 1つでも観測されたら該当ホストの discovery を
   即座に停止する。回復には人間の再判断を要する」という総説は無条件のまま
   維持し、例外を設けない。B1 はこの無条件の性質に当てはまらないため、
   kill gate 族から分離し独立の項目として扱う。

   - **観測事象**: ホストあたり日次リクエスト数が `DAILY_REQUEST_CAP_PER_HOST`
     （既定200件）を超過。
   - **性質**: レート制御であり、恒久停止でも人間の判断待ちでもない。
     `host_gate_state.stateKind` は変更しない。その日の残り時間は当該ホストへの
     リクエストを拒否し続けるが、**UTC 日次で自動的にリセットされ、人手の
     解除操作を必要としない**。
   - **verdict の型**: kill gate（K1・K3〜K6・K9）の verdict は `kill_gate`
     （hard）。B1 の verdict は型レベルで区別された `budget_exhausted`
     （soft）とする。`src/lib/pipeline/discovery-ingest.ts` の `ingestDiscoveredUrls()`
     の戻り値は、kill gate 発火を表す `abortedByKillGate`（K1〜K6 専用）と、
     B1 発火を表す `abortedByBudget` を別フィールドとして持つ。
   - **不変条件（終了コードでの区別）**: `scripts/run-discovery.mjs` の終了コードは
     3値: `0` = 正常終了 / `2` = soft stop（`abortedByBudget`。予算消化による
     想定内の停止）/ `1` = hard stop（`abortedByKillGate`）または想定外エラー。
     `.github/workflows/discovery.yml` は終了コード `2` を成功として扱いつつ
     `::notice` とジョブサマリで可視化し、GitHub Issue の自動起票は終了コード
     `1` のときのみ行う。**理由**: 積み残し URL がある限り B1 が毎日発火するのは
     正常な定常状態であり、これを失敗として報告し続けると警報疲れ
     （alert fatigue）を招き、hard stop（本物の障害）を見逃す原因になる。
     soft stop と hard stop を終了コードの段階で機械的に区別することで、
     「kill gate 発火は必ず人間に通知される」という保証を、定常的なノイズで
     薄めずに保つ。

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

11. **外部サイトの画像の転載禁止（画像非表示ポリシー）**: 外部サイトの画像（OGP 画像、サムネイル画像、SNS 埋め込み等）はパイプラインでの処理や内部選定目的で一時的に取得・保存される場合があるものの、公開面（フィードカード等）においては一切再掲載・描画しない。これは中立キュレーションにおける無断転載リスクを排除するための法的・構造的制約である。

12. **新規ホストを `HOST_ALLOWLIST` に追加する際の入場基準（2026-08-25 訂正）**: 新規ホストの追加は以下を満たすことを原則とする。
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

1. **記事本文コンテナ抽出とセレクタ未マッチの扱い（決定的抽出品質ゲート）**:
   `src/lib/sources/article-text.ts` の `extractArticleContainer(html, host)`
   は、ホストごとに `HOST_ALLOWLIST` で定義した優先順のセレクタ配列
   `articleContainerSelectors`（`www.mwed.jp` は `["div.story-detail",
"div.produce-story-detail"]`）を先頭から順に試し、最初に一致した要素の
   innerHTML を返す。**いずれのセレクタも一致しない場合は `null` を返し、
   これ自体を記事取得の破損シグナルとして扱う**（理由コード
   `container_not_found`。§10-4 第4項）。ページ全体を測る旧方式では、
   口コミ領域（`div#point-section-top` 等、第三者 UGC）やサブナビが
   記事本体と兄弟要素として同一ページ内に存在するため判定対象に混入して
   いたが、コンテナ抽出はこれを構造的に排除する。
   - **設計意図**: `container_not_found` を「静かに全文フォールバックする」
     のではなく終端棄却の破損シグナルとして扱うのは、テンプレート変更の
     検知とゲートの本来の目的が一致するため。セレクタが外れる主因は
     ホスト側のテンプレート改訂であり、その場合は旧セレクタで拾える
     箇所が記事本体ではない可能性が高い——「判定に足る本文が実際に
     取れているか」を保証するゲートの目的と、「テンプレートが変わったら
     早期に気づく」という運用上の要請が同じ実装で両立する。
   - **決定的ゲートの指標**: コンテナ抽出後のテキストに対して
     `textLength` / `linkDensity` / `paragraphCount` の3指標を算出し、
     いずれも `src/lib/constants.ts` の閾値（`MIN_EVIDENCE_INPUT_CHARS`・
     `MAX_LINK_DENSITY`・`MIN_PARAGRAPH_COUNT`）で判定する。**この3閾値の数値は
     `src/lib/constants.ts` を単一の真実とする**（2026-08-29 のゲート大幅緩和で
     供給量優先に引き下げ済み。各定数の JSDoc に旧値と緩和意図を記載）。
     この決定的ゲートは「判定対象テキストが実質的に存在しない（本文なし・
     純粋なリンク集約ページ）」ケースだけを弾く水準に位置づけている。
     `container_not_found`（コンテナ抽出自体の失敗）は緩和対象ではなく従来どおり
     終端棄却する。**旧指標
     `boilerplateLineRatio`（`computeBoilerplateLineRatio()`）は廃止した**
     ——実験により、この指標は本文の内容ではなく HTML ソースの整形
     スタイル（改行位置）に依存することが確定したため（同一内容でも
     pretty-print 出力で 0.684、minify 出力で 0.000 となり、ゲート判定が
     反転する）。本番運用ではこの指標により対象24件中24件が棄却され、
     公開が一切発生しない状態になっていた。
   - **判定スライスの再定義**: 「ページ全体の先頭 1,200 字をスキップした
     後続 1,500 字」から、「**抽出したコンテナ本文の先頭から最大 1,500
     字**」に変更した（§10-4 第4項）。コンテナ抽出という前段が入った
     ことで、ページ先頭のスキップ（ナビ等を避けるための経験則）が不要に
     なった。

### §11-1 MAX_LINK_DENSITY の校正

- **校正日**: 2026-08-25 → **2026-08-29 に方針変更**
- **データソース**: www.mwed.jp（5件の公開記事）
- **link_density 分布**: min=0.003, max=0.177, avg=0.114
- **設定値**: `MAX_LINK_DENSITY` の数値は `src/lib/constants.ts` を単一の真実とする
  （旧値と校正履歴は同定数の JSDoc）。2026-08-29 の方針変更で、実測分布の上限に対する
  統計マージンではなく「本文がほぼ無くリンクだけのページ」を弾くための粗い上限として
  位置づけ直した。抽出品質ゲート全体（`MIN_EVIDENCE_INPUT_CHARS`・`MAX_LINK_DENSITY`・
  `MIN_PARAGRAPH_COUNT`）を供給量優先で緩めた一環（§11 項1）。

2. **K2（規約変更検知）と allowlist の関係**: `source_policy.tosUrl` は `HOST_ALLOWLIST`（`src/lib/constants.ts` の各エントリの `tosUrl`）から解決する。**allowlist 側が真実の源（source of truth）であり、DB（`source_policy` テーブル）に格納された古い値は allowlist の値で上書きして解決する**（`src/lib/sources/access-discipline.ts`）。allowlist に未登録、または `tosUrl` が未設定のホストは `tosUrl: null` のまま維持され、K2 の対象にならない。
   - **既知の許容トレードオフ（遅延）**: K2 の実行間隔は「1ホストあたり1日1回」であり、`source_policy.checkedAt` 列を robots.txt チェック側と共有している。そのため **robots.txt の変化を検知した直後は、規約チェックが最大1日遅延しうる**。追加専用（append-only）のマイグレーション制約下では列を新設するだけで解決できず、テーブルを分離すると `tosHash` が再び休眠カラム化するリスクを招くため、この遅延は仕様上許容する。
3. **記事パスのホワイトリスト（`HOST_ALLOWLIST.articlePathPatterns`）**: discovery 対象の URL パスは `src/lib/constants.ts` の `AllowlistedHost.articlePathPatterns` で定義し、**取得前に**2段階で強制する——sitemap からの URL 収集（seed）段階と、本文取得直前の段階。口コミ投稿ページ（`/hall/{hallId}/rev/{commentId}/` 等、記事とはパス構造が異なる投稿単位のページ）はこのパターンに一致しないため、構造的に discovery 対象から除外される。
4. **日次公開サーキットブレーカー**: `DAILY_PUBLISH_CAP`（値は `src/lib/constants.ts` を単一の真実とする）。当日 JST の公開総数がこれに達している場合、以後の新規公開を打ち切る（終端棄却ではなく `rate_capped` として再試行キューへ繰り延べる）。エバーグリーン・discovery の全経路（`src/lib/pipeline/evergreen-via-pipeline.ts`・`src/lib/pipeline/ingest.ts`・`src/lib/pipeline/discovery-ingest.ts`）で共通の判定関数 `isDailyPublishCapReached()`（`src/lib/pipeline/rate-cap.ts`）を用いる。
   - **2026-08-29 の方針転換（オーナー判断）**: 旧仕様（`DAILY_PUBLISH_CAP` ＋ `HOST_DAILY_SHARE_MAX` によるホスト別シェア上限）は、供給スロットルであると同時に「1ホストがフィードを埋めると、個々のカードが正しくても『中立キュレーション』の主張が集約レベルで偽になる」ことを防ぐ安全弁（旧 plan 07 §6-Q4）だった。**集約レベルの中立性を運用ポリシーから外す**ことに伴い、`HOST_DAILY_SHARE_MAX` を廃止し、単一ホストの当日公開シェアは一切制限しない。`DAILY_PUBLISH_CAP` は供給目標から切り離し、DOM 変更等で一晩に数百件を誤公開する相関カスケード事故だけを止める上限として残す（現行値は `src/lib/constants.ts`。通常運用で達することは想定しない）。
   - **回帰防止（plan 07 §14）**: この上限を無効値（10^9 等）に戻すと境界テストが素通りした過去の回帰を踏まえ、`tests/pipeline-ingest.test.ts` / `tests/discovery-ingest.test.ts` の境界テストは「上限直下の1件は公開 / 上限到達で `rate_capped`」の2ケースを固定する（境界値は `src/lib/constants.ts` の `DAILY_PUBLISH_CAP` を基準とする）。
5. **目標フィード供給量**: 明示的な数値目標は置かない（2026-08-29 に旧供給目標を撤廃）。供給量は抽出品質ゲート（§11 項1）とキュレーションの通過率に委ね、上限は項4 のサーキットブレーカー（`DAILY_PUBLISH_CAP` / 日）のみとする。
6. **`RetractionReason` と撤回 CLI**: `RetractionReason`（`src/lib/types.ts`）に `takedown_request` を追加した。4つの客観的トリガ（`source_gone` / `robots_disallowed` / `tos_changed` / `body_changed`）と異なり、**`takedown_request` のみが人間の判断による撤回**であり、自動検知パイプラインからは設定されない。撤回は `pnpm retract`（`scripts/retract.mjs`）で行う——既定は dry-run（対象一覧の表示のみ、DB 変更なし）、接続先を明示し、`--reason` は必須（既定値なし）で人間に毎回明示させる。実際に撤回するには `--yes`（または `--execute`）を要する。

---

## 13. Decision Log (Plan 23 Stage 0)

- **Selector AND条件**: `published`, `blog`, `allowlist`, 許可 article path, generic 判定または legacy signature, 同一 dedicated signature 成功履歴なし, retracted/deleted/blocked でない。
- **Generic/Legacy 定義**: 実装 Stage 0 でコード側常量として固定。
- **Digest / HMAC**: HMAC を監査 metadata として採用（hash oracle リスク回避）。
- **Metadata 保存先**: `src/lib/db/schema.ts` + 移行または既存 metadata 案を比較し投稿単位復元・監査要件を満たす方を選択。
- **評価時 fetch**: regulated fetch または短命 ephemeral fixture。
- **Journal / Rollback**: run id 単位で本文非保存の前提で DB backup または transaction history のいずれかを採用。
