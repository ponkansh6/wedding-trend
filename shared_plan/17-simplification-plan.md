# 17. コードベースのシンプル化計画 — 本質的複雑性と偶発的複雑性の分離

- 対象: `wedding-trend`（本プロジェクト）全体
- 作成日: 2026-08-31
- 状態: **実行中。Stage 1/2/3/4/8 は完了・実装済み、Stage 5 は調査結果により対象ゼロでクローズ済み（下記）。残: Stage 6（S2）/ Stage 7（S8）/ Stage 9（S9）。着手前に Stage ごとにユーザー承認を得る。**
- 前提: `openspec/specs/wedding-trend/spec.md` §10（法務制約）・§11（不変条件）を一切緩めない。
  本計画のいかなる Stage も、法務不変条件そのものを弱める変更を含んではならない。
  緩めてよいのは「同じ不変条件を守るためのコードが分散している」という実装上の偶発的複雑性のみ。

---

## 発端

`wedding-trend` はソース総行数 約30,233行（ts/tsx/mjs/sh）まで成長し、探索コスト・レビューコスト・
フィードバックループの遅さが目立ち始めている。一方で本プロジェクトは「記事本文を一切生成しない
独立したキュレーションメディア」という法務制約（spec.md §10）を持つため、複雑性を減らす作業は
**不変条件を弱める作業と厳密に区別**しなければならない。

そこで @oracle に現状を委譲してレビューさせ、「複雑性のうちどこが本質的（法務要件そのもの）で、
どこが偶発的（守り方の分散・衛生・実行回数の重複）か」を切り分けた。本文書はその診断と、
診断に基づく実行可能な提案・実行順・完了判定をまとめたものである。

---

## 現状（実測値）

- ソース総行数 約30,233行（ts/tsx/mjs/sh）。拡張子別: .ts 89, .md 37, .mjs 35, .tsx 23, .json 15, .sql 13, .sh 8
- 行数上位:
  - `src/lib/db/repository.ts` 1806
  - `tests/discovery-ingest.test.ts` 1503
  - `tests/db.test.ts` 1250
  - `src/lib/pipeline/discovery-ingest.ts` 1159
  - `tests/access-discipline.test.ts` 810
  - `tests/pipeline-ingest.test.ts` 715
  - `src/lib/sources/access-discipline.ts` 693
  - `src/lib/pipeline/ingest.ts` 690
  - `tests/backfill-plan.test.ts` 644
  - `scripts/backfill-usefulness.mjs` 602
  - `tests/actions.test.ts` 584
  - `src/lib/llm/batch.ts` 546
  - `tests/publish-gate.test.ts` 543
  - `src/app/actions.ts` 499
  - `src/lib/constants.ts` 468
  - `src/lib/publish/gate.ts` 426
- DB テーブル 14種（`src/lib/db/schema.ts` 389行）: posts, config, post_usefulness_criteria,
  post_rationales, postPublications, post_publication_kind, postRemovals, discovery_seen,
  discovery_run, source_policy, host_gate_state, postRetryQueue, discoveryHostMetrics,
  evidenceSignalObservations。マイグレーション 0000〜0012（13ファイル）
- `scripts/` 46ファイルがフラット配置。内訳＝恒久ゲート12 / 運用8 / 週次モニタ3 / **使い捨て実験15**
  （eval-golden-set, eval-llm-compliance, evergreen-validation, counterfactual-thresholds,
  stage1-measurements, v0-stats, v1-control-group, v1-note-dryrun, test-stale-candidates,
  verify-stale-logic, check-sigs, calc-sig, gate-dist, count-gemini-requests, submit-evergreen）。
  半数以上に先頭コメントなし
- リポジトリ直下の浮遊物7個: `check-excerpt.ts`, `check-mwed.ts`（`scripts/check-mwed.ts` と名前衝突）,
  `check-mwed-v2.ts`, `local.db`(139KB), `logs/gemini-requests.log`, `.env.local.bak-*`,
  `tsconfig.tsbuildinfo`
- 摂取経路3系統:
  - RSS巡回（`/admin` 手動 or Vercel Cron 毎日21:00 `/api/ingest` → `runIngest()`）
  - エバーグリーンCLI（OGP・JSON-LD のみ）
  - discovery（GitHub Actions 18:00 UTC → sitemap差分 `discoverNewUrls` → `disciplinedFetch()` →
    本文コンテナ抽出 → 判定スライス抽出 → `curateSingle()` → 本文は永続化せず破棄）
