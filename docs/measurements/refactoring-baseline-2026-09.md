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

`pnpm verify` はuncommitted changed countが0の際にtest/smokeをskipする。したがって上記の証拠には採用せず、明示的な全test、coverage、smokeを実行した結果だけを記録する。

## Remaining protocol

同一commit・同一マシン・同一worker数でcold/warmを各5回以上、`/usr/bin/time -v pnpm exec vitest run --reporter=dot` 等でコマンド全体を測る。P95は5回なら最大値とする。coverageは最低1回実行し、CIは同一gate集合でjob別の完走時間を比較する。

Plan 18の目標（warm中央値10.5s以下、P95 15s以下）は、上記反復測定まで**未判定**である。
