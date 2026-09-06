# 18. リファクタリング計画 — シンプル化、テスト高速化、実行効率化

- 対象: `wedding-trend` 全体
- 作成日: 2026-09-05
- State: **縮小確定scope完了 (2026-09-06)** — 本書の今回scopeは、軽量なgate信頼性修正・test移設・format解消と、重い残件のPlan 24への移管である。本書の `[x]` は実装と対象受入が済んだことを表す。Plan 18-aiの再実施および機能変更は含まない。設計判断、本番経路への配線、履歴整合、反復計測を要する残件は [Plan 24](./24-refactoring-acceptance-and-runtime-slices.md) の独立sliceとして管理する。
- 不変条件: `openspec/specs/wedding-trend/spec.md` §10 / §11。記事本文の非生成・非永続化、逐語タイトル、アクセス規律、fail-closedを変更しない。

## 今回の実装範囲

実装対象rangeは `958ac8b^..18492ee`（起点を含む11コミット）である。

1. `958ac8b` `fix(gates): fail closed for production schema checks`
2. `4244399` `test: standardize Vite config warning policy`
3. `76025c4` `ci: retain full history for change detection`
4. `168c62a` `feat(gates): add read-only migration metadata audit`
5. `d4b0849` `refactor(llm): centralize JSON parsing and error classification`
6. `f1591e5` `refactor(pipeline): extract hashing and URL deduplication helpers`
7. `01ada4a` `test(legal): guard against topic slice persistence`
8. `e03b4ff` `docs(spec): define production schema verification contract`
9. `db68f14` `docs(plan): record partial Plan 18 refactoring progress`
10. `6dfab54` `docs(plan): record committed-slice verification`
11. `18492ee` `refactor(llm): centralize batch JSON parsing`

### 受入確認済みの狭い成果物（コミット状態は別管理）

- [x] production schema target guard: `file:` はnegative確認でexit 1、本番 `libsql:` はread-only検査でup-to-dateを確認。ローカルSQLiteを本番成功と誤認しない。
- [x] Vite config-loader warningの根治: `vitest.config.mts` への移行と `import.meta.dirname` 化後、直接Vitestおよび実環境 `pnpm verify`（smoke/coverageを含む）でwarningなしを確認。stderr policy全体はPlan 24 Slice 2で継続する。
- [x] CIの `fetch-depth: 0`。
- [x] migration metadataのread-only report tool。修復・squash・書込みはしない。
- [x] batch実経路のfence除去→JSON parse→Zod検証、raw応答をログへ出さないnegative test、および仕様同期。retry/chunk/error処理全体の共通化は未完。
- [x] body hashとURL dedupeの抽出。
- [x] topics sliceの非永続化に対する法務回帰テスト。
- [x] production schema検証契約のspec同期（`e03b4ff`）。

### 未コミットの軽量slice（対象受入済み）

- [x] `verify.mjs` のgit呼出しを `execFileSync` の引数配列へ置換し、committed/staged/tracked/untracked/renameを収集する。git比較不能時は `reliable: false` としてtest/smokeを必ず実行する。module exportと絶対パス比較のCLI main guardにより、実モジュールを直接検証できるようにした。
- [x] `tests/verify-changed-files.test.ts` はregex/`new Function` 抽出を廃止し、実moduleでbase不在、committed、tracked、staged、untracked、rename、git failure fail-safeを検証する。
- [x] body hash test移設に伴う2ファイルのformatを解消した。production/assertionの意味は変更しない。
- [x] 対象検証は3 files / 48 passed / 1 skipped、対象oxfmt成功。sandboxでGit spawnがEPERMとなるnegativeでも、実 `pnpm verify` は `Changed files count: 0`、`reliable: false`、`needTest: true`、`needSmoke: true`となりskipしなかった。
- [x] 実環境の `pnpm verify` はchanged files 49、`reliable: true`、test/smoke実行で全gate成功（58 files / 617 passed / 1 skipped、coverage tiers pass、production schema up-to-date）。Vite config-loader warningは根治済み。devDependency advisory warningは別件non-blockingで残る。

### AI計画との境界

`topics-batch` のparse共通化とtopics slice leak testは、既存処理の重複削減と§10/§11の法務安全網である。prompt、schema、UI、topic仕様は変更していない。従ってPlan 18-aiの再実施ではない。

## 残件の移管

Plan 18の縮小確定scopeでは、以下の重い残件を二重管理しない。すべて [Plan 24](./24-refactoring-acceptance-and-runtime-slices.md) に移管済みである。