- 共通ガード: lease（TTL 2分）、cooldown（claim 15分→extend 4時間、**`/admin` 経路のみ**）、
  `DAILY_PUBLISH_CAP=150`
- 検証ゲート:
  - pre-commit: lint-staged（oxlint 等）→ type-check → check-prompt-version-bump.sh → staged警告2種
  - pre-push: 未コミット変更ガード → lockfile-sync, eslint, spec-refs, format-check, security,
    migrations-additive の6 blocking → 条件付き smoke-test → coverage tiers → advisory 本番スキーマdrift。
    `NEED_SMOKE`/`NEED_TEST` の分岐を持つ大きなシェル
  - ci.yml: 単一ジョブ `quality` で install → lint:fast → eslint → type-check → format:check →
    vitest --coverage → coverage-tiers → spec-refs → security → smoke-test を直列
- eslint（eslint-config-next）と oxlint（next/react/react-perf plugin）の**二重運用**
- `vitest.config.ts` は `fileParallelism:false` / maxWorkers=1 固定
  （コメント「RAM 7.4GiB制約で OOM 回避」）
- フック bypass は禁止（`~/.local/bin/git` ラッパーで技術的にもブロック済み）

---

## 設計判断（@oracle レビュー済み）

@oracle に現状一式を委譲し、本質的複雑性（法務要件そのもの）と偶発的複雑性（実装上の分散・重複・衛生）
を切り分けさせた結果、以下6点の診断を得た。

### D1. 【本質/偶発の境目】法務不変条件そのものは安い。高いのは「守り方が分散していること」

不変条件9項目のうち実装コストが本質的に高いのは**アクセス規律（robots/レート/kill gate）と
語彙的接地検証の2つだけ**。逐語タイトルは「書き換えない」＝コードを書かないこと、
`originalExcerpt = null` は「書かない」こと、`rationaleText` 38〜210字は zod refine 1個。

にもかかわらず法務まわりが大きく見えるのは、**同じ不変条件が経路ごとに別々の場所で守られている**
から。証拠: `ingest.ts` 690行 / `discovery-ingest.ts` 1159行 / evergreen が独立に
「判定→保存→公開可否」を持つ。テストも `discovery-ingest.test.ts` 1503行と
`pipeline-ingest.test.ts` 715行に重複。cooldown が `/admin` 経路のみ＝spec が「経路非依存」を
掲げるのにガード適用面が経路ごとに違う（分散の症状）。**これが偶発的複雑性の主因。**

### D2. 【偶発】永続化禁止を実行時の条件分岐で守っている

`originalExcerpt`・`aiTitle` は常時 null。「本文を持てる型」と「保存できる型」が同一のため
`if` で禁じるしかない。型で不可能にできる保証を、テストで担保している構造。

### D3. 【偶発】検証ゲートの重複 — 数ではなく実行回数

pre-commit / pre-push / CI がほぼ同じ一式を最大3回実行。ゲートの種類が多いこと自体は
法務プロジェクトとして正しい。問題は実行回数と、pre-push が `NEED_SMOKE`/`NEED_TEST` 分岐を
持つ大きなシェルであること。**分岐ロジックを持つゲートは、それ自体がテストされないコード。**

### D4. 【偶発】データアクセスの単一巨大ファイルと、実験用テーブルの本番残留

`repository.ts` 1806行が14テーブル全部を抱える。`evidenceSignalObservations` /
`discoveryHostMetrics` / `postRetryQueue` / `post_publication_kind` は較正・実験由来の色が濃い
（`counterfactual-thresholds.mjs`, `stage1-measurements.mjs` と対応すると推測）。
migrations-additive ゲートで物理削除できず、使われないテーブルが `schema.ts` と `repository.ts` を
永久に太らせる。

### D5. 【偶発】scripts/ に恒久ゲートと使い捨て実験が同居

複雑性ではなく衛生問題だが、認知負荷への寄与が大きくコストが最も低い。

### D6. 【偶発】フィードバックループの遅さ

maxWorkers=1 固定で 1500行級・1250行級を直列実行。**「避けられないが遅い」は最悪の組み合わせ**
（bypass は技術的に禁止されているため）。

---

## 提案一覧（S1〜S9）

各提案は「問題 → 変更内容 → 削減見込み → リスクと確認方法」の順で記す。

### S1. リポジトリ衛生 — 浮遊ファイル除去と scripts の3分割（効果 中 / コスト 低 / リスク 低）

