# 18. 「AI判定」バッジ・判定基準タグを廃し、AI選定トピックタグを導入する

- 対象: `wedding-trend`（本プロジェクト）
- 作成日: 2026-08-31
- 前提コミット: `048b415` `feat(plan17): S2 commit 4 - evergreen adapter + parity diff tests`
  （作業ツリーに未追跡の `src/lib/pipeline/adapters/submit-adapter.ts` / `tests/pipeline/submit-diff.test.ts` あり＝**plan17 S2 が実行中**。§9 参照）
- 参照:
  - `shared_plan/13-remove-rationale-display-and-media-zone.md`（Summary ゾーン全廃の判断）
  - `shared_plan/14-restore-topic-anchor-and-title-normalization.md`（topicAnchor と有用度バッジの復活）
  - `shared_plan/16-anchor-clause-form-and-non-redundancy.md`（**体言止め撤回。本プランの最大の衝突点。§4 参照**）
  - `shared_plan/17-simplification-plan.md`（実行中。着手順序の調整が必要）
- 状態: **全 Stage 完了（2026-09-01）。** Stage 5（本番 migration + バックフィル）実施済み。詳細は下記。
  - Stage 0-1（golden-set label-schema 乖離解消）・0-2（spec §10-3 精緻化）: 完了（コミット `5579f51`）
  - Stage 1〜3（schema `post_topics` / migration 0013 / `CurationItemSchema.topics` / `TOPIC_RULES` / `validateTopics()` / `batch.ts` フォールバック / `constants` v15 / `query.ts` join / `ingest.ts` 書き込み / `types.ts`）: 完了（`5579f51`）
  - Stage 4（UI）: 完了。「AI判定」バッジ・判定基準テキスト行を撤去、`badge.tsx` の `ai`/`trend` バリアント削除、トピックタグを枠なし低コントラストのインライン語列で描画、`<ul role="list">` + `aria-label`/`title` 免責、レーンヘッダ恒常注記、欠損時非表示。
  - Stage 6（検証）: `pnpm verify` green。`tests/topic-gate.test.ts` が §8 の破壊テスト5項目（数字・11字・未接地固有名詞・5→4切り詰め・重複）を網羅し通過。
  - Stage 7（spec 最終更新）: §5 `post_topics` テーブル、§10-3 自己記述、§9 フィード表示節（バッジ記述の実態追随）を更新。
  - **Stage 5 完了（2026-09-01）**:
    - migration 0013 を本番 Turso に適用（`apply-migrations-remote.mjs --apply`。3文適用・29スキップ・news-watch 側テーブル消失なし）。
    - 実装ギャップを2件修正してから実行:
      1. `backfill-plan.mjs buildBackfillUpdates` が `result.topics` を落としていた（Stage 3 の `topics` 追加は mwed 側のみ）→ `topics` を update に載せるよう修正（コミット `b784109`）。
      2. `backfill-usefulness.mjs` が `assertNoSliceLeak(u)` を単体オブジェクトで呼んでいた既存バグ（`f4305b53` 由来。`--apply` 経路が 2026-08-30 以降壊れていた）→ `assertNoSliceLeak(applyUpdates)` に修正。
    - `backfill-usefulness.mjs --apply` 実行: 候補プール 317 件（`rejected` 193 + `published` 124）。RSS レーンの excerpt 保有分 + mwed discovery バイパスの再取得分をあわせて **101 件を再キュレーション（Gemini 4 リクエスト、更新成功 101 / 失敗 0）**。
    - 本番 `post_topics`: 177 行 / 99 投稿。全行 `prompt_version = 15`。上位トピック: 準備・美容・式場見学・演出・ご祝儀・見積もり 等。
    - **published のうちトピック未付与 34 件の内訳**（＝「本文不足」ではない）:
      - **mwed.jp 29 件**: 記事本文は存在する。バックフィル実行時点で当日の `DAILY_REQUEST_CAP_PER_HOST = 50`（§10-6）を使い切っており、discovery バイパスの `disciplinedFetch` が `budget_exhausted`。**日次カウンタ（UTC 日次リセット）回復後に `pnpm exec tsx scripts/ops/backfill-usefulness.mjs --source mwed.jp --apply` を再実行**すれば取得・付与される（スクリプトは再開可能。1〜2 日で解消）。キャップの緩和・回避は §10-6 法務不変のため不可。
      - **news.google.com 3 件**: URL が Google News のリダイレクトラッパーで、記事本文への到達経路が無い（discovery バイパスは `www.mwed.jp` ホスト限定）。別課題。
      - **note.com 2 件**: `og:description` が 32〜34 字と短く、モデルがトピック 0 件を返した。RSS レーンで保持する excerpt はこれで正常。
    - UI は欠損時非表示（§5-5）で対応済み。`CURATION_PROMPT_VERSION` bump 済みのため定期 discovery/ingest でも同じ再取得経路で徐々に波及する（同じ日次キャップに従う）。