- pipeline責務分離とgolden set
- `discovery-ingest.ts` / `run-pipeline.ts` の責務分離とgolden set
- host concurrencyの導入可否
- CI job並列化の再評価、cold/warm各5回のKPI

### 見送り・延期・完了ブロッカーの区分

「見送り」は未達を隠す語として使わない。各項目は次の三分類で管理する。

| 区分          | 項目                         | 判断と再開・完了条件                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 対象外        | LLM汎用batcher化             | 通常batchは30件を`p-limit`で並列処理し、topicsは25件を逐次処理する。retry、chunk、fallbackの差異は意図的である。共通化対象はfence除去、JSON parse、エラー分類などの共通骨格までとし、実行制御の統合は本Planの対象外とする。差異が減少し、重複削減の実測効果が抽象化コストを上回る場合だけ、別Planで再評価する。 |
| Plan 24移管   | pipeline責務分離             | 行数だけを根拠に分割しない。実経路use case、unit/integration、fresh clone、複雑性低減の証拠がそろう縦sliceだけを実施する。                                                                                                                                                                                      |
| 完了          | CI job並列化の採否           | cold/warm各5回とCI gate相当の計測で目標未達を確認した。GitHub remote CIのqueue/startupは認証・network不通で未取得のため、証拠なき並列化は非採用とした。復旧後にsuccessful main runs 5件以上で再評価する。                                                                                                       |
| 完了          | host concurrency採否         | 未配線helperと専用testを非採用削除した。現行access disciplineは維持する。host待ちが実測で有意なボトルネックとなる場合のみ別sliceで再評価し、採用時はspec §11同期・negative・fetch traceを必須とする。                                                                                                           |
| local受入完了 | migration metadata audit統合 | `0000`–`0002`をDrizzle管理、`0003`–`0014`を手動additiveとして履歴確定し、manual manifestのhash監査、local verify配線、negative、空SQLite file適用、本番read-only検証を完了した。推測snapshotは追加しない。未コミットのためremote CI反映とfresh cloneはcommit/push後に確認する。                                 |
| 完了          | verify changed detection     | `execFileSync`、git失敗時full test/smoke fallback、実module test、sandbox negativeと実環境full verifyで受入済み。                                                                                                                                                                                               |
| 完了          | stderr policy採否            | Vite config-loader warningは抑止なしで根治済み。console spyの未配線helperと包括process stderr gateは、既存gateの意図的stderr、allowlist肥大、ログ欠落リスクにより非採用とした。CIでstderr品質契約が必要になり、全gate出力分類とprocess単位negativeが可能になった時だけ再評価する。                              |

### 未配線scaffoldingの採否

typed config、clock、DB port、stage型、host concurrencyのscaffoldingは未追跡かつ未配線であった。保持し続ける方針は採らない。Plan 24 Slice 3で、production未参照かつ専用test以外からも参照されないclock、stage型、runtime config、DB portは非採用として削除済みである。DbPortは約50の既存関数を束ねるだけでproduction境界になっておらず、採用には全DBのDI設計を要するため削除した。host concurrencyもPlan 24 Slice 5で、性能/fetch trace根拠がなく現行access disciplineで要件を満たすため非採用削除済みである。trackedファイルはuntracked scaffoldingに依存させず、committed sliceとCI fresh cloneを壊さない。

削除前の未配線scaffoldingは次の10件だった。clock、stage型、runtime config、DbPort、および各専用testの8件はPlan 24で非採用削除済みであり、過去の足場の証跡として本一覧を保持する。

- `src/lib/config/runtime.ts`（Plan 24で非採用削除済み）
- `src/lib/time/clock.ts`（Plan 24で非採用削除済み）
- `src/lib/db/port.ts`（Plan 24で非採用削除済み）
- `src/lib/pipeline/stages.ts`（Plan 24で非採用削除済み）
- `tests/config-runtime.test.ts`（Plan 24で非採用削除済み）
- `tests/clock.test.ts`（Plan 24で非採用削除済み）
- `tests/db-port.test.ts`（Plan 24で非採用削除済み）
- `tests/pipeline-stages.test.ts`（Plan 24で非採用削除済み）

clock、stage型、runtime config、DbPort、host concurrency、および各専用testの10件はPlan 24で非採用削除済みである。

さらに、未完のためコミットから除外したものは `tests/audit-migration-metadata.test.ts` である。なお、actionsの正しいパスは `src/app/actions.ts` であり、`src/lib/pipeline/actions.ts` ではない。

`.sqlite/wedding-trend.db` と `tmp-*.ts` はPlan成果物、検証対象、コミット対象のいずれでもない。削除または保持は別判断とする。

### migration metadata auditの状態