問題 = D5。

変更: 浮遊物7個を削除し `.gitignore` を追加する（`.env.local.bak-*` は**秘匿情報を含む可能性**が
あり `check-security.sh` が見逃しているなら最優先。履歴混入は要確認）。`scripts/` を以下に3分割する。

- `scripts/gates/`（フック・CI が呼ぶ12個）
- `scripts/ops/`（run-discovery, retract, apply-migrations, snapshot/restore-anchors, backfill群,
  週次モニタ）
- `scripts/archive/`（使い捨て実験15個。**削除ではなく移動** — 較正値の再現性は監査上の資産）

各ファイル先頭に「何のため / いつ呼ばれるか」1行コメントを必須化する。

削減: ルート直下 -7ファイル、`scripts/` 直下 46→12。行数削減はほぼゼロだが探索コストが劇的に下がる。

リスク: パス移動で husky/CI が壊れる。移動後に pre-push と ci.yml を一度通せば全検出できる
（全ゲート blocking なので沈黙 fail しない）。法務不変条件には無関係。

### S2. 摂取パイプラインの単一化 — 「3経路」を「3つの候補供給源 + 1本のパイプ」に（効果 高 / コスト 高 / リスク 中〜高）

問題 = D1。

変更: 責務を4段に切り直す。

1. 候補供給（Source）: RSS巡回 / evergreen手動投入 / sitemap差分発見 — 返すのは URL + 供給メタのみ
2. 原文取得（Acquire）: `disciplinedFetch` を唯一の出口とし本文コンテナ抽出・判定スライス抽出まで。
   返り値は**メモリ上の一時型**
3. 判定（Curate）: LLM呼び出し + 語彙的接地検証 + rationale検証
4. 公開ゲート（Publish）: `gate.ts` に全不変条件を集約

経路差は `provenance` 1値と供給源ごとの capability（本文を取得してよいか / 永続化してよいか）に
落とす。cooldown・lease・DAILY_PUBLISH_CAP は④に置き**経路非依存を構造で保証**する。
**`articlePathPatterns` の2段強制はそのまま2段で残す**（段数削減はシンプル化ではなく防御の削減）。

削減: 実装 1849行→900〜1100行（-40%前後）。テスト 2218行→1200行前後。合計 **-1500〜2000行**。

リスク: 本提案中**最も高い**。判定スライス抽出・MAX_LINK_DENSITY 校正・articlePathPatterns の
2段強制が退行しうる。

確認方法: 移行前に既存3経路の実データで**入出力ゴールデンセット**を取る
（`eval-golden-set.mjs` と `snapshots/anchors-*.json` が素地）。統合後に完全一致を要求。
`gate.ts` に「不変条件テーブル」を作り9項目それぞれに対応するテストを1箇所に置く。
統合の成否は「不変条件1つあたりの実装箇所数が1になったか」で測る。

### S3. 「本文を保存しない」を型で保証する（効果 高 / コスト 低 / リスク 低）← 費用対効果が最良

問題 = D2。§10-6 を代入規約とテストで守っており「気をつける」に依存している。

変更: 判定入力に使う本文テキストを DB 挿入型と**構造的に交わらない別の型**にし、本文保持型を
DB レイヤに import させない（`repository.ts` / `schema.ts` から到達不能に）。`Post` の挿入型から
discovery 経路で本文相当フィールドを渡す口を消す。**永続化しようとするコードが型エラーになる**
状態を作る。

削減: 行数は -100行程度と小さいが、**それを守るテストと目視レビューが不要になる**。
将来の経路追加時のコストが実質ゼロに。

リスク: 低。確認: 本文型を意図的に repository に渡すコードを書いて `pnpm type-check` が実際に
落ちることを試す（AGENTS.md「ゲートが緑であることと機能していることは別」をそのまま適用）。

### S4. 検証ゲートの実行場所を1箇所に集約する（数は減らさない）（効果 高 / コスト 低 / リスク 低）

問題 = D3。

変更: pre-commit=「秒で終わるもの」だけ（lint-staged=oxfmt+secretlint、oxlint、commit-msg）。
type-check は pre-push に移す。pre-push=`pnpm verify` **1コマンドの呼び出しだけ**にし、
`NEED_SMOKE`/`NEED_TEST` の分岐を husky シェルからテスト可能な mjs スクリプトに移す。CI も同じ
`pnpm verify` を呼ぶ → **ローカルと CI で定義が1つ**になる。**ゲートの種類は1つも減らさない**
（coverage tiers, spec-refs, security, migrations-additive, smoke, prod-schema drift すべて維持）。

