# 08. plan 06 / 07 未コミット実装のコミット計画

- 対象: `wedding-trend`（本プロジェクト）
- 作成日: 2026-08-25
- 前提コミット: `8e7c506`
- 状態: **実行済み（C1〜C8 の8コミットを作成し push 済み）**。実行結果は `df00dad`〜`b04900b`（8コミット）。以下の計画本文は実行前の計画として残す。§10 に関する記述の訂正は §4 を参照
- 参照: `shared_plan/06-rationale-and-scraping.md`、`shared_plan/07-unattended-operation.md`

---

## 1. 現状

`8e7c506` 以降、plan 06（discovery 基盤）と plan 07（無人運転の統制）の実装が
**すべて未コミットのまま作業ツリーに滞留している**。

```
35 files changed, 5127 insertions(+), 466 deletions(-)
＋ 未追跡ファイル 27 件（新規モジュール・マイグレーション・テスト・計画文書）
```

1 コミットにまとめると追跡不能になるため、**論理単位で 8 分割する**。

### 全ゲート通過済み（2026-08-25 時点）

| ゲート             | 結果                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| vitest             | 400 / 400                                                                                  |
| type-check         | 通過                                                                                       |
| oxfmt              | クリーン                                                                                   |
| oxlint             | クリーン                                                                                   |
| eslint（RSC 境界） | クリーン                                                                                   |
| check-spec-refs    | 通過                                                                                       |
| カバレッジ段階検証 | 全ティア達成（Tier 1: 98.18% / 2: 86.15% / 3: 85.22% / 4: 82.30% / 5: 82.29% / 6: 82.93%） |
| smoke-test         | 通過                                                                                       |

### 意図的破壊検証済み（AGENTS.md「ゲートが緑であることと、機能していることは別」）

| 破壊内容                                  | 失敗件数 |
| ----------------------------------------- | -------- |
| `filterTitle` を常時通過に                | 11       |
| `checkAnchorGrounding` を常時接地に       | 10       |
| K2 の `tosUrl` 解決を無効化               | 2        |
| `DAILY_PUBLISH_CAP` を 999999 に          | 6        |
| `HOST_DAILY_SHARE_MAX` を 1.0 に          | 2        |
| 記事パスホワイトリストを常時許可に        | 2        |
| ホワイトリストから `story` リテラルを除去 | 4        |
| フィード可視条件を 3 層とも除去           | 2        |

---

## 2. コミット分割

### C1. plan 06 discovery 基盤

```
feat(sources): sitemap 差分発見と本文抽出・アクセス規律レイヤーを追加
```

- `src/lib/sources/sitemap-discovery.ts`（新規）
- `src/lib/sources/article-text.ts`（新規）
- `src/lib/sources/access-discipline.ts`（新規・K1〜K7）
- `src/lib/db/migrations/0004_post_rationales.sql` 〜 `0008_host_gate_state.sql`
- `tests/sitemap-discovery.test.ts`、`tests/article-text.test.ts`、`tests/access-discipline.test.ts`（新規）
- `src/lib/db/schema.ts`・`src/lib/db/repository.ts`（**ハンク分割要**: discovery 系テーブルの定義と操作のみ）
- `src/lib/constants.ts`（**ハンク分割要**: クロール規律の定数のみ）

### C2. plan 07 M1 / Q1 / Q5 ── 出力統制

```
feat(publish): 無検閲の公開チャネルを閉じ根拠文をテンプレート化する
```

- `src/lib/publish/gate.ts`（新規・`filterTitle` / `checkAnchorGrounding` / `renderRationaleText`）
- `tests/publish-gate.test.ts`（新規）
- `src/lib/llm/schemas.ts`・`src/lib/llm/prompts.ts`・`src/lib/llm/batch.ts`
  （`evidenceSufficient` と `rationaleText` を LLM 出力から除去）
- `tests/llm-schemas.test.ts`・`tests/llm-batch.test.ts`
- `src/lib/sources/article-text.ts`（**ハンク分割要**: Q1 の決定的計算部分）

### C3. plan 07 §7 ── `pending` 廃止

```
refactor(db): pending を廃止し理由コード付き終端と TTL 再試行キューに置き換える
```

