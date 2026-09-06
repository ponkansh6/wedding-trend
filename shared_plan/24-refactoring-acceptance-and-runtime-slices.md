# 24. Refactoring Acceptance and Runtime Slices

- 対象: `wedding-trend` の未受入リファクタリング残件
- 作成日: 2026-09-06
- State: **一部進行中**
- 移管元: [Plan 18](./18-refactoring-simplification-and-efficiency.md)

## 背景と境界

Plan 18で軽量なverify fail-safe、test移設、format解消は対象受入した。一方、以下は設計判断、本番実行経路への配線、履歴整合、fresh cloneまたは反復計測を要し、軽量修正として混在させると受入根拠が曖昧になる。そのため本Plan 24で独立した縦sliceとして扱う。

不変条件は `openspec/specs/wedding-trend/spec.md` §10 / §11である。記事本文の生成・永続化をしないこと、逐語タイトル、allowlist、robots/ToS、same-host=1、rate limit/daily capを緩めない。法務、DB、アクセス契約を変更する場合は、実装と同じ変更でspecを同期する。

## 非目標

- LLM汎用batcher化（retry/chunk/fallback実行制御の共通化）。
- migrationの自動修復、squash、DB書込み。
- 計測なしのCI並列化またはhost concurrency導入。
- 行数だけを根拠とするpipeline分割。

## 依存順

1. migration metadataとverify/CI gateの信頼性
2. stderr/Vite policy
3. scaffolding採否
4. pipeline責務分離
5. host concurrency採否
6. CI並列化とKPI

後続sliceは先行sliceのrequired gateを弱めず、同一gate集合を維持する。

## Slice 1: migration metadataとfail gate統合

**開始条件:** read-only auditが正常/欠落fixtureを判定でき、既存15 migrationの状態を破壊せず観測できること。

**成果物:** snapshot/journalを既存15 migrationと整合させる変更、`scripts/gates/audit-migration-metadata.mjs` のverify/CI配線、正常・欠落negative、fresh cloneとread-only production検証の証跡。

**Acceptance:** metadataが実repoで整合し、欠落fixtureはexit 1、正常fixtureはexit 0。`pnpm verify` とCIの該当gateでauditが実行される。production接続はread-onlyで、`file:` を本番成功として扱わない。

**STOP / rollback:** metadataの来歴が確定できない、DB書込みが必要になる、または本番接続先を誤判定した時点で停止する。gate導入またはmetadata変更の独立コミットをrevertし、修復・squashは別承認作業へ分離する。

## Slice 2: Vite warningとstderr policy

**進捗（2026-09-06）:** Vitest設定を `vitest.config.ts` から明示ESM拡張子の `vitest.config.mts` へ移行し、aliasの `__dirname` は `import.meta.dirname` へ置換した。`package.json` の `type: module` 変更およびwarning抑止環境変数は用いていない。直接 `pnpm exec vitest run tests/console-monitor.test.ts` はwarningなしで 1 file / 4 tests 成功し、実環境の `pnpm verify`（Changed files 49、reliable true、test/smoke実行）でもVite warningはsmoke/coverageを含めて出力されず、全gateが成功した。この根治部分は完了とする。

**開始条件:** ~~direct VitestでVite config-loader warningが再現可能で、既存gateのstderrを把握できること。~~ Vite config-loader warningの再現・根治確認は完了した。残るstderr policyについて、既存gateのstderrを把握できること。

**成果物:** warningの根治、または根拠・適用範囲・期限を持つstderr許容/検出方針。`tests/console-monitor.ts` と `tests/console-monitor.test.ts` の採否および必要な経路への配線。unexpected stderr negative。

**Acceptance:** unexpected stderrが検出されてgateを落とすnegativeがある。許容する場合は対象メッセージが最小範囲で明文化され、直接VitestとCIで同じ方針が適用される。

**残課題:** `tests/console-monitor.ts` / `tests/console-monitor.test.ts` のunit 4件成功は、process stderrをgateで監視する証拠ではない。monitorの採否と必要経路への配線、unexpected stderr negative、許容範囲の統一方針は未着手であり、Slice 2全体は未完とする。

**STOP / rollback:** warning隠し、広範な正規表現許容、またはrequired gateのログ欠落が必要になれば停止する。policy/monitor導入コミットをrevertする。

## Slice 3: runtime scaffoldingの採否