削減: pre-commit 体感 -50%以上、pre-push のシェル行数 -60%。CI とローカルの乖離バグが消える。

リスク: pre-commit から type-check を外すと壊れたコードがコミットされる余地は増える（push は
できない）。個人プロジェクトかつ main 直コミット運用なので許容範囲。異論があれば type-check だけ
残してもよい。

確認: `pnpm verify` を意図的に壊して pre-push と CI の両方が落ちることを確認。

### S5. リンター一本化（効果 中 / コスト 低 / リスク 低・要調査）

問題: eslint と oxlint が両方 pre-push と CI で走る。

変更: oxlint に next/react プラグインが入っている以上、eslint-config-next のうち oxlint で
代替できないルールが何個残るかを実測し、残数が少なければ eslint を落とす（.tsx 23ファイルで
UI 層が薄く next 固有ルールの価値は限定的と推測）。差分が大きければ**逆に oxlint を落として
eslint 一本でもよい — 重要なのは「二重でないこと」**。

削減: 依存 -3〜6パッケージ、pre-push/CI から1ステップ、install 時間短縮。

**追加調査が必要**: 両者の実発火ルール差分。これを取らずに落とすのは危険。

### S6. `repository.ts` をユースケース境界で分割する（効果 中 / コスト 中 / リスク 低）

問題 = D4。1806行、`query.ts` との役割分担も不明瞭。

変更: テーブル単位ではなく**読み書きの目的単位**で5分割する。

1. フィード読み取り（公開済み posts の取得・整列）
2. 摂取書き込み（posts / rationales / usefulness の挿入）
3. 公開履歴（publications / removals / kind）
4. discovery 台帳（seen / run / host metrics）
5. アクセス規律の状態（source_policy / host_gate_state）
   — `access-discipline.ts` の隣に置き、**アクセス規律の実装とその永続状態を同じ境界に**する

削減: 行数はほぼ不変（-100行程度）。効果は探索性と、S2 の前提整備。

リスク: 純粋な移動。`tests/feed-order-parity.test.ts` 455行が回帰検出器として機能する。

### S7. 未使用テーブル・休眠カラムの「墓碑化」（DROP はしない）（効果 中 / コスト 低 / リスク 低・要調査）

問題 = D4。

変更: 各テーブル・カラムの実 read/write 参照数を計測し参照ゼロを特定。参照コードのみ削除し、
`schema.ts` に「使用停止日・理由・復活時の注意」をコメントで残す `@deprecated` 区画を作って
物理的に末尾へ隔離する。**`aiTitle` は例外として明示的に維持する**（却下案 N3 参照）。

削減: `schema.ts` の「読むべき領域」が 389→250行程度。`repository.ts` から数百行。

**追加調査が必要**: 14テーブルそれぞれの直近の書き込み実績（本番 Turso 側の行数）。
`check-prod-schema.sh` の隣に置ける調査。

### S8. テストの構造整理と実行時間の回復（効果 中〜高 / コスト 中 / リスク 中）

問題 = D6。

変更:

1. Tier1/2（url, signature, schemas, constants, usefulness, feed-parser, providers）を
   環境非依存の純粋ロジックとして分離し、happy-dom も DB も使わない別 vitest プロジェクトで
   **並列実行**（これらは OOM の原因ではない）
2. Tier5/6（DB を触る）だけ直列に残す
3. S2 完了後は `discovery-ingest.test.ts` と `pipeline-ingest.test.ts` の重複が消え
   最大ファイルが半減

削減: テスト総実行時間 -30〜50%（要実測）。テスト行数 S2 と合わせて -1000行前後。

リスク: OOM 再発で開発が止まる。

**追加調査が必要**: 現在のピークヒープ実測。「7.4GiB制約で OOM」というコメントが
**どのテスト群に起因するのか特定されていない可能性が高く、全体を直列にするのは過剰対処の疑い**。
原因が1〜2ファイルなら、そこだけ sequential 指定して残りを並列にできる。

### S9. `constants.ts` の設定データ分離と `shared_plan/` の整理（効果 中 / コスト 低 / リスク 低）

