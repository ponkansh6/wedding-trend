# 18. リファクタリング計画 — シンプル化、テスト高速化、実行効率化

- 対象: `wedding-trend` 全体
- 作成日: 2026-09-05
- State: **一部進行中 (2026-09-06)** — 本書のチェックは実装済みの狭いsliceだけを表し、Plan 18完了を意味しない。
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

### 完了した狭い成果物

- [x] production schema target guard: `file:` はnegative確認でexit 1、本番 `libsql:` はread-only検査でup-to-dateを確認。ローカルSQLiteを本番成功と誤認しない。
- [x] Vite config-loader warningの抑止方針: `pnpm test` のpolicy経路で抑止する。直接の `pnpm exec vitest` ではwarningが残るため、根本解消ではない。
- [x] CIの `fetch-depth: 0`。
- [x] migration metadataのread-only report tool。検出を報告するだけでfail gateではなく、修復・squash・書込みはしない。
- [x] batch実経路のfence除去→JSON parse→Zod検証、raw応答をログへ出さないnegative test、および仕様同期。retry/chunk/error処理全体の共通化は未完。
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
- [ ] typed config、clock、DB port、stage型、host concurrencyを実行経路へ配線。（配線原則: trackedファイルはuntracked scaffoldingに依存させない。committed slice/CI fresh cloneが壊れる。ingest.ts→port.tsで実証済み・revert済み。配線はscaffoldingのcommit判断後に実施）
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

さらに、未完のためコミットから除外したものは `tests/audit-migration-metadata.test.ts`、`tests/console-monitor.ts`、`tests/console-monitor.test.ts` である。これらおよび未追跡scaffoldingは検証済みの完了成果物ではない。

## 計測・検証の記録

測定値と適用範囲は混同しない。詳細は `docs/measurements/refactoring-baseline-2026-09.md` を参照。

| 対象                         | 実測結果                                                                                 | 判定                              |
| ---------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| historical pilot             | 47 files / 578 pass / 1 skip、warm median 17.40s、P95 18.56s、cold 17.59s、RSS 424340 kB | 既存値を保持。cold x5は未実施     |
| audit testを除くcoverage実行 | 55 files / 610 pass / 1 skip / 17.65s、coverage tiers pass                               | 単発coverage。KPI系列には混ぜない |

`pnpm verify` はuncommitted changed countが0のときtest/smokeをskipするため、この進捗の証拠には使用しない。明示的な全test、coverage、smokeを実行して確認した。直接 `pnpm exec vitest` のVite warningと、`pnpm test` policyでの抑止も区別する。

### 最新検証（2026-09-06）

audit testを除くcoverage実行は55 files / 610 pass / 1 skip / 17.65s、coverage summaryはstatements 80.96%、branches 70.62%、functions 84.86%、lines 82.81%で、coverage tiersは全てpassした。17.65sはcoverage単発の測定であり、KPI系列には使用しない。

migration audit testはsandbox内のchild nodeがEPERMとなり、権限付き単独実行では1 passした。しかし実repo（SQL 15件、snapshot全欠落、journalは`0003`以降欠落）に対してMISSINGを表示するだけでexit 0であり、fail gateまたはnegative testの証明にはならない。

static/type/security/format/spec refs/contract smokeは成功した。本番Turso schemaはread-onlyでup-to-date。webpack production buildも成功し、ローカルの `/` と `/api/health` はHTTP 200だった。Turbopack HTTP smokeはGoogle Fontsのnetwork制約後、権限付きでもsandboxのport bind panicとなり判定不能である。middleware deprecationとEdge warningは既知警告として扱う。

`pnpm verify` は未コミット変更があるにもかかわらずChanged files countが0となりtest/smokeをskipしたため、changed detectionは未完である。AI計画の混入はない（prompt、schema、UI、topic仕様の変更なし）。以上からmigration fail gate、実経路配線、CI、KPIおよびDefinition of Doneは未完のままである。

## 最小の残作業順

1. migration auditをfail-closed化し、fixtureによるexit非0のnegative testを追加する。
2. changed detectionを安全側へ修正し、未コミット変更のnegative testを追加する。
3. 既存scaffoldingを縦に配線するか、別途判断して除去する。
4. `batch.ts` のretry/chunk/error処理を共通化する。
5. pipeline orchestratorを段階接続へ縮小し、CIを並列化する。
6. host別並列化をaccess disciplineを保ったまま実配線する。
7. cold/CIとwarmの比較可能な反復測定を完了し、DoDを判定する。

## Definition of Done

- [ ] 反復測定でテスト高速化KPIを判定済み。
- [ ] 全不変条件に成功/意図的破壊の対がある。
- [ ] unexpected stderr policyとCI並列/base SHA negativeが実装済み。
- [ ] config/clock/DB port/stage/host concurrencyが実経路に配線済み。
- [ ] LLM batch、pipeline縮小、host並列、削除台帳の実削除が完了。
- [ ] migration auditがfail gateとしてnegative test済み。
- [ ] lint、type-check、全test、coverage tiers、spec refs、security、smoke、read-only production schemaの該当gateを明示実行している。
- [x] spec更新は `e03b4ff` に記録し、§10/§11の不変条件を維持した。