- 前提: `openspec/specs/wedding-trend/spec.md` §10（法務制約）・§11（アクセス規律）の不変部分を緩めない。
  ただし §10-3 の**自己記述の精緻化**と、§4.x の **ALTER TABLE 記述の実装追随**は本プランのスコープに含む（§6 Stage 0）。

---

## 1. 発端

オーナーの要求（原文）:

> AI判定タグは冗長なので廃止し、判定基準タグも廃止。かわりに、記事内容からAIが4つ自由にトピックを選定し表示するように変えたい。
> トピックは短い単語で、タグ化すること

確認により次の4点を確定した。

| #     | 論点                         | 決定                                                                                                        |
| ----- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 方針1 | 「AI判定タグ」の指す対象     | **「AI判定」バッジ（`Badge variant="ai"`, Sparkles）のみ**を廃止。カテゴリバッジとトレンド/定番バッジは残す |
| 方針2 | 判定基準（usefulness 5項目） | **UI 表示のみ廃止**。LLM 判定・DB 保存・並び順スコアは維持                                                  |
| 方針3 | 既存 `topicAnchor`           | **残したまま**、トピックタグを追加する                                                                      |
| 方針4 | トピック語の生成制約         | **AI 自由生成＋既存ガードのみ**（元記事本文からの逐語接地は要求しない）                                     |

---

## 2. 現状（実測・すべてコードで確認済み）

### 2-1. 型・スキーマ

- `src/lib/types.ts:10` — `type TrendTag = "trend" | "classic"`
- `src/lib/types.ts:163` — `FeedCard.usefulness: UsefulnessCriteria | null`
- `src/lib/scoring/usefulness.ts:57-68` — `UsefulnessCriteria`（`firsthand` / `ceremonyDecision` / `specific` / `weddingDayContent` / `promotional`、各 0-9 整数）
- `src/lib/scoring/usefulness.ts:111-121` — `computeUsefulnessScore()`。重みはコード側定数、LLM は整数のみ返す
- `src/lib/llm/schemas.ts:44-67` — zod `CurationItemSchema`（`tag` + 5判定項目 + `topicAnchor`）
- `src/lib/llm/schemas.ts:72-76` — `CurationBatchResponseSchema` = `{ items: [...] }`

### 2-2. DB

- Drizzle / SQLite(Turso)。スキーマは単一ファイル `src/lib/db/schema.ts`。
- マイグレーション出力先は `src/lib/db/migrations`（`drizzle.config.ts:27,33`）。命名は `NNNN_slug.sql`、**最新は `0012_evidence_signal_observations.sql`。本プランの新規は `0013_`**。
- **DDL 許可範囲（要注意・spec と乖離）**: `scripts/gates/migrations-additive.mjs:292-360` の `classifyStatement()` が許可するのは
  `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX` / **所有テーブルへの `ALTER TABLE ... ADD COLUMN`** の4種のみ。
  `ADD COLUMN` は `UNIQUE` / `PRIMARY KEY` / 非定数デフォルトを伴わない形に限る（`ALTER_ADD_COLUMN_RE`, 同ファイル `:267-272`）。
  解禁コミットは `104600a`（2026-08-25, "fix(scripts): マイグレーションの安全装置を所有権ベースに作り替える"）。
  **`spec.md:130` と `:168-173` は「ALTER TABLE を一切許可しない」のままで実装と乖離している**（Stage 0-2 で是正）。
- `posts.tag`（`schema.ts:36`）enum カラム、`idx_tag`（`:79`）。
- `post_usefulness_criteria`（`schema.ts:140-146`）— `criteriaJson` に5項目を JSON 文字列で保持。
- `post_rationales`（`schema.ts:148-156`）— `topicAnchor` / `rationaleText` / `evidenceSufficient` / `modelId` / `promptVersion`。