問題: `constants.ts` 468行に HOST_ALLOWLIST（articlePathPatterns 含む）等の運用データが
コードとして埋まっており、ホストを1つ足すたびにコード差分になりロジック変更と区別できない。
`shared_plan/` は 01〜16 が ADR・提案・実行計画を兼ね、決定済みか検討中かが判別できない。

変更: HOST_ALLOWLIST など運用中に変わるデータを JSON に出し起動時に zod で parse（型安全は維持）。
閾値定数はコードに残す。`shared_plan/archive/` を作り実装完了・撤回済みを移動する。
**決定事項は spec.md に吸収**（AGENTS.md「spec.md が唯一の参照先」原則に沿う）。
欠番はプレースホルダで理由を1行残す。

削減: `constants.ts` 468→250行程度。`shared_plan/` 直下 16→3〜5。

---

## 効果/コスト/リスク一覧

| 提案                          | 問題 | 効果   | コスト | リスク | 追加調査                              |
| ----------------------------- | ---- | ------ | ------ | ------ | ------------------------------------- |
| S1 リポジトリ衛生             | D5   | 中     | 低     | 低     | 不要（.env.local.bak-* のみ緊急確認） |
| S2 パイプライン単一化         | D1   | 高     | 高     | 中〜高 | ゴールデンセット取得必須              |
| S3 型による永続化保証         | D2   | 高     | 低     | 低     | 不要                                  |
| S4 ゲート集約                 | D3   | 高     | 低     | 低     | 不要                                  |
| S5 リンター一本化             | —    | 中     | 低     | 低     | 必要（ルール差分実測）                |
| S6 repository 分割            | D4   | 中     | 中     | 低     | 不要                                  |
| S7 墓碑化                     | D4   | 中     | 低     | 低     | 必要（本番書き込み実績）              |
| S8 テスト整理                 | D6   | 中〜高 | 中     | 中     | 必要（ピークヒープ実測）              |
| S9 定数分離 / shared_plan整理 | —    | 中     | 低     | 低     | 不要                                  |

---

## やってはならないこと

- **N1. discovery で取得した本文を DB にキャッシュ保存する** — **§10-6 の直接違反**。
  他人の著作物のデータベースを作らないことが本プロジェクトの成立要件。パフォーマンス上の利益が
  どれだけ大きくても検討対象外。むしろ S3 で型レベルに不可能化する方向へ。
- **N2. `rationaleText` の zod refine を廃しプロンプト指示で担保する** — **機械的拒否を確率的な
  指示に置き換える**もので保証の等級が落ちる。zod refine は1関数・数十行で複雑性への寄与は
  ほぼゼロ。**コストが小さく保証が強いものはシンプル化の対象ではない**。
- **N3. `aiTitle` 休眠カラムを DROP する** — (a) `check-migrations-additive.mjs` ゲートに違反
  (b) より重要なのは、**null 固定のカラムが存在すること自体が「AI書き換えを一度も行っていない」
  ことの監査可能な証跡**であること。列が無ければ「そもそも記録していない」のか「していない」のか
  外部から区別できない。**S7 の墓碑化対象からも明示的に除外**。
- **N4. マイグレーション 0000〜0012 を squash する** — `check-migrations-additive.mjs` と
  `check-prod-schema.sh`（本番スキーマ drift 検査）の両方と正面衝突。得られるのは13→1ファイルだけで、
  **本番 DB と履歴の対応が失われるリスク**に見合わない。マイグレーション履歴は
  「増えるのが正常」な資産。
- **N5. `check-coverage-tiers.mjs` / `smoke-test.sh` / `check-spec-refs.sh` を廃止してゲート数を
  減らす** — **ゲートの数と複雑性は別物**。本プロジェクトの複雑性は「同じゲートを3回走らせている」
  （S4で解決）と「不変条件が3箇所に散っている」（S2で解決）に由来する。Tiered Coverage は
  「RSC/UI を除外して smoke test で担保」という**メリハリの効いた設計**で、それ自体が既に
  シンプル化の成果。触らない。
- **N6. Drizzle をやめて生 SQL / Turso をやめてローカル SQLite** — 見かけの依存数は減るが
  `repository.ts` の型安全が失われ実質的な複雑性は増える。Turso をやめれば Vercel Cron からの
  `/api/ingest` が動かずアーキテクチャ全体の作り直しになる。**依存の個数はシンプルさの指標
  ではない**。
- **N7. monorepo 化 / `packages/` 分割** — `pnpm-workspace.yaml` に `packages:` が無い現状が
  正しい。30k行の単一アプリを分割する理由が存在しない（YAGNI）。workspace ファイルは
  allowBuilds のためだけに残っているので**そのままにしておくのが正解**。