- `src/lib/db/migrations/0009_post_publications_removals.sql`、`0010_post_publication_kind.sql`
- `src/lib/types.ts`（**ハンク分割要**: `PostStatus` / `DropReason` / `RetryLane` 等。`takedown_request` は C7）
- `src/lib/db/schema.ts`・`src/lib/db/repository.ts`（**ハンク分割要**: `post_removals` / `post_retry_queue`）
- `src/lib/pipeline/ingest.ts`（**ハンク分割要**: 再試行キュー消費）
- `tests/db.test.ts`・`tests/pipeline-ingest.test.ts`（**ハンク分割要**）

### C4. plan 07 M4 ── 客観トリガによる自動撤回

```
feat(pipeline): 客観トリガによる自動撤回と sticky な再公開禁止を追加
```

- `src/lib/pipeline/discovery-ingest.ts`（新規・`revalidatePublishedPosts` 含む）
- `tests/discovery-ingest.test.ts`・`tests/discovery-repository.test.ts`（新規）
- `src/lib/types.ts`（**ハンク分割要**: `RetractionReason` の客観 4 値）
- `src/lib/pipeline/evergreen.ts`・`src/lib/pipeline/submit-url.ts`（撤回トリガー統合）
- `tests/pipeline-evergreen.test.ts`・`tests/pipeline-submit-url.test.ts`

### C5. plan 07 M3 ── K2 の休眠解消

```
fix(sources): K2 規約変更検知の休眠を解消し allowlist から ToS URL を解決する
```

- `src/lib/constants.ts`（**ハンク分割要**: `AllowlistedHost` 型・`tosUrl`・`getAllowlistedTosUrl`）
- `src/lib/sources/access-discipline.ts`（**ハンク分割要**: `tosUrl` 解決・`__setAllowlistTosResolverForTests`・`__setK2CheckIntervalForTests`・`checked_at` 共有の JSDoc）
- `tests/access-discipline.test.ts`（**ハンク分割要**: 本番経路テストと throttle 有効性テストの対）

> **本コミットの要点**: 実装は存在していたが `source_policy.tos_url` を非 null で
> 初期化する経路が無く、K2 は構造的に発火しなかった（plan 07 §5-M3 が名指しで
> 警告した「実装済みに見えて動いていない」状態）。テストは `seedPolicyForTos()` で
> 手動注入していたため緑だった。

### C6. plan 07 Q3 / Q4 ── 被害半径の限定

```
feat(pipeline): 記事パス allowlist と日次公開上限で被害半径を限定する
```

- `src/lib/constants.ts`（**ハンク分割要**: `articlePathPatterns`・`isAllowedArticleUrl`・`DAILY_PUBLISH_CAP = 10`・`HOST_DAILY_SHARE_MAX`）
- `src/lib/sources/sitemap-discovery.ts`（**ハンク分割要**: seed 段階のフィルタ）
- `src/lib/pipeline/discovery-ingest.ts`（**ハンク分割要**: 取得直前の強制・`skippedPathNotAllowed`）
- `tests/discovery-ingest.test.ts`・`tests/sitemap-discovery.test.ts`（**ハンク分割要**: 境界テスト）
- `tests/pipeline-ingest.test.ts`（**ハンク分割要**: 上限のリテラル固定・off-by-one）

### C7. plan 07 M5 ── 撤回手段と連絡先

```
feat(ops): 1コマンド撤回ツールと削除要請の理由コードを追加
```

- `scripts/retract.mjs`（新規）
- `package.json`（`retract` エントリ）
- `src/lib/types.ts`（**ハンク分割要**: `takedown_request`）
- `src/lib/db/repository.ts`（**ハンク分割要**: `findPostByUrlForRetraction` / `listPublishedByHostForRetraction`）
- `tests/db.test.ts`（**ハンク分割要**: sticky を双方向で固定）
- `src/app/layout.tsx`（フッターの撤回要請導線）

### C8. ドキュメントと CI

```
docs(spec): UGC コーパスの制約と中止トリガー・allowlist 入場基準を記録する
```

- `openspec/specs/wedding-trend/spec.md`（§10-6 更新、§10-7〜§10-11 と §11 を新設）
- `shared_plan/05-evergreen-automation.md`、`06-rationale-and-scraping.md`、
  `06-section-yield-probe-2026-08-24.log`、`07-unattended-operation.md`、本ファイル