### 2-3. 生成パイプライン

- `src/lib/llm/client.ts` の `callGemini`。SDK は Vercel AI SDK ではなく **`@google/generative-ai` (^0.24.1) を直接使用**。
- プロンプト `src/lib/llm/prompts.ts` — `USEFULNESS_CRITERIA_RULES`(:38-63) / `RATIONALE_RULES`(:65-71) / `FEWSHOT_ANCHOR`(:73-112) / `buildSingleCurationPrompt`・`buildBatchCurationPrompt`(:134-183)
- `src/lib/llm/batch.ts` — `callAndParse()`(:128-207)。**zod 検証失敗でも `LLM_MAX_PARSE_RETRIES` 回まで指数バックオフでリトライ**(:183-204)。
  全リトライ消費後は `null` を返し、`curateBatch()` は**バッチ全件を `null`**にする(:270-273)。
  呼び出し元は `null` を LLM 失敗として再試行キューへ回すため、**一部フィールド欠損のまま公開される経路は無い**。
  → **トピック追加でパース失敗率が上がると、記事そのものの取りこぼしに直結する**（§5-4 で対処）。
- `src/lib/publish/gate.ts` — `validateTopicAnchor()` / `checkAnchorGrounding()` / `renderRationaleText()`(:385-424)
- `CURATION_PROMPT_VERSION` は **現在 14**（`src/lib/constants.ts:65`。bump 履歴コメントは v10 までしか書かれていない＝コメントの追随漏れ）

### 2-4. UI

- Tailwind + cva。`src/components/ui/badge.tsx` に variants: `trend` / `classic` / `category` / `ai`(:20「AI 生成の明示マーカー」)
- `src/components/feed/feed-card.tsx`
  - `:34-46` カテゴリバッジ＋トレンド/定番バッジ
  - `:51-65` `topicAnchor` 表示＋**「AI判定」バッジ**（`title` に「このアンカー・特徴ラベルはAIが自動判定しており、誤りを含むことがあります」）
  - `:67-78` **判定基準タグ**（各項目 >= 6 のとき「当事者」「意思決定」「具体的」「当日内容」を `・` 区切りのテキストで表示）
- **`rationaleText` は `FeedCard` に載っているが UI には描画されていない**（`query.ts:45,229` でマッピング、`grep -rn "rationaleText" src/components/` は0件）。
- `feed-card.tsx` 専用のテストは存在しない。

### 2-5. クエリ

- `USEFULNESS_SCORE_SQL`（`query.ts:99-108`）は **副テーブル `post_usefulness_criteria` を直接参照**（`json_extract(criteriaJson, '$.ceremonyDecision')` 等）。`posts` 内では完結しない。
- したがって `leftJoin`（`:193`）は **並び順（`orderBy(desc(USEFULNESS_SCORE_SQL))`, `:196`）のために必須**。
  方針2で表示を止めても join は削れない。削れるのは JSON パース→`FeedCard.usefulness` マッピング（`:220-243`）のみ。

---

## 3. バックフィルの実機構（重要・oracle の初期見解を訂正）

当初「本文が非永続だからバックフィル不可」と評価したが、**誤り**。バックフィルは実装済みかつ spec 公認である。

- 実体は **`scripts/ops/backfill-usefulness.mjs`**（plan17 `f6837e4` で `scripts/` 直下から移動済み。旧パスは存在しない）。
- **【重要・2026-08-31 追記】このスクリプトは現在そのままでは実行できない。** `f6837e4` の移動時に相対 import の深さが
  直されておらず、`../src/...` が存在しない `scripts/src/...` を指すため即 `ERR_MODULE_NOT_FOUND` で落ちる
  （`scripts/` 配下の .mjs 12本が同じ状態だった）。設計上バックフィルが可能であることと、いま実行できることは別である。
  本プラン着手前に、この修正が入っていることを確認すること。