- **N8. 3経路を残したまま共通部分だけユーティリティに切り出す** — S2 の「安全な代替案」に
  見えるが、実際には**4つ目の抽象を足すだけ**で経路ごとの分岐は残り、不変条件が守られる箇所が
  3から4に増える。**やるなら S2 の完全統合、やらないなら現状維持の二択で、中間はない**。

---

## 実行計画

実行順は以下の理由による。**S2 以外はすべて独立コミット可能**であり、それぞれ単独で
着手・撤回できる。S2 のみ複数コミットに分割し shadow mode で慎重に進める。

### フェーズA: まずこれ（低コスト・低リスク・即効・独立コミット可）

#### Stage 0. `.env.local.bak-*` の中身と履歴混入の緊急確認

- 担当: @explorer
- 内容: `.env.local.bak-*` の中身を確認し、秘匿情報の有無と git 履歴への混入有無を調べる。
  `check-security.sh` がなぜ検出していないかも確認する。
- 判定: Orchestrator が結果を確認し、秘匿情報が含まれていれば S1 着手前に緊急対応（鍵のローテーション等）を検討する。

#### Stage 1. S1 リポジトリ衛生

- 担当: @fixer
- 内容: 浮遊物7個の削除、`.gitignore` 追加、`scripts/` の `gates/` `ops/` `archive/` 3分割、
  各ファイル先頭コメント付与。
- 検証: Orchestrator が pre-push・ci.yml を一度通し、パス移動によるフック/CI breakage が
  ないことを確認する。

#### Stage 2. S4 ゲート集約

- 担当: @fixer
- 内容: pre-commit を秒で終わるものだけに削減、type-check を pre-push に移動、
  `pnpm verify` スクリプトを新設して pre-push と CI から共通で呼ぶ形に統一、
  `NEED_SMOKE`/`NEED_TEST` 分岐を mjs スクリプト化。
- 検証: Orchestrator が `pnpm verify` を意図的に壊し、pre-push と CI の両方が実際に落ちることを
  確認する（AGENTS.md「ゲートが緑であることと機能していることは別」の適用）。

#### Stage 3. S3 型による永続化保証

- 担当: @fixer
- 内容: 判定入力用の本文テキスト型を DB 挿入型と構造的に交わらない別型として定義し、
  `repository.ts` / `schema.ts` から到達不能にする。
- 検証: Orchestrator が本文型を意図的に repository に渡すコードを書いて
  `pnpm type-check` が実際に落ちることを確認する。確認後そのコードは削除する。

### フェーズB: 次に（構造変更・要ゴールデンセット）

#### Stage 4. S6 repository 分割

- 担当: @fixer
- 内容: `repository.ts` をフィード読み取り / 摂取書き込み / 公開履歴 / discovery台帳 /
  アクセス規律状態の5ファイルに分割（純粋な移動）。
- 検証: Orchestrator が `tests/feed-order-parity.test.ts` を含む既存テスト一式を実行し
  回帰がないことを確認する。

#### Stage 5. S7 墓碑化

- 担当: @explorer が14テーブル・休眠カラムの参照数を計測（本番 Turso の書き込み実績含む）→
  結果を Orchestrator が確認 → @fixer が参照ゼロのコードのみ削除し `@deprecated` 区画に隔離
- 内容: `aiTitle` は明示的に対象外（N3）。
- 検証: Orchestrator が type-check・test・migrations-additive ゲートを実行し、
  物理 DROP をしていないことを確認する。
- **実績（2026-08-31）: 調査完了 → 墓碑化対象ゼロでクローズ（コード変更なし）。**
  14テーブル全て read/write 参照あり（本番行数≧1）で、休眠カラムもゼロ。
  S7 の前提「evidenceSignalObservations / discoveryHostMetrics / postRetryQueue /
  post_publication_kind は実験由来で参照ゼロ」は計測により反証。
  `aiTitle` は spec.md §11 どおり「値が常に null の休眠カラム」として維持（N3 遵守）。
  旧 `post_usefulness` 孤児テーブル（本番43行）は schema.ts / spec.md /
  migrations-additive.mjs（`LEGACY_ORPHANED_OWNED_TABLES`）に既に文書化済みで放置判断。

#### Stage 6. S2 パイプライン単一化（最大の効果・最大のリスク）