`0000`–`0002`はDrizzle管理、`0003`–`0014`はmanual additiveとしてGit履歴を根拠に確定した。manual migrationはSHA-256と理由をmanifestへ記録し、推測によるsnapshot後付けは行わない。auditは排他的分類、managed metadata、manual hash、およびunknown/duplicate/orphan/gap/misname/malformedをfail-closedで監査し、local verifyへ配線する実装を完了した。正常・破壊fixture、空SQLite fileへの全適用、本番read-only schema検証を通過した。manual manifest、audit、verify、spec、testは未コミットのためremote CI反映とfresh cloneはcommit/push後に確認する。manifestは本番適用証明ではないため、production接続の判断は引き続きread-only schema検証に限る。

### changed detectionの受入条件

`execSync(string)`がshellをspawnしてsandboxでEPERMとなると、git取得失敗を黙殺して空のchanged setへfail-openし、dirty 23件でも`Changed files count: 0`、`needTest: false`、`needSmoke: false`となったことは、修正前の再現証跡である。現行は `execFileSync` の引数配列と比較不能時のfull test/smoke fallbackに置換済みであり、実module testはbase SHA不明、committed、tracked、staged、untracked、rename、git failureを対象にする。sandbox negativeでも比較不能時にtest/smokeをskipしないことを確認した。変更検出修正直後の実環境 `pnpm verify` はchanged files 40、`reliable: true`、`needTest: true`、`needSmoke: true`で全gateに成功している。その後のVite `.mts` 修正後の最新実行は49件であり、下記「最新検証」に記録する。現在の未完はコミットhandoffのみである。

## 計測・検証の記録

測定値と適用範囲は混同しない。詳細は `docs/measurements/refactoring-baseline-2026-09.md` を参照。

### Plan 18のKPIと測定条件

Plan 17のbaselineとは混同しない。Plan 18の比較は同一commit、同一マシン、同一worker数、同一commandで行い、cold/warmを各5回測定する。warm medianは**10.5秒以下**、P95は**15秒以下**を目標とする。CIも同じgate集合で比較する。coverageの単発実行はKPI系列に混ぜない。目標未達なら、速度を理由とする複雑化は採用しない。

| 対象                         | 実測結果                                                                                 | 判定                              |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| historical pilot             | 47 files / 578 pass / 1 skip、warm median 17.40s、P95 18.56s、cold 17.59s、RSS 424340 kB | 既存値を保持。cold x5は未実施     |
| audit testを除くcoverage実行 | 55 files / 610 pass / 1 skip / 17.65s、coverage tiers pass                               | 単発coverage。KPI系列には混ぜない |

過去の全test・coverage・smoke結果は当時の証跡であり、今回の未コミットsliceの受入証跡ではない。直接 `pnpm exec vitest` のVite warningと、過去の `pnpm test` policyでの抑止も区別する。

### 最新検証（2026-09-06）

軽量sliceの対象Vitestは3 files / 48 passed / 1 skipped、対象oxfmtは成功した。feed-cardが画像入力を`img`、`picture`、`figure`、`srcset`等として露出しないnegativeも維持している。

Git spawnをsandboxでEPERMにしたnegativeでは、実 `pnpm verify` が `Changed files count: 0`、`reliable: false`、`needTest: true`、`needSmoke: true`となり、test/smokeをskipしないことを確認した。変更検出修正直後の通常実環境ではchanged files 40、`reliable: true`、test/smoke実行となり、`pnpm verify` は全gate成功（58 files / 617 passed / 1 skipped、coverage tiers pass、production schema up-to-date）である。Vite `.mts` 修正後の最新実行（同じ実装契約）は49件であり、上記の未コミット軽量sliceに記録した。

Vite config-loader warningは `vitest.config.mts` 移行後に直接Vitestおよびverify（smoke/coverage含む）で再発しないことを確認した。devDependency high/critical advisory warningは別件non-blockingで残る。migration metadataの整合・local verify配線はPlan 24 Slice 1で受入済みであり、remote CI反映とfresh cloneはcommit/push後に確認する。unexpected stderr policyは採否判断済みである。AI計画の混入はない（prompt、schema、UI、topic仕様の変更なし）。

### 過去の補足検証（受入の代替にはしない）