- 対象選定は `getStaleCurationCandidates()`（`src/lib/db/ingest.ts:404-453`）。通常は `curationSignature` 不一致、`--force` で `sourceType="blog"` 全件。
- **判定入力の取得元は2系統**:
  - **RSS レーン** → DB に永続化済みの `posts.originalExcerpt`（＋`originalTitle`）をそのまま再入力（`backfill-usefulness.mjs:402-406`）。再アクセス不要。
  - **discovery レーン**（`originalExcerpt` が null/空）→ `f4305b5` で統合された **mwed bypass** が `disciplinedFetch(url, { purpose: "article" })`（`src/lib/sources/access-discipline.ts:490`）で**再取得**し、`extractArticleContainer()` → `selectJudgmentSlice()` で判定スライスを復元。**メモリ上の候補オブジェクトにのみ一時代入**し、書き戻し update には含めない。`assertNoSliceLeak()`（`scripts/lib/mwed-anchor-backfill.mjs:160-171`）がキー許可リストで機械的に遮断。`--no-fetch` で無効化可。
  - 再取得は discovery 巡回と**同一の** robots 遵守・`Crawl-delay`・日次ハードキャップ・kill gate（K1〜K6）を通る。バックフィル専用の別枠上限は spec に無く、共有カウンタを流用する設計。
- **本文が得られない場合はスキップ**。`shouldRegenerateAnchor()`（`scripts/lib/backfill-anchor-gate.mjs:6-12`）が excerpt 空/5字未満で `false` を返し LLM を呼ばない。
  **「タイトルだけで判定する経路」は存在しない**（spec.md:766 と整合）。
- コスト実績: `shared_plan/02-post-decision-criterion.md:198-201` に「全43件バックフィルは Gemini 呼び出し4回（バッチ12件×並列4）」の記録。

### 帰結（本プランの設計に効く点）

1. **トピックはバックフィル可能**（設計上）。`CURATION_PROMPT_VERSION` を 14→15 に bump し `backfill-usefulness.mjs --force --apply` を回せば既存記事にもトピックが付く。ただし上記のとおり**スクリプトの実行可能性を先に回復させる必要がある**。
2. **接地検証もバックフィル時に実行可能**（本文/抜粋がメモリ上にあるため）。「curation 時にしか検証できない」という制約は無い。
3. ただし **discovery 由来で再取得に失敗する記事は恒久的にトピックを持たない**。UI の欠損時挙動（§5-5）は必須。
4. bump は**全ブログ投稿の再キュレーション**を意味する。判定基準・カテゴリ・tag・topicAnchor もすべて引き直される点に留意（トピックだけを足す差分更新にはならない）。

---

## 4. 最大の衝突点 — 「短い単語」は 15/16 が撤回した形式である

`shared_plan/16` は実測を根拠に次の結論を出している。

> 裸の名詞句は構造上「記事の話題を名指す」ことしかできず、話題はタイトルが既に名指している。
> つまり「体言止めで話題を名指せ」は、**タイトルの言い換えを作れと命じているに等しい**。
> 公開77件のうち **57% が裸の名詞句（平均重複率 0.886・平均8.6字）**

`src/lib/llm/prompts.ts` の `FEWSHOT_ANCHOR`(:73-112) は短い名詞句を明示的に**負例**として列挙している
（「結婚式準備」「式場見学」「見積もり比較」＝弱い、「祝儀袋の選び方」＝*タイトルの言い換え。表題と被り、読者に新情報を与えない*）。

今回の「短い単語のトピックタグ」は形式上これと同型である。**ただし役割が異なるため矛盾ではない。**
この分離を明文化しないと、実装時に anchor 用ルールがタグへ流入（あるいは逆流）し、16 の是正が巻き戻る。

|              | `topicAnchor`                    | トピックタグ（新規）                         |
| ------------ | -------------------------------- | -------------------------------------------- |
| 役割         | クリック誘引・「読む理由」の提示 | 走査性・分類・将来の絞り込み                 |
| タイトル重複 | **禁止**（新情報が消えるため）   | **許容**（分類子としては重複しても機能する） |
| 形式         | 18〜36字・文型自由               | 短い名詞句（2〜10字目安）                    |
| 結論の開示   | 禁止（ゼロクリック化回避）       | 禁止（同上）                                 |
| 個数         | 1                                | 2〜4（§5-2）                                 |

**実装上の要求**: プロンプトでは `RATIONALE_RULES` と `TOPIC_RULES` を明確に別セクションとし、
few-shot も別に持つ。`FEWSHOT_ANCHOR` の負例（「結婚式準備」等）が
トピックタグの**正例**になり得ることを、プロンプト内で明示的に区別すること。