- `.github/workflows/discovery.yml`（新規・**schedule はコメントアウトのまま**）
- `.github/workflows/weekly-monitor.yml`、`.husky/pre-push`、`docs/git-hooks.md`、`docs/tooling.md`
- `scripts/check-discovery-freshness.mjs`、`check-migrations-additive.mjs`、
  `migrations-additive.mjs`、`check-spec-update.sh`、`run-discovery.mjs`、
  `apply-migrations-remote.mjs`、`smoke-test.sh`
- `vitest.config.ts`、`tests/helpers/test-db.ts`、`pnpm-lock.yaml`
- `AGENTS.md`（`next dev` が自動生成・再追記するブロック。コミットしないと再生成され続けるため含める）

---

## 3. 実行上の注意

### 3.1 ハンク単位のステージングが必要

`src/lib/constants.ts`・`src/lib/types.ts`・`src/lib/db/schema.ts`・
`src/lib/db/repository.ts`・`src/lib/pipeline/discovery-ingest.ts`・
`tests/pipeline-ingest.test.ts` などは**複数のコミットにまたがる**。

`git add -i` / `git add -p` の対話モードは**この環境では使用不可**。
`git apply --cached` にパッチを渡すか、一時的にファイルを分割編集する方式を採る。

**分割が困難と判断した場合は、無理に分けず C1〜C7 の粒度を粗くしてよい。**
分割の目的は追跡可能性であって、分割それ自体ではない。

### 3.2 フック

- `commit-msg` が Conventional Commits を強制する（上記メッセージは準拠済み）
- `pre-commit` の `lint-staged` は `vitest related` を**作業ツリーに対して**走らせるため、
  中間コミットでもテストは緑になる
- `pre-commit` は `src/` の未ステージ変更を **warning** で報告する。分割コミット中は
  常に出るが、ブロックはしない
- **フックの bypass は禁止**（`--no-verify` / `HUSKY=0` 等。`~/.local/bin/git` ラッパーで
  技術的にもブロック済み）

### 3.3 bisect 可能性

分割コミットは**個々が自己完結しない**（C1 の時点で C4 の呼び出し先が未コミット等）。
`git bisect` の対象にする場合はこの点に留意する。全体が緑になるのは C8 完了時点。

---

## 4. コミット後に残る事項

| 事項                                | 状態                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本番 Turso へのマイグレーション適用 | **未適用**（0004〜0010）。`scripts/apply-migrations-remote.mjs` を使う                                                                                                                                                                                                                                         |
| `discovery.yml` の schedule         | **無効のまま**。有効化は plan 07 §13 の D2 判断を経てから                                                                                                                                                                                                                                                      |
| §8 の較正（golden set）             | **実施しない判断**。誤り率が未知のまま運用することを明示的に引き受けた                                                                                                                                                                                                                                         |
| §10 の著作者クレジット要件          | **2026-08-25 訂正**: 現ホストでは `author` が常に null だが、要件2 は当初から条件付き（非 null の場合のみ表示）であり、実装は仕様を充足している。「構造的に達成されない」という旧記述は誤りで撤回した（spec.md §10-7）。残る既知の限界は本文中に可視バイラインがあり構造化メタデータに無い場合の取りこぼしのみ |
| コンテンツ種別ラベルの表示          | 未実装。`sourceType` では判定不能で、ホスト単位判定を `FeedCard` まで通す `src/lib/` 変更が要る                                                                                                                                                                                                                |
| OGP 抜粋の表示長上限                | **不要**。`originalExcerpt` は `FeedCard` に露出しておらず、フィードに表示されていない                                                                                                                                                                                                                         |

---

## 5. 本作業で得られた知見

**「テストが緑であること」は 3 回連続で信頼できなかった。**

1. **K2** ── テストが `seedPolicyForTos()` で `tosUrl` を手動注入していたため緑。
   本番経路では常に null で、規約変更検知は一度も発火しない状態だった
2. **日次公開上限** ── テストが期待値を `DAILY_PUBLISH_CAP` 定数から動的に導いていたため、
   上限を 999999 に戻しても 1 件も落ちなかった
3. **フィード可視条件のガード** ── 追加直後は「条件を外しても落ちない」ように見えたが、
   実際には 3 層（SQL 条件・JS 可視フィルタ・`category`/`tag` フィルタ）で守られており、
   3 層すべてを同時に壊して初めて落ちた。保護の実体は
   **「未キュレーションの記事は描画できない」という構造的性質**だった

いずれも**意図的破壊検証によってのみ判明した**。
新しい検証機構を追加したら、必ず壊して落ちることを確認すること。