**進捗（2026-09-06）:** `src/lib/time/clock.ts` / `tests/clock.test.ts`、`src/lib/pipeline/stages.ts` / `tests/pipeline-stages.test.ts`、`src/lib/config/runtime.ts` / `tests/config-runtime.test.ts`、`src/lib/db/port.ts` / `tests/db-port.test.ts` を非採用として削除した。いずれも未追跡で、各専用test以外から参照されず、production挙動およびspec契約は変更していないためspec更新は不要である。runtime scaffoldingは既存constantsおよびproduction configと重複し、`WEDDING_TREND_*` 環境変数はproductionで未使用である。DbPortは約50の既存関数を束ねるだけでproduction境界になっておらず、採用には全DBのDI設計を要するため本sliceの軽量な目的に適合しない。`src/lib/sources/host-concurrency.ts` / `tests/host-concurrency.test.ts` は導入可否とアクセス規律の評価を要するためSlice 5で扱う。

専用testの削除により全体テスト数は617 → 611 → 608 → 605 passedとなった（clock/stagesの6件、runtime configの3件、DbPortの3件）。削除対象はいずれも未使用足場だけを検証するtestである。実環境 `pnpm verify` は Changed files 41、reliable true、test/smoke実行で全gateに成功（54 files / 605 passed / 1 skipped、coverage tiers全pass、production schema up-to-date、Vite warningなし）。devDependency advisoryはnon-blockingの別件である。以上によりSlice 3を完了とする。

**開始条件:** 各抽象化について実経路のuse caseと、複雑性またはテスト境界の改善根拠を示せること。

**成果物:** 採用する場合はproduction経路への最小配線、unit/integration、fresh clone証跡。根拠がない場合はscaffoldingと専用testの削除判断。

**Acceptance:** untrackedまたは未配線の抽象化を残さない。採用分は実production経路を通るintegrationで検証し、削除分は参照なしを確認する。

**STOP / rollback:** 法務、DB、アクセス契約への影響が不明、または抽象化が呼出し側を複雑化するなら停止する。独立sliceコミットをrevertする。

## Slice 4: pipeline責務分離

**開始条件:** `discovery-ingest.ts` / `run-pipeline.ts` の境界ごとに実経路use caseとgolden setを定義できること。

**成果物:** 挙動不変の責務分離、golden set、unit/integration、fresh clone実行証跡。

**Acceptance:** golden setで出力・永続化・fetch順序の契約を維持し、§10/§11のnegativeを通す。分割後に依存方向とテスト境界が単純化していることをレビューで示す。

**STOP / rollback:** golden set、法務negative、access discipline、fresh cloneのいずれかが失敗したら停止し、その縦sliceだけをrevertする。

## Slice 5: host concurrencyの採否

**開始条件:** host待ちが実測上のボトルネックであり、導入しない選択とも比較できること。

**成果物:** 採用時は最小実装、fetch trace、concurrency test、access discipline negative。非採用時は測定と判断記録。

**Acceptance:** 採用時もsame-host=1を保ち、fetch前allowlist/robots/ToS、rate limit/daily capを維持する。非採用でも測定根拠と再評価条件を残す。

**STOP / rollback:** 同一hostで2件同時fetch、robots/ToS違反、rate/daily cap超過のいずれかで即停止し、導入コミットをrevertする。アクセス規律を緩めて継続しない。

## Slice 6: CI job並列化とKPI

**開始条件:** 同一commit・同一マシン・同一worker数・同一commandでcold/warm各5回を取得できること。

**成果物:** cold/warm各5回のwall time、P95、CI queue/startup cost、同一gate集合での比較記録と採否判断。

**Acceptance:** 並列化する場合、required gateとcoverage/security/smoke/spec refsを欠かさず、wall time短縮がqueue/startup・保守コストを上回る。採用しない場合も測定と判断を記録する。

**STOP / rollback:** gate集合が変わる、required gateが欠ける、または測定効果が維持コストを下回る場合はworkflow変更をrevertする。Plan 17の統合済み3レーンを再統合しない。

## Definition of Done

- [ ] Slice 1のmetadata整合、audit配線、negative、fresh clone/read-only production検証を完了する。
- [ ] Slice 2のstderr policyとunexpected stderr negativeを受入する。
- [x] Slice 3のclock、stages、runtime config、DB portを非採用削除まで完了し、host concurrencyはSlice 5へ引き渡した。
- [ ] Slice 4のgolden set付き責務分離を受入する。
- [ ] Slice 5のhost concurrency採否をアクセス規律のnegativeとともに確定する。
- [ ] Slice 6でcold/warm各5回とCI比較を行い、採否を記録する。
- [ ] 変更が法務、DB、アクセス契約に触れる場合、spec同期とrequired gate成功を確認する。