---

## 5. 設計判断

### 5-1. AI 開示の扱い（方針1の副作用への対処）

「AI判定」バッジは現状 AI 由来ラベルの明示マーカー兼免責注記を兼ねている。撤去すると
`title` 属性の免責文がアクセシビリティツリーからも消える。カード単位のバッジは冗長という
オーナー判断は妥当だが、開示の実質は残す。

- **必須**: トピックタグのコンテナに `aria-label="この記事のトピック（AIによる自動判定）"`、`title` に既存の免責文を移設。
- **必須**: フィード**ヘッダ直下**に恒常注記1行（「カテゴリ・トピックはAIが自動判定しています。誤りを含む場合があります」）。
  フッターは無限スクロールで到達不能になるため不可。
- **spec.md §10-3 の改訂が必須**（Stage 0-2）。現在の「公開は表現を含まない言明」という自己記述は、
  AI が自由生成した語を公開面に出す時点で事実として不正確になる。緩和ではなく**精緻化**として
  「(a) 他人の表現（記事本文の逐語断片）を含まない (b) 自らの出力は非創作的な短ラベルに限る
  (c) 根拠文は決定的テンプレートのみ」へ書き直す。放置すると spec とコードの乖離が drift 起点になる。

### 5-2. トピック語のガード（方針4への修正提案を含む）

**P0 — zod refine による機械的ブロック（必須）**

| ガード                                                                    | 内容                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **件数 2〜4 の可変**（`.min(2).max(4)`）                                  | **方針4に対する修正提案。**「4件固定」は素材の薄い記事で LLM に枠を埋めさせ、記事にない話題の発明を構造的に誘発する。UI は存在する分だけ描画する                                                                                                                                                                                               |
| 文字数 2〜10字（全角）                                                    | 長い＝文の断片＝本文要約への接近＝§10 リスク                                                                                                                                                                                                                                                                                                   |
| 数字禁止 `/[0-9０-９]/`                                                   | **新規に書く必要がある。流用元は存在しない。** 2026-08-31 の調査で、spec §10-3 が「zod `refine` で機械的に拒否する（プロンプト指示だけに依拠しない）」と記していた実装は存在しないことが判明した（`CurationItemSchema` の `topicAnchor` は `z.string().min(1).max(40)` のみ。`schemas.ts` に `refine` は0件）。spec 側は実態に合わせて訂正済み |
| PII denylist                                                              | `checkAnchorDenylist` の個人識別情報パターンを流用                                                                                                                                                                                                                                                                                             |
| 名詞句のみ（助詞・活用語尾で終わらない）、記号・URL・絵文字・句読点の禁止 | 「〜を選ぶコツ」のような文断片化を防ぐ最重要の形式制約                                                                                                                                                                                                                                                                                         |
| タグ間の重複排除＋`topicAnchor` との包含関係チェック                      | 冗長排除というオーナーの動機に直結                                                                                                                                                                                                                                                                                                             |
| 正規化（NFKC・trim・連続空白除去）を保存前に                              | 将来の絞り込みの前提。後付けでは効かない                                                                                                                                                                                                                                                                                                       |

**P1 — 内容ガード**

| ガード                                                        | 内容                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **固有名詞は `originalTitle` に出現する場合のみ許可**         | 逐語接地を捨てた穴を最小コストで埋める本命。会場名・サービス名の発明のみを防ぐ。タイトルは逐語保持・永続化済みなのでバックフィル時も検証可能                                                                                            |
| 禁止カテゴリ denylist（煽り・優劣断定・医療/法律/金銭の断定） | `RATIONALE_RULES` の既存禁止語群を流用                                                                                                                                                                                                  |
| ~~ブランド名の一律禁止~~                                      | **採用しない。** 結婚式領域では会場名・サービス名こそ記事の主題であり、禁じるとタグが「準備」「費用」等の無価値な汎用語に収束する。ただし `RATIONALE_RULES` 既存の「**個人と結びつく**会場名・店舗名」の禁止は維持する（→ §7 未決 U-2） |

