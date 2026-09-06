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

**local/fresh clone受入完了・remote CI handoff未完（2026-09-06）:** Git履歴により、`0000`–`0002` はDrizzle管理、`0003`–`0014` は手動のadditive migrationと確定した。推測によるsnapshot後付けはせず、手動tailは `manual-migrations.json` にSHA-256と理由を記録する方式とした。

`scripts/gates/audit-migration-metadata.mjs` は全SQLをmanaged/manualの排他的分類で監査し、managed側のjournal/snapshot、manual側のhash、unknown/duplicate/orphan/gap/misname/malformed、managed上限`0002`をfail-closedで検出する。`--root` によりcwd非依存とし、verifyのadditive gate直後へ配線した。正常および意図的破壊を含む17テストは成功している。実装は `1652351` でコミット済みである。

実repoではmanaged 3件、manual 12件として監査が成功した。空の一時SQLite fileへ`0000`–`0014`をfresh適用でき、本番は元worktreeのread-only schema検証でup-to-dateを確認した。local HEADから作成したclean fresh cloneでは、`pnpm install --frozen-lockfile --offline`、static gates、audit、typecheck、明示smoke 2件、全coverage（53 files / 615 passed / 1 skipped、tiers全pass、Tier 3 79.10%）が成功した。fresh cloneには`.env.local`を置かないため、本番read-only検証はそこで実施していない。manifestはmigration適用履歴の説明であり、本番へ適用済みであることの証明ではない。

**Acceptance:** metadataが実repoで整合し、欠落fixtureはexit 1、正常fixtureはexit 0。localの`pnpm verify` でauditが実行される。production接続はread-onlyで、`file:` を本番成功として扱わない。localおよびfresh cloneの受入を完了した。remote CIはpush未実施で、`gh`認証無効・network不通のため未確認である。

**STOP / rollback:** metadataの来歴が確定できない、DB書込みが必要になる、または本番接続先を誤判定した時点で停止する。gate導入またはmetadata変更の独立コミットをrevertし、修復・squashは別承認作業へ分離する。

## Slice 2: Vite warningとstderr policy

**判断・進捗（2026-09-06）:** Vitest設定を `vitest.config.ts` から明示ESM拡張子の `vitest.config.mts` へ移行し、aliasの `__dirname` は `import.meta.dirname` へ置換した。`package.json` の `type: module` 変更およびwarning抑止環境変数は用いていない。最新の直接Vitestと `pnpm verify`（Changed files 36、reliable true、test/smoke実行）でVite config-loader warningは出力されず、全gateが成功した。

未追跡の `tests/console-monitor.ts` / `tests/console-monitor.test.ts` はconsole spyによるunit helperであり、process stderr gateではなく、production・verify・CIからも未参照だったため非採用として削除した。包括的なprocess stderr fail gateは、既存gateが意図的に出すstderr、誤検知を避けるallowlistの肥大、失敗時ログ欠落のリスクに対し、現時点で安全かつ最小の品質契約を定義できないため非採用とする。unexpected stderr negativeを実装・受入したものではない。

**Acceptance（採否判断）:** Vite config-loader warningを抑止なしで根治し、console monitorと包括stderr gateを採用しない理由・境界・再評価条件を記録する。

**再評価条件:** CIでstderr品質契約が必要になり、全gate出力の分類とprocess単位のnegativeを、allowlist肥大やログ欠落なしに実装できるようになった時点で別sliceとして再評価する。

**STOP / rollback:** warning隠し、広範な正規表現許容、またはrequired gateのログ欠落が必要になれば停止する。policy/monitor導入コミットをrevertする。

## Slice 3: runtime scaffoldingの採否

**進捗（2026-09-06）:** `src/lib/time/clock.ts` / `tests/clock.test.ts`、`src/lib/pipeline/stages.ts` / `tests/pipeline-stages.test.ts`、`src/lib/config/runtime.ts` / `tests/config-runtime.test.ts`、`src/lib/db/port.ts` / `tests/db-port.test.ts` を非採用として削除した。いずれも未追跡で、各専用test以外から参照されず、production挙動およびspec契約は変更していないためspec更新は不要である。runtime scaffoldingは既存constantsおよびproduction configと重複し、`WEDDING_TREND_*` 環境変数はproductionで未使用である。DbPortは約50の既存関数を束ねるだけでproduction境界になっておらず、採用には全DBのDI設計を要するため本sliceの軽量な目的に適合しない。`src/lib/sources/host-concurrency.ts` / `tests/host-concurrency.test.ts` は導入可否とアクセス規律の評価を要するためSlice 5で扱う。

専用testの削除により全体テスト数は617 → 611 → 608 → 605 passedとなった（clock/stagesの6件、runtime configの3件、DbPortの3件）。削除対象はいずれも未使用足場だけを検証するtestである。実環境 `pnpm verify` は Changed files 41、reliable true、test/smoke実行で全gateに成功（54 files / 605 passed / 1 skipped、coverage tiers全pass、production schema up-to-date、Vite warningなし）。devDependency advisoryはnon-blockingの別件である。以上によりSlice 3を完了とする。

**開始条件:** 各抽象化について実経路のuse caseと、複雑性またはテスト境界の改善根拠を示せること。

**成果物:** 採用する場合はproduction経路への最小配線、unit/integration、fresh clone証跡。根拠がない場合はscaffoldingと専用testの削除判断。

**Acceptance:** untrackedまたは未配線の抽象化を残さない。採用分は実production経路を通るintegrationで検証し、削除分は参照なしを確認する。