- 前提: Stage 1（S1）・Stage 3（S3）・Stage 4（S6）が完了していること。
- 担当: @explorer がゴールデンセット取得 → 結果を Orchestrator が確認 → @fixer が統合実装
- 内容: 3コミットに分割する。
  1. ゴールデンセット取得（既存3経路の実データで入出力を記録。`eval-golden-set.mjs` と
     `snapshots/anchors-*.json` を素地とする）— 担当 @explorer
  2. 統合実装（候補供給/原文取得/判定/公開ゲートの4段構造への切り替え。中間状態では
     **旧経路を権威とし新経路の出力を比較のみに使う shadow mode** でリスクを封じ込める）—
     担当 @fixer
  3. 旧経路削除（shadow mode で完全一致を確認できてから）— 担当 @fixer
     cooldown の経路非依存化はこの Stage で併せて解決する（Stage 7-3 の調査結果を踏まえる）。
- 検証: Orchestrator がゴールデンセットとの完全一致、`gate.ts` の不変条件テーブルに対する
  9項目それぞれのテスト、既存テストスイート全体を実行して確認する。
  articlePathPatterns の2段強制が維持されていることを個別に確認する。

#### Stage 7. S8 テスト整理

- 前提: Stage 6（S2）完了後（重複テストが消えた後に行うのが正しい順序。先にやると
  消える予定のファイルを最適化してしまう）。
- 担当: @explorer がピークヒープを実測し OOM の原因ファイルを特定 → 結果を Orchestrator が
  確認 → @fixer が Tier1/2 を並列実行可能な別 vitest プロジェクトに分離
- 検証: Orchestrator がテスト総実行時間の短縮を実測し、OOM が再発しないことを確認する。

### フェーズC: やるなら最後（判断材料が足りない / 効果が限定的）

#### Stage 8. S5 リンター一本化

- 担当: @explorer が eslint-config-next と oxlint の実発火ルール差分を実測 →
  結果を Orchestrator と検討し、どちらを残すか判断した上で @fixer に実装委譲
- 理由: ルール差分の実測が前提。効果は install 時間程度で、S4 が済めば体感の改善は小さいため
  最後に回す。

#### Stage 9. S9 定数分離 / shared_plan 整理

- 担当: @fixer
- 内容: HOST_ALLOWLIST 等運用データの JSON 化＋起動時 zod parse、`shared_plan/archive/` の新設と
  完了・撤回済みプランの移動、決定事項の spec.md への吸収。
- 理由: 効果は認知負荷のみ。S2 で `constants.ts` の参照構造が変わる可能性があるため後に回す。
- 検証: Orchestrator が type-check・test を実行し、JSON parse の zod スキーマが機能する
  （不正な JSON を与えて実際に落ちる）ことを確認する。

---

## 完了判定チェックリスト

**行数を主指標にしない**（S3 のような「行は増えないが保証が強くなる」改善を過小評価するため）。

### 主指標

- [ ] **M1. 不変条件あたりの実装箇所数（最重要）** — 法務不変条件9項目それぞれについて、
      その条件を強制しているコード箇所を数える。現状は経路分散により1条件あたり2〜3箇所と推測。
      **目標は全項目で1**。9項目に ID を振りコード上のコメントアンカー（例 `INV-6`）を
      必須にして grep で数える。`check-spec-refs.sh` の既存機構に相乗りできる可能性が高い。
- [ ] **M2. 経路分岐点の数** — `provenance` / 経路名による条件分岐の出現箇所数。
      S2 完了後の目標は**候補供給層のみに存在し、Curate 以降ではゼロ**。
- [ ] **M3. 型で不可能化された不変条件の数** — 「テストが無くても壊せない」不変条件の数。
      現状 0 → S3 後 1（本文の非永続化）。長期的には逐語タイトルも同様に型で守れるはず。

### 副指標

| 指標                           | 現状        | 目標                            |
| ------------------------------ | ----------- | ------------------------------- |
| 最大ファイル行数（src）        | 1806        | < 600                           |
| 最大テストファイル行数         | 1503        | < 500                           |
| pre-commit 実行時間            | 未計測      | < 5秒                           |
| pre-push 実行時間              | 未計測      | 短縮を確認（CI と同一コマンド） |
| scripts/ 直下のファイル数      | 46          | < 15（archive/ 除く）           |
| リポジトリ直下の非設定ファイル | 7個の浮遊物 | 0                               |
| lint ツール数                  | 2           | 1                               |
| ソース総行数                   | 30,233      | -15〜20%（副産物として）        |