**`checkAnchorGrounding` の soft gate 再利用**: 「警告ログのみ」ではなく **タグ単位の部分ドロップ**として使う。
接地スコアが閾値未満のタグ*だけ*を落とし記事は公開する。オーナーの「ブロックしない」方針と両立しつつ実効性がある。
ドロップ率はメトリクス化し、閾値超過に気づける形にする。

### 5-3. DB スキーマ — 行展開の新テーブル

`ALTER TABLE ... ADD COLUMN` が解禁済みのため `post_rationales` への列追加も技術的には可能だが、
**採用しない**。トピックは可変長の集合であり、かつ将来の絞り込み対象である。`criteriaJson` が
JSON なのは「固定5キーで個別キー検索の予定が無い」からであって、JSON が本プロジェクトの標準だからではない。

```
post_topics(
  postId        -> posts.id (cascade、既存副テーブルと同じ規約)
  position      integer      -- 表示順の決定性を保証
  topic         text         -- 正規化済み
  promptVersion text
)
PRIMARY KEY (postId, position)
UNIQUE (postId, topic)                 -- 重複の DB レベル二重防御
INDEX idx_post_topics_topic (topic)
```

`CREATE TABLE` + `CREATE INDEX` のみで構成され、`migrations-additive.mjs` の許可範囲に収まる。
`promptVersion` を本テーブル自身に持たせる理由: (1) 問題世代のタグを削除せずクエリで一括非表示にできる
(2)「v15 未満のタグを持つ記事を再判定」が1クエリで書ける (3) トピック生成のプロンプトだけを
変えたい場面が必ず来るため、`post_rationales.promptVersion` に相乗りさせると片方の変更が他方の世代を汚す。

### 5-4. パイプラインの堅牢性

`CurationItemSchema` に配列フィールドを足すとパース失敗率が上がり得る。§2-3 の通り、
パース失敗は**バッチ全件 `null`＝記事の取りこぼし**に直結する。
→ **トピックは公開の必要条件にしない**。スキーマ上は必須で受けつつ、
トピック部分だけが検証に落ちた場合は空配列にフォールバックして記事は通す。
（`topicAnchor` の「gate 失敗時は null で公開（デグレード）」と同じ思想。spec §10-3 の既存方針と整合）

### 5-5. 欠損時の UI 挙動

**非表示一択**。プレースホルダもスケルトンも不適切（恒久欠損であり待てば来るものではない）。
方針3（`topicAnchor` 存置）がここで効き、トピックを持たない古いカードも anchor で情報量を保つ。

### 5-6. 情報密度 — 「冗長排除」が逆効果になるリスク

- 現状: カテゴリ1 + トレンド1 + AI判定1 + 判定基準テキスト1行 = 実質3バッジ＋1行
- 変更後: カテゴリ1 + トレンド1 + **トピック4** = 6バッジ

**行数は減るがバッジ個数は倍増する**。「冗長だから廃止」という当初の動機が達成されない恐れがある。
トピックタグは既存 `Badge` の variant を流用せず、**別の視覚階層**（小さめ・枠なし・低コントラストの
インライン語列など）に落とすことが成否を分ける。**これは `@designer` 案件**であり、
バッジ variant の流用という実装判断で済ませてはならない。

### 5-7. アクセシビリティ

- タグ群は `<ul role="list">` + `<li>`、コンテナに §5-1 の `aria-label`。
- 読み上げ順は タイトル → カテゴリ/トレンド → `topicAnchor` → トピックタグ（重要度降順）。DOM 順をこれに合わせ、CSS で視覚順を作らない。
- **押せないタグは UX の罠**。当面インタラクティブにしないなら、明確に非インタラクティブな見た目
  （枠なし・カーソル `default`）にする。インタラクティブにするならタップ領域 44px。

### 5-8. `renderRationaleText()` との分離（法務）

spec 原文「**LLM の自由文を根拠文として直接採用しない設計は維持する**」に最も抵触しやすい箇所。

- **トピックタグを `rationaleText` に混ぜない**。決定的テンプレートは `topicAnchor` + 5判定値のみから組み立てる現行を維持。
- UI 上もトピックタグと根拠文を構造的・視覚的に分離する。トピックが根拠文の直下に並んで「根拠の一部」に
  見えると、実質的に自由文を根拠として提示しているのと同じになる。
  （なお `rationaleText` は現在 UI 非表示のため当面の実害は無いが、将来の復活時に効く制約として明記する）