- KPI反復測定: main作業ツリーは追跡変更7件でdirtyのため、HEAD `2c5559c` のclean worktree（`/tmp/opencode/wt-kpi-2c5559c`、後始末済み）で `pnpm test` をcold×5・warm×5。Node 24.19.0 / pnpm 11.9.0 / 4 cores。cold: 16.813 / 16.477 / 16.898 / 17.362 / 17.634s、warm: 16.667 / 17.765 / 18.075 / 18.791 / 17.648s。warm median 17.765s、P95 18.791s → 目標（10.5s以下 / 15s以下）**未達**。計画ルール「目標未達なら、速度を理由とする複雑化は採用しない」を適用し、CI並列化・DB分割の速度目的採用を見送る。
- CI wall-time計測（同一worktree・逐次・各1回）: lint 0.699s、type-check 8.818s、coverage（vitest 22.381s + tiers check 0.656s）、security 5.160s、smoke:contract 3.191s、smoke:http 23.883s、prod-schemaは `TURSO_DATABASE_URL` 未設定でskip、spec-refs 0.016s。`pnpm test` はKPI値（median 17.77s）を流用。合計約64.7s、全PASS。残作業順5の測定要件を満たし、採用判断は上記ルールにより不採用。
- zero-ref調査: 追跡コードのexport 9件（`computeCurationSignature`、`shadowEvaluateTopics`、`formatAbsoluteJa`、`FeedLaneClassic`、`EmptyState`、`curateSingle`、`getAllowlistedTosUrl`、`writeReadStatus`、`PublishedTime`）を全文検索で確認し、すべて参照あり。安全な削除候補なし（調査済み・削除なし）。
- junk整理: `exports.txt`（291行のexport名ダンプ、untracked）を削除。計時用worktreeは後始末済み。

## 法務不変条件のnegative test matrix

§10/§11の各確認はpositiveだけでは完了としない。未確認の行は未完である。

| 不変条件                                | spec節 | positive確認                      | negative確認                               | 証跡                                 |
| --------------------------------------- | ------ | --------------------------------- | ------------------------------------------ | ------------------------------------ |
| 記事本文・sliceを生成または永続化しない | §10    | 永続化対象が許可フィールドのみ    | 本文/slice投入を拒否または保存されないこと | unit/integration test、DB inspection |
| タイトルは逐語                          | §10    | 取得タイトルをそのまま表示・保存  | 書換え・要約タイトルを拒否すること         | golden set、render test              |
| 画像を表示しない                        | §10    | 記事表示に画像要素・画像URLがない | 画像入力がUI/永続化へ漏れないこと          | render test、DB inspection           |
| allowlistのみ取得する                   | §11    | 許可hostを取得する                | 非許可hostをfetch前に拒否する              | unit/integration test、fetch spy     |
| robots/ToSを守る                        | §11    | 許可された取得だけを続行          | robots/ToS不許可時に取得しない             | fixture、fetch spy                   |
| K1–K6                                   | §11    | 各制約を満たす入力を受理          | 各制約違反を個別に拒否する                 | constraint matrix test               |
| same-host=1                             | §11    | 異なるhostは必要時に進行          | 同一hostの同時fetchが2件にならない         | concurrency test、fetch trace        |
| rate limit/daily cap                    | §11    | 上限内を取得する                  | 上限超過時にfetchしない                    | clock fixture、counter trace         |

## rollback・停止条件

成果物はコミット単位でrevertする。法務negative test、golden set、fresh clone、CI required gateのいずれかが失敗した時点で、その成果物の作業を停止する。

- read-only gateは、誤検知または本番接続先の誤判定が起きた場合、gate導入コミットだけをrevertし、DBへの修復・書込みは行わない。
- host concurrencyとpipeline変更は、same-host=1、アクセス規律、rate limit/daily cap、またはgolden setを損ねた場合、それぞれの縦sliceコミットをrevertする。アクセス規律を緩めて継続しない。
- CI並列化は、同一gate集合を失う、required gateが欠ける、または測定効果が維持コストを下回る場合、workflow変更コミットをrevertする。

## 残作業の次手

Plan 18で追加の残作業は持たない。Plan 24を依存順どおり実施し、各sliceを独立に受入する。Slice 4ではretry時刻と空stage集計の局所的な共通化をlocal受入したが、golden set付きの責務分離は未完のままPlan 24で管理する。LLM全体のretry/chunk/fallback共通化は対象外のままとする。

## Definition of Done（縮小確定scope）

- [x] changed detectionをfail-safeへ修正し、実module test、sandbox negative、実環境full verifyで確認した。
- [x] body hash test移設のformatを解消し、対象test/formatを確認した。
- [x] 重い残件をPlan 24へ移管し、Plan 18と二重管理しない。
- [x] Plan 18-aiの変更を含めず、§10/§11の不変条件を維持した。
- [x] 本書とPlan 24に属する実装を必要な粒度でコミットした。Plan 24のremote CI確認はpush後のhandoffとして残す。
