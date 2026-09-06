# Refactoring Baseline Measurements — September 2026

Plan 18の測定は、比較対象・反復数・実行範囲を分けて記録する。単発値はKPI達成の根拠にしない。

## Historical pilot

- Commit: historical pilot (`025b01d` 時点の記録)
- Test result: 47 files / 578 passed / 1 skipped
- Warm x5: median 17.40s、P95 18.56s
- Cold: 17.59s、peak RSS 424340 kB
- Coverage: 80.48%

Coldは1回だけであり、cold x5は未完了である。従ってこの値は基準の保存であって、Plan 18の高速化KPIの確定値ではない。

## Current implementation observations

| Scope                                                     | Command/result                                                  | Interpretation                  |
| --------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- |
| 全working tree（未追跡scaffolding含む）                   | 54 files / 605 passed / 1 skipped / 17.43s、coverage tiers pass | 単発。比較KPIには使わない       |
| 今回コミット済みslice（scaffolding 10ファイルを一時除外） | 49 files / 588 passed / 1 skipped / 16.52s                      | 単発warm。5回未実施なので未判定 |
| audit testを除く最新coverage実行                          | 55 files / 610 passed / 1 skipped / 17.65s、tiers pass          | 単発coverage。KPI系列に含めない |

注記: 表中のscaffoldingには過去の未追跡試作を含む。`src/lib/db/port.ts` / `tests/db-port.test.ts` はPlan 24 Slice 3で非採用として削除済みであり、DbPortを現行productionで採用・配線していることを意味しない。過去の測定値は変更しない。

## Latest validation (2026-09-06)

- Coverage summary: statements 80.96%、branches 70.62%、functions 84.86%、lines 82.81%。全tier pass。
- `tests/audit-migration-metadata.test.ts` はsandboxのchild node EPERMによりcoverage実行から除外。権限付き単独実行は1 passだが、MISSING出力のみを期待しexit非0を要求しないため、migration fail gateの証明ではない。
- 実repoのmigration metadataはSQL 15件、snapshot全欠落、journalは`0003`以降欠落で、現行auditはMISSINGを表示してexit 0となる。
- 2026-09-06: tmp整理（`tmp-*.ts` 7件削除、`.sqlite/` はuntouched）、画像なしnegativeテスト追加（`tests/ui/feed-card.test.tsx` にpicture/figure/srcset非出現の1ケース追加、feed-card 16件通過、全テスト58 files/616 pass/1 skip、17.32s）、dead env除去後のVite warning新証拠確認・記録、各ゲート（lint, tsc, coverage tiers T1 98.53/T2 89.02/T3 78.95, security dev advisory non-block, smoke:contract 2件, smoke:http, spec-refs）通過を確認。
- Turbopack HTTP smokeはGoogle Fonts network制約後、権限付きでもsandbox port bind panicとなり判定不能。middleware deprecationおよびEdge warningは既知警告。
- `pnpm verify` は未コミット変更があるのにChanged files count 0となりtest/smokeをskipした。changed detectionは未完。
- 2026-09-06: runtime scaffoldingの専用testを非採用削除した結果、passed数は617 → 611 → 608 → 605となった（clock/stages 6件、runtime config 3件、DbPort 3件）。最新の `pnpm verify` はChanged files 41、reliable true、test/smoke実行で全gate成功（54 files / 605 passed / 1 skipped、coverage tiers全pass、production schema up-to-date、Vite warningなし）。devDependency advisoryは別件non-blocking。

## committed-slice cold x5 (2026-09-05, revert後・有効データ)

- Runs wall: 18.42 / 19.33 / 19.77 / 19.50 / 20.30s (all exit 0, 51 files / 593 passed / 1 skipped)
- Median: 19.50s, P95 (max of 5): 20.30s
- Note: prior cold x5 attempt invalidated by ingest→port wiring breakage (2 files failed all 5 runs); this set is post-revert valid. Prior cold single (17.59s) was full-tree pilot, not comparable.