---

## 6. Stage 構成

### Stage 0 — 前提整備（**ブロッカー。ここを飛ばさない**）

- **0-1. `tests/golden-set/label-schema.md` の乖離解消**
  旧仕様（6項目 boolean/ternary、`preDecisionOrPhotoShoot` 含む）のままで現行（5項目 0-9）と乖離しており、
  **ゴールデンセット評価は現在おそらく機能していない**。方針2により判定基準が UI から消えると、
  精度劣化に人間が気づく経路が消滅し、症状は「なんとなく並び順が悪い」という診断困難な形でしか現れなくなる。
  ゴールデンセットは _あれば良いもの_ から **唯一の品質監視手段** に格上げされる。壊れた計器の上に新機能を載せない。
- **0-2. spec.md の是正2件**
  - §10-3 の「表現を含まない言明」を §5-1 の通り精緻化
  - §4.x（`spec.md:130`, `:168-173`）の「ALTER TABLE を一切許可しない」を実装（`104600a` 以降）に追随させる
  - 併せて `constants.ts:42-64` の `CURATION_PROMPT_VERSION` bump 履歴コメントが v10 で止まっている件も補完
- 担当: `@fixer`（0-1 の schema 記述更新、0-2 の spec 追記）／ 検証は Orchestrator

### Stage 1 — DB スキーマ

- `src/lib/db/schema.ts` に `postTopics` テーブル追加（§5-3）
- `src/lib/db/migrations/0013_post_topics.sql` 生成
- `pnpm exec node scripts/gates/migrations-additive.mjs` で許可判定を通すことを確認
- 担当: `@fixer`

### Stage 2 — LLM スキーマ・プロンプト・ガード

- `src/lib/llm/schemas.ts`: `CurationItemSchema` に `topics` 追加（§5-2 の P0 refine 群を実装）
- `src/lib/llm/prompts.ts`: `TOPIC_RULES` と `FEWSHOT_TOPICS` を **`RATIONALE_RULES` とは別セクションで**新設（§4）
- `src/lib/publish/gate.ts`: `validateTopics()` 新設。P1 の固有名詞タイトル接地・禁止カテゴリ・
  `checkAnchorGrounding` のタグ単位部分ドロップ（§5-2）
- `src/lib/llm/batch.ts`: トピック検証失敗時に空配列へフォールバックし記事は通す（§5-4）
- `src/lib/constants.ts`: `CURATION_PROMPT_VERSION` 14 → 15
- 担当: `@fixer`（テスト実装も含むが**実行は Orchestrator**）

### Stage 3 — 永続化・クエリ・型

- `markCurated()` / `upsertPostRow()` 経路で `post_topics` を書き込み。`ALLOWED_UPDATE_KEYS`（`scripts/lib/mwed-anchor-backfill.mjs`）に `topics` を追加し `assertNoSliceLeak()` を通す
- `src/lib/db/query.ts`: `post_topics` を join して `FeedCard.topics` にマッピング。
  `FeedCard.usefulness` は**削除**（UI 非使用になるため。ただし `leftJoin` 自体は
  `USEFULNESS_SCORE_SQL` が必須とするため残す — §2-5）
- `src/lib/types.ts`: `FeedCard` に `topics: string[]`、`usefulness` を除去
- 担当: `@fixer`

### Stage 4 — UI（**`@designer` 案件**）

- `feed-card.tsx:51-65` の「AI判定」バッジ除去、`:67-78` の判定基準テキスト行除去
- トピックタグの視覚設計（§5-6 の密度問題を解く）。`Badge` variant の流用可否は designer 判断
- `badge.tsx` の `ai` variant は他に用途が無ければ除去
- §5-1 の `aria-label` / `title` 移設、フィードヘッダの恒常注記
- §5-7 のアクセシビリティ要件
- 担当: `@designer`。**文言（コピー）は Orchestrator が視覚・操作の意図を保ったまま見直す**

### Stage 5 — バックフィル

- `scripts/ops/backfill-usefulness.mjs --force` の dry-run で対象件数と discovery バイパス発生数を確認
- 日次キャップ・kill gate に抵触しない範囲で分割実行（§3）
- `--apply` 実行後、トピック欠損記事の残数を記録
- 担当: Orchestrator（本番データへの書き込みを伴うため委譲しない）

