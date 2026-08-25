# 09. 本文抽出の観測性追加と `MAX_LINK_DENSITY` 校正

- 対象: `wedding-trend`（本プロジェクト）
- 参照: `shared_plan/06-rationale-and-scraping.md`、`shared_plan/07-unattended-operation.md`、`shared_plan/08-commit-plan.md`
- 作成日: 2026-08-25
- 前提コミット: `8e7c506` + 本セッションの未コミット実装（12ファイル、+1070/-120、全ゲート通過）
- 状態: **未着手。§1 は完了済み事項の記録、§2 以降が実行計画**

---

## 1. 現在の状態（完了済み）

本セッションで完了した変更（未コミット、12ファイル、+1070/-120）:

- 本文コンテナ抽出 `extractArticleContainer(html, host)` の導入（`linkedom` を本番依存に追加）。`AllowlistedHost.articleContainerSelectors`、mwed.jp は `["div.story-detail", "div.produce-story-detail"]`
- 抽出ゲートを4指標→3指標（`textLength` / `linkDensity` / `paragraphCount`）。`boilerplateLineRatio` 廃止
- `EvidenceFailedCondition` に `container_not_found` 追加（テンプレート変更の検知）
- `selectJudgmentSlice()` の固定オフセット（先頭1,200字スキップ）廃止 → コンテナ先頭から最大1,500字
- `computeContainerBodyHash(html, host)` で M4 のハッシュ算出基盤を統一。コンテナ未検出時は撤回せずスキップし `containerNotFoundSkipped` を加算
- `originalTitle` をコンテナ内 `h1` から取得（`<title>` フォールバック維持）
- `RATIONALE_TEXT_MAX_CHARS = 210` / `RATIONALE_TEXT_MIN_CHARS = 38`、`renderRationaleText()` に上限・下限の例外チェック
- spec.md 更新（§11-1 新設、根拠文38〜210字、タイトル取得元、判定スライス再定義）

検証結果: 全ゲート通過（oxlint / type-check / oxfmt / eslint / spec-refs / lockfile-sync / vitest 467件 / coverage 全ティア / security / smoke-test）。意図的破壊5項目すべてで検知。仕様と実装の一致を逐語確認済み。

実データ結果: 11件処理、**公開5件**（id 233〜237、初の公開到達）。抽出ゲートの棄却は全条件で0件。ナビ・第三者口コミの混入なし。`originalExcerpt` 全件 null（§10-5 準拠）。

---

## 2. 未完の作業（詳細な作業計画）

### 2-1. 観測性の追加（校正の前提）

**問題**: signals は Q1 ゲート**失敗時のみ** `console.warn` に出力される（`src/lib/pipeline/discovery-ingest.ts` の構造化warnログ）。成功時は記録されないため、**閾値にどれだけ余裕を持って通ったかが分からない**。実データ5件が全通過したが `linkDensity` の実測値は不明のまま。

**なぜ重要か**: 落ちているものは棄却カウンタで気づけるが、閾値の紙一重で通っているものは何も知らせない。`boilerplateLineRatio` が観測最小値0.501の直下に閾値0.5を置いて24/24を落としていたことに、実データを見るまで気づけなかったのと同じ盲点。

**作業手順**:

1. マイグレーション作成: `src/lib/db/migrations/0011_*.sql`（次の連番。現時点の最新は `0010_post_publication_kind.sql`。着手時点で `ls src/lib/db/migrations/` を再確認し、他作業が割り込んでいないか確かめること）。`post_publications` に `text_length` / `link_density` / `paragraph_count` を `ALTER TABLE ADD COLUMN` で追加。`ALTER TABLE ... ADD COLUMN` は `scripts/migrations-additive.mjs` の所有権ベース検査で**所有テーブルに対してのみ許可済み**。`post_publications` が `schema.ts` の `sqliteTable()` 由来の所有テーブルであることを確認すること
2. `src/lib/db/schema.ts` に対応カラムを追加
3. `processUrl()` で**ゲート通過時にも** signals を記録する（棄却時の warn ログは維持）
4. 数値のみを保存し、**本文テキストは一切保存しない**（§10-5）。ログにも本文を出さない
5. テスト追加（期待値はリテラル、定数から導出しない）
6. 意図的破壊で検証: 記録処理を外して該当テストが落ちること
7. 全ゲート実行

### 2-2. `MAX_LINK_DENSITY` の校正

**現状**: `src/lib/constants.ts:246` で `0.35`。**唯一残る根拠のない閾値**。ページ全体基準で決めた値をコンテナ基準にそのまま流用している。コンテナ内実測分布は未取得。

**作業手順**:

1. 2-1 完了後、通常運転でデータを蓄積する（**最低20件**を目安。5件では分布が分からない）
2. 蓄積後、`post_publications` から `link_density` の分布（最小・最大・中央値・パーセンタイル）を算出
3. 閾値は**パーセンタイル**で置く（例: 通過実績の p99 に安全マージン）。単一サンプルや理論上の端点から決めない
4. `src/lib/constants.ts` と spec.md §11-1 の「再校正が未了」という記述を**同時に**更新する
5. 校正後、意図的に閾値を厳しくして棄却が発生することを確認する（通過方向でしか検証していないゲートは判別能力が未検証であるため）

