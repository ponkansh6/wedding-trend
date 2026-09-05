# 18. リファクタリング計画 — シンプル化、テスト高速化、実行効率化

- 対象: `wedding-trend` 全体
- 作成日: 2026-09-05
- State: **一部進行中 (2026-09-05)** — 本書のチェックは実装済みの狭いsliceだけを表し、Plan 18完了を意味しない。
- 不変条件: `openspec/specs/wedding-trend/spec.md` §10 / §11。記事本文の非生成・非永続化、逐語タイトル、アクセス規律、fail-closedを変更しない。

## 今回の実装範囲

実装対象rangeは `958ac8b..e03b4ff`（起点を含む8コミット）である。

1. `958ac8b` `fix(gates): fail closed for production schema checks`
2. `4244399` `test: standardize Vite config warning policy`
3. `76025c4` `ci: retain full history for change detection`
4. `168c62a` `feat(gates): add read-only migration metadata audit`
5. `d4b0849` `refactor(llm): centralize JSON parsing and error classification`
6. `f1591e5` `refactor(pipeline): extract hashing and URL deduplication helpers`
7. `01ada4a` `test(legal): guard against topic slice persistence`
8. `e03b4ff` `docs(spec): define production schema verification contract`

### 完了した狭い成果物

- [x] production schema target guard: `file:` はnegative確認でexit 1、本番 `libsql:` はread-only検査でup-to-dateを確認。ローカルSQLiteを本番成功と誤認しない。
- [x] Vite config-loader warningの抑止方針: `pnpm test` のpolicy経路で抑止する。直接の `pnpm exec vitest` ではwarningが残るため、根本解消ではない。
- [x] CIの `fetch-depth: 0`。
- [x] migration metadataのread-only report tool。検出を報告するだけでfail gateではなく、修復・squash・書込みはしない。
- [x] LLMのJSON parse/error分類の共通化を、`topics-batch` とpipelineの実利用箇所へ適用。
- [x] body hashとURL dedupeの抽出。
- [x] topics sliceの非永続化に対する法務回帰テスト。
- [x] production schema検証契約のspec同期（`e03b4ff`）。

### AI計画との境界

`topics-batch` のparse共通化とtopics slice leak testは、既存処理の重複削減と§10/§11の法務安全網である。prompt、schema、UI、topic仕様は変更していない。従ってPlan 18-aiの再実施ではない。

## 未完了・部分成果

- [ ] cold/warm各5回のKPIとCI時間の反復計測。
- [ ] 全不変条件の意図的破壊によるnegative確認。
- [ ] unexpected stderrの検出・失敗化（現状は既知Vite warningのpolicyのみ）。
- [ ] DB巨大テストのfixture境界分割。
- [ ] CI job並列化、base SHA changed detectionとそのnegative test。
- [ ] typed config、clock、DB port、stage型、host concurrencyを実行経路へ配線。
- [ ] `src/lib/llm/batch.ts` 全体のretry/chunk/parse/error共通化。
- [ ] `discovery-ingest.ts` / `run-pipeline.ts` のorchestrator縮小。
- [ ] host別bounded concurrencyの実経路配線（same-host=1とfetch前規律のnegative testを含む）。
- [ ] 参照数0を根拠にした実コード削除。
- [ ] migration metadata auditのfail gate化とnegative test。

未配線scaffoldingは未追跡であり、本コミットの対象外として維持する。実ファイルは次の10件である。

- `src/lib/config/runtime.ts`
- `src/lib/time/clock.ts`
- `src/lib/db/port.ts`
- `src/lib/pipeline/stages.ts`
- `src/lib/sources/host-concurrency.ts`
- `tests/config-runtime.test.ts`
- `tests/clock.test.ts`
- `tests/db-port.test.ts`
- `tests/pipeline-stages.test.ts`
- `tests/host-concurrency.test.ts`

これらは現在、実行経路に配線されておらず、削除指示でも完了成果物でもない。

## 計測・検証の記録

測定値と適用範囲は混同しない。詳細は `docs/measurements/refactoring-baseline-2026-09.md` を参照。

| 対象                                                      | 実測結果                                                                                 | 判定                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| historical pilot                                          | 47 files / 578 pass / 1 skip、warm median 17.40s、P95 18.56s、cold 17.59s、RSS 424340 kB | 既存値を保持。cold x5は未実施      |
| 全working tree（scaffolding含む）                         | 54 files / 605 pass / 1 skip / 17.43s、coverage tiers pass                               | 単発。KPI証跡ではない              |
| 今回コミット済みslice（scaffolding 10ファイルを一時除外） | 49 files / 588 pass / 1 skip / 16.52s                                                    | 単発warm。5回未実施のためKPI未判定 |

`pnpm verify` はuncommitted changed countが0のときtest/smokeをskipするため、この進捗の証拠には使用しない。明示的な全test、coverage、smokeを実行して確認した。直接 `pnpm exec vitest` のVite warningと、`pnpm test` policyでの抑止も区別する。

## 最小の残作業順

1. migration auditをfail化し、fixtureによるnegative testを追加する。
2. 既存scaffoldingを縦に配線するか、別途判断して除去する。
3. `batch.ts` 全体へLLM共通化を広げる。
4. pipeline orchestratorを段階接続へ縮小する。
5. CI並列化とchanged detectionの安全側動作を実装する。
6. host別並列化をaccess disciplineを保ったまま実配線する。
7. cold/warm各5回を測定し、DoDを判定する。

## Definition of Done

- [ ] 反復測定でテスト高速化KPIを判定済み。
- [ ] 全不変条件に成功/意図的破壊の対がある。
- [ ] unexpected stderr policyとCI並列/base SHA negativeが実装済み。
- [ ] config/clock/DB port/stage/host concurrencyが実経路に配線済み。
- [ ] LLM batch、pipeline縮小、host並列、削除台帳の実削除が完了。
- [ ] migration auditがfail gateとしてnegative test済み。
- [ ] lint、type-check、全test、coverage tiers、spec refs、security、smoke、read-only production schemaの該当gateを明示実行している。
- [x] spec更新は `e03b4ff` に記録し、§10/§11の不変条件を維持した。