**STOP / rollback:** 法務、DB、アクセス契約への影響が不明、または抽象化が呼出し側を複雑化するなら停止する。独立sliceコミットをrevertする。

## Slice 4: pipeline責務分離

**軽量な境界整理（2026-09-06）:** `addHoursIso()` を `src/lib/pipeline/retry-time.ts` へ純粋関数として移し、`run-pipeline.ts` と `discovery-ingest.ts` の retry/TTL期限計算で共用した。UTC ISO、TTL、backoff、無効日時の `RangeError` は不変である。backoff は custom対応と固定値で意味が異なるため統合しない。さらに `run-pipeline.ts` の `emptyStageCounts()` により、正常・失敗時で同一形状かつ呼び出しごとに独立した `stageCounts` / `dropped` を返すよう整理した。値・順序・DB/fetch/LLM・法務条件は不変であり、`tests/pipeline/retry-time.test.ts` のcharacterizationと公開経由testで固定した。対象4 filesは68 passed / 1 skipped。

この2件は局所的な重複除去であり、pipeline全体の責務分離、golden setを置き換えない。Slice 4全体は未完のままとする。実装は `4b918e5` でコミット済みであり、clean fresh cloneでも全coverage（53 files / 615 passed / 1 skipped、tiers全pass）まで再現した。テスト数の増加はmigration audit testの拡充とretry-time / summaryのcharacterization追加によるものであり、KPIの再計測値ではない。

**開始条件:** `discovery-ingest.ts` / `run-pipeline.ts` の境界ごとに実経路use caseとgolden setを定義できること。

**成果物:** 挙動不変の責務分離、golden set、unit/integration、fresh clone実行証跡。

**Acceptance:** golden setで出力・永続化・fetch順序の契約を維持し、§10/§11のnegativeを通す。分割後に依存方向とテスト境界が単純化していることをレビューで示す。

**STOP / rollback:** golden set、法務negative、access discipline、fresh cloneのいずれかが失敗したら停止し、その縦sliceだけをrevertする。

## Slice 5: host concurrencyの採否

**判断・進捗（2026-09-06）:** 未追跡の `src/lib/sources/host-concurrency.ts` / `tests/host-concurrency.test.ts` はproduction未参照で、性能測定・fetch traceの根拠もなかったため非採用として削除した。現行のaccess disciplineはsame-host=1、host間隔、allowlist、robots/ToS、rate limit/daily capを既に担保しており、未配線helperを残す根拠はない。production/spec挙動は変更していない。

**Acceptance（採否判断）:** 未配線helperと専用testを残さず、非採用の根拠と再評価条件を記録する。導入実装やconcurrency negativeを完了したものではない。

**再評価条件:** host待ちが実測で有意なボトルネックとなった時点で別sliceとして扱う。採用する場合はspec §11を同じ変更で同期し、same-host=1、fetch前allowlist/robots/ToS、rate limit/daily capのnegativeとfetch traceを必須とする。

**STOP / rollback:** 同一hostで2件同時fetch、robots/ToS違反、rate/daily cap超過のいずれかで即停止し、導入コミットをrevertする。アクセス規律を緩めて継続しない。

## Slice 6: CI job並列化とKPI

**完了（採否判断、2026-09-06）:** 同一commit・同一マシン・同一worker数・同一commandでcold/warm各5回を取得した。warm medianは17.765秒、P95は18.791秒で、目標（10.5秒以下／15秒以下）を満たさない。CI gate相当の逐次実行は約64.7秒だった。

GitHub remote CIのsuccessful main runsを5回取得してqueue/startupを比較する試行は、`gh` の認証token無効とnetwork errorのため完了できなかった。workflowは変更していない。setup重複とqueue costを裏付ける証拠がないため、CI並列化は現時点で非採用とする。

**Acceptance:** 採用しない場合も測定と判断を記録する。ローカル反復測定とCI gate相当の実測を記録し、証拠なき並列化を採用しない判断を完了した。required gateの削減は行わない。

**再評価条件:** GitHub認証とnetworkが復旧後、同一gate集合のsuccessful main runsを最低5件取得し、queue/startup/job wallの中央値・P95を測る。分割による改善がstartup重複を上回る場合だけ、別sliceで採用を検討する。

**STOP / rollback:** gate集合が変わる、required gateが欠ける、または測定効果が維持コストを下回る場合はworkflow変更をrevertする。Plan 17の統合済み3レーンを再統合しない。

## Definition of Done

- [x] Slice 1のmetadata整合、audit配線、negative、空SQLite file適用、read-only production検証、およびclean fresh clone検証を完了した。remote CIはpush後に確認する。
- [x] Slice 2のVite warning根治とconsole monitor / 包括stderr gateの非採用判断を完了し、再評価条件を記録した。
- [x] Slice 3のclock、stages、runtime config、DB portを非採用削除まで完了し、host concurrencyはSlice 5へ引き渡した。
- [ ] Slice 4のgolden set付き責務分離を受入する。
- [x] Slice 5の未配線host concurrencyを非採用として削除し、再評価時の§11同期・negative要件を記録した。
- [x] Slice 6でcold/warm各5回とCI gate相当の比較を行い、証拠なき並列化を非採用と記録した。
- [ ] 変更が法務、DB、アクセス契約に触れる場合、spec同期とrequired gate成功を確認する。

**Git handoff:** `[x]` はlocal implementation acceptanceを表す。Slice 1は `1652351`、Slice 4の軽量境界整理は `4b918e5` にコミット済みで、clean fresh cloneも確認済みである。push後のremote CI確認だけをhandoffとして残す。