### 2-3. コミット

`shared_plan/08-commit-plan.md` の8分割計画を今回の変更を含めて更新し、分割コミットする。**現在ツリーは未コミットのまま**（12ファイル）。Conventional Commits（commit-msg フックで強制）。

---

## 3. 実データ取得の手順（重要・試行錯誤で得た知見）

以下は本セッションで実際に踏んだ落とし穴を含む。**次回同じ混乱を避けるために必ず読むこと。**

- `www.mwed.jp` の本日（2026-08-25 UTC）の消費は **95**。`todayUTC()` 基準で UTC 日付変更時にリセットされる
- 取得件数は `src/lib/constants.ts` の `DAILY_REQUEST_CAP_PER_HOST`（通常50）の一時的な引き上げで制御する。**キャップそのものが件数制御装置**として機能し、到達すると K7 kill gate で正常停止する
- **robots.txt の取得も日次カウントを1消費する**（`disciplinedFetch()` の実装、仕様通りでバグではない）。必要件数の計算に必ず含めること。計算式: `現在の消費数 + robots最大1 + 取得したい記事数`
- `disciplinedFetch()` の順序は「K7判定（読むだけ）→ robots取得（+1）→ K7再チェック（ここで拒否されうる）」。**K7 拒否自体はカウンタを増やさない**
- **拒否されてもキャップを追い上げないこと。** 本セッションでこれを繰り返し「外部プロセスが枠を消費している」と誤認した
- **スクリプトを複数回起動しないこと。** 出力確認のために再実行して1件の超過が発生した
- 実行後は**必ず** `DAILY_REQUEST_CAP_PER_HOST` を 50 に復元し、`git diff` に痕跡が残らないことを確認する
- 実行コマンド: `pnpm exec tsx scripts/run-discovery.mjs --host www.mwed.jp`
- 実データ取得はユーザーの明示的な許可を得てから行うこと

---

## 4. 判断が必要な未解決事項

**有用度6項目がすべて false でも公開される。** `computeUsefulnessScore()`（`src/lib/scoring/usefulness.ts`）はソート用スコアを返すだけで、公開可否を判定する呼び出し箇所が存在しない。公開前のゲートは `filterTitle()` と `checkAnchorGrounding()` のみ（`src/lib/pipeline/discovery-ingest.ts`、`ingest.ts`、`evergreen.ts` すべて確認済み）。

無人運転では「自動判定では特筆すべき特徴は検出されませんでした」という根拠文の記事が公開される。**仕様上の意図か実装漏れかは未確認。** ユーザーの判断を仰ぐこと。

その他:

- 公開済み5件（id 233〜237）は `<title>` 由来のタイトルのまま。h1 由来へのバックフィルには再フェッチが必要なため未実施
- `/story/cases/{id}/` 形式のURLは構造を未確認（調査したのは `/hall/{id}/rev/story/{id}/` 形式のみ）。同じセレクタが当たるかは実データで確認が必要

---

## 5. 記録すべき教訓

### 閾値を単一サンプルや理論上の端点から決めて4回失敗した

| 閾値                           | 決め方               | 結果                                       |
| ------------------------------ | -------------------- | ------------------------------------------ |
| `boilerplateLineRatio` 0.5     | 推測                 | 観測最小値0.501の直下。24/24棄却           |
| `MAX_LINK_DENSITY` 0.35        | ページ全体基準を流用 | 観測分布のほぼ中央。実質コイントス         |
| `RATIONALE_TEXT_MAX_CHARS` 150 | 実測1点（146字）     | 改定直後に公開5件中3件が違反               |
| `RATIONALE_TEXT_MIN_CHARS` 37  | 理論上の端点         | 公開経路に到達しないケース。仕様(60)と乖離 |

転換した方針: **構造的最大値・最小値から決める**。`topicAnchor` の zod 上限40字 × フラグ6個 = 206字 → 上限210。`checkAnchorGrounding()` を通過しうる最小 = アンカー2字 × フラグ全false = 38字 → 下限38。これらは実測分布からの帰納ではなく、機械的に強制された制約から導いた値であり、超過は原理的に起こり得ない。

### orchestrator が外した仮説4件

1. 抽出失敗の原因は `paragraphCount` 不足 → 実際は `linkDensity` の分子・分母の前処理不一致
2. 判定スライスにナビは含まれない → 実際はサブナビが直撃していた
3. 外部プロセスが日次枠を消費している → 実際は自分のプローブの robots.txt 取得
4. K7 拒否がカウンタを増やす → 実際は増やさない

いずれも実データか実装を読めば分かるものを、観測値からの推論で断定した。**確認前の断定を避けること。**

### 常に赤いゲートも未検証である

24/24 棄却は fail-closed な安全設計ではなく、判別能力の証拠がない状態だった。「緑であることと機能していることは別」の裏返しとして、**通過方向で一度も検証されていないゲートも同様に未検証**である。

### 「測っているつもりの量を測っていない」欠陥が2件

`linkDensity`（分子と分母で除外領域が不一致）と `boilerplateLineRatio`（HTMLソースの整形スタイルを測っていた）。どちらも意図的破壊または同一内容・異なる整形での比較実験で初めて露見した。**指標を追加する際は「その値が何の関数になっているか」を実験で確認すること。**