## committed-slice warm x5 (2026-09-05, scaffolding除外・復元済)

- Runs wall: 14.91 / 15.10 / 16.59 / 17.66 / 18.27s (all exit 0, 49 files / 588 passed / 1 skipped)
- Median: 16.59s, P95 (max of 5): 18.27s
- Baseline (historical pilot): median 17.40s → improvement (17.40 - 16.59) / 17.40 = 4.66%
- Judgment (honest, per plan stop rule): 5%閾値未達のため高速化KPIは未判定のまま。注記: 14.9→18.3への上昇ドリフトあり（マシン負荷ノイズの可能性）、cold x5・CI時間は未実施のまま残件とする。

`pnpm verify` はuncommitted changed countが0の際にtest/smokeをskipする。したがって上記の証拠には採用せず、明示的な全test、coverage、smokeを実行した結果だけを記録する。

## Remaining protocol

同一commit・同一マシン・同一worker数でcold/warmを各5回以上、`/usr/bin/time -v pnpm exec vitest run --reporter=dot` 等でコマンド全体を測る。P95は5回なら最大値とする。coverageは最低1回実行し、CIは同一gate集合でjob別の完走時間を比較する。

Plan 18の目標（warm中央値10.5s以下、P95 15s以下）は、上記反復測定まで**未判定**である。

## destructive confirmations (2026-09-05)

- K6 429 (`access-discipline.ts:358` neutered → `if (false && ...)`): `tests/access-discipline.test.ts` broken 1 failed / 38 passed (39), restored 39/39 pass. Note: first attempt targeted the WRONG file (`discovery-ingest.test.ts`, stayed 44 green) — lesson: K6 proving test lives in `tests/access-discipline.test.ts:288-309`.
- K7 lease lock (`cooldown.ts:160` → `return true`): `tests/cooldown.test.ts` broken 4 failed / 19 passed (23), restored 23/23 pass. Note: first attempt targeted `pipeline-ingest.test.ts` (19/19 green, no contention coverage, no cooldown mock) — lesson recorded.
- K3 401/451 (`access-discipline.ts:306` neutered): `tests/discovery-ingest.test.ts` broken 1 failed / 43 passed / 1 skipped, restored 44/1 pass.
- All three: post-restore `git diff` on touched sources clean. Earlier proven: topics-slice (break 1failed / restore 2passed), 過去のDbPort試作のboundary (break 1failed / restore 3passed), schema-guard exits (1/0/1)。DbPort試作はPlan 24 Slice 3で非採用削除済みであり、現行採用の証跡ではない。

## HEAD worktree KPI x10 + CI wall-time (2026-09-07)

- Method: main作業ツリーは追跡変更7件でdirtyのため、HEAD `2c5559c` のclean worktreeで測定（後始末済み）。同一マシン・同一command（`pnpm test`）・cold/warm各5回。Node 24.19.0 / pnpm 11.9.0 / 4 cores。coverage実行はKPI系列に混ぜない。
- Cold x5 wall: 16.813 / 16.477 / 16.898 / 17.362 / 17.634s (all exit 0)
- Warm x5 wall: 16.667 / 17.765 / 18.075 / 18.791 / 17.648s (all exit 0)
- Median (warm): 17.765s, P95 (max of 5): 18.791s → 目標（10.5s以下 / 15s以下）**未達**。速度理由の複雑化（CI並列化・DB分割の速度目的採用）は不採用。
- CI wall-time（同一worktree・逐次・各1回、全PASS）: lint 0.699s、type-check 8.818s、coverage vitest 22.381s + tiers check 0.656s、security 5.160s、smoke:contract 3.191s、smoke:http 23.883s、prod-schema skip（URL未設定）、spec-refs 0.016s。合計約64.7s（`pnpm test` はKPI median 17.77sを流用）。
- zero-ref調査: 追跡コードのexport 9件を全文検索で確認し、すべて参照あり。安全な削除候補なし。
- Junk: `exports.txt`（291行ダンプ、untracked）を削除。