### 完了と見なさない条件

AGENTS.md の原則をそのまま適用する。**S3 の型ガードと S4 のゲート集約は、意図的に壊して
落ちることを確認するまで完了ではない。** 特に S3 は「型エラーになるはずのコードを一度書いて
`pnpm type-check` が実際に落ちる」ことを目視するまで保証されたとは言えない。

**テスト実装とテスト実行の分離**: 各 Stage のテスト実装・修正は @fixer が行い、
その実行・検証結果の確認は Orchestrator 自身が行う（サブエージェントが自らの実装を自己検証
する運用は禁止）。

---

## リスクと対処

| リスク                                                                                | 対処                                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| S1 のパス移動で husky/CI が壊れる                                                     | 移動直後に pre-push・ci.yml を一度通す。全ゲート blocking のため沈黙 fail しない                                                |
| S2 で判定スライス抽出・MAX_LINK_DENSITY 校正・articlePathPatterns の2段強制が退行する | 統合前にゴールデンセットを取得し、統合後に完全一致を要求。shadow mode で新旧を並走させ旧経路を権威とする                        |
| S2 の中間状態で新旧経路が長期併走し複雑性が一時的に増える                             | 3コミットに分割し、ゴールデンセット取得→統合実装→旧経路削除を短いスパンで完了させる                                             |
| S4 で pre-commit から type-check を外すと壊れたコードがコミットされる余地が増える     | push はできないため実害は限定的。個人プロジェクト・main直コミット運用のため許容。異論があれば type-check だけ pre-commit に残す |
| S7 で本当に必要なテーブル・カラムを誤って墓碑化する                                   | 事前に本番 Turso の書き込み実績を実測（Stage 5 の @explorer 調査）。物理 DROP はせず `@deprecated` 区画への隔離のみ             |
| S8 で OOM が再発し開発が止まる                                                        | 事前にピークヒープを実測し原因ファイルを特定（Stage 7 の @explorer 調査）。原因ファイルのみ sequential 指定を残す               |
| `.env.local.bak-*` に秘匿情報が混入している場合の対応漏れ                             | Stage 0 で S1 より先に単独確認し、必要なら鍵ローテーション等を Orchestrator が別途判断する                                      |

---

## 対象外 / 追加調査が必要な点

以下は推測で断定していない箇所であり、着手前に個別調査が必要。

1. **`.env.local.bak-*` の中身と履歴混入の有無** — 秘匿情報が入っていれば S1 より前に
   緊急対応。`check-security.sh` がなぜ検出していないかも要確認。（Stage 0 で先行調査）
2. **eslint-config-next と oxlint の実発火ルール差分**（S5 の前提。Stage 8 で調査）
3. **vitest OOM の実際の原因ファイル** — 全体直列化が過剰対処である可能性。per-file の
   ピークヒープ測定が必要（S8 の前提。Stage 7 で調査）
4. **14テーブルの本番における実書き込み実績** — どれが本当に死んでいるか（S7 の前提。
   Stage 5 で調査）→ **2026-08-31 調査済み: 全テーブルに書込経路・本番行数あり。死んでいる
   テーブル・休眠カラムはゼロ。旧 `post_usefulness`（schema.ts 未定義の孤児）のみ残存で
   文書化・放置判断済み。**
5. **`scripts/` の使い捨て15個が CI/docs/spec から参照されていないか** — archive 移動前に
   grep が必要（Stage 1 の一部として @fixer が実施前に確認）
6. **cooldown が `/admin` 経路のみに掛かる理由** — 意図的な設計（手動操作の連打防止）なのか、
   経路分散による見落としなのか。**前者なら S2 で「操作起点のガード」として明示的に分類すべきで、
   後者なら経路非依存に是正すべき**。spec.md §11 と照合して仕様上の判断が必要
   （Stage 6 の S2 統合実装時に判断）
7. **`counterfactual-thresholds.mjs` 等の較正結果が spec.md に反映済みか** — 未反映なら
   スクリプトが暗黙の仕様書になっており、archive 移動前に spec.md へ吸収が必要
   （Stage 1 の一部として @fixer が実施前に確認）

本文書自体は spec.md の更新を伴わない（提案段階のため）。各 Stage が実際に着手・完了した際は、
関連する spec.md の記述（特に §10/§11 に接続する部分があれば）を個別に更新すること。