### Stage 6 — 検証ゲート（§8）

### Stage 7 — spec.md の最終更新（§9.3 / §10-3 / §6.3 にトピック仕様を追記）

---

## 7. 未決事項（オーナー判断が必要）

- **U-1. トピック件数**: 方針4 は「4つ」固定だが、§5-2 の通り固定はハルシネーションを構造的に誘発する。
  **2〜4件の可変**を推奨。固定4件を維持するか？
- **U-2. 固有名詞の扱い**: `RATIONALE_RULES` は「**個人と結びつく**会場名・店舗名」を禁止している。
  トピックタグでは会場名・サービス名こそ価値がある一方、個人特定リスクは残る。
  「タイトルに出現する固有名詞のみ許可」（§5-2 P1）でこの緊張を解けるが、
  個人ブログのタイトルに会場名が入っている場合は通ってしまう。許容するか？
- **U-3. 着手順序**: `shared_plan/17` が実行中（Stage 6/7/9 が残、`submit-adapter.ts` 等が未追跡）。
  18 を 17 完了後に回すか、Stage 0 のみ先行させるか。
- **U-4. バックフィル範囲**: `CURATION_PROMPT_VERSION` bump は**全ブログ投稿の再キュレーション**を意味し、
  カテゴリ・tag・`topicAnchor`・判定基準もすべて引き直される（§3 帰結4）。
  トピック欠損のまま新規記事のみに付ける運用も選べる。全件再キュレーションを実行するか？

---

## 8. 検証計画

**サブエージェントに自作テストの実行・報告をさせない。以下はすべて Orchestrator が実行する。**

| ゲート     | コマンド                                               | 確認内容                                       |
| ---------- | ------------------------------------------------------ | ---------------------------------------------- |
| lint       | `pnpm lint`                                            | oxlint                                         |
| type-check | `pnpm type-check`                                      | `next typegen && tsc --noEmit`                 |
| test       | `pnpm test`                                            | vitest。新規 `tests/topic-gate.test.ts` を含む |
| migration  | `pnpm exec node scripts/gates/migrations-additive.mjs` | `0013_` が許可判定を通ること                   |
| verify     | `pnpm verify`                                          | `scripts/gates/verify.mjs`                     |
| spec-refs  | pre-commit（`scripts/gates/check-spec-update.sh`）     | warning はブロックしないが必ず対処             |

**「ゲートが緑であること」と「ゲートが機能していること」は別である**（AGENTS.md）。
新設する `validateTopics()` は、**意図的に壊して実際に落ちることを確認するまで完了と見なさない**。
最低限の破壊テスト:

- 数字を含むトピック（`"3万円"`）が refine で拒否されること
- 11字のトピックが拒否されること
- タイトルに無い固有名詞が P1 ガードで落ちること
- 5件返ってきたときに拒否 or 切り詰めが機能すること
- 重複トピックが DB の `UNIQUE(postId, topic)` で弾かれること

差分レビュー: 各 Stage 完了時に Orchestrator が**委譲時の指示と実装差分の一致**を確認する。乖離があれば再委譲。

---

## 9. やらないこと（スコープ外）

- **`posts.tag`（trend/classic）とカテゴリバッジの廃止** — 方針1で明示的に対象外
- **判定基準（usefulness）の内部廃止** — 方針2により内部は維持。`USEFULNESS_SCORE_SQL` による並び順は現行のまま
- **`topicAnchor` の廃止・形式変更** — 方針3により存置。`shared_plan/16` の是正を巻き戻さない
- **トピック別ページ（`/topics/[topic]`）の実装** — 自由生成語をそのまま URL セグメントにすると
  表記ゆれで薄いページが無限生成される。作るなら統制語彙（下記）を先に。当面は作らない
- **schema.org `keywords` / `about` への注入** — 未検証語の大量投入はスパムシグナルになり得る。当面 `noindex` 相当の扱い
- **統制語彙へのスナップ**（自由生成 → 正規化辞書へのマッピング） — 将来「トピックで絞り込む」を
  本気でやる場合に必要。§5-3 の行展開スキーマを選んでおけば後から被せられる。本プランでは実装しない
- **`rationaleText` の UI 復活** — 現在非表示（§2-4）。本プランでは触らない
