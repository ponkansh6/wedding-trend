# 25. Pipeline Publication Integrity

- 対象: discovery pipeline の公開永続化と失敗分類
- 作成日: 2026-09-06
- 状態: **未着手（高優先）**
- 前提: Plan 24 Slice 4。法務制約は `openspec/specs/wedding-trend/spec.md` §10 / §11。

## 背景

現在の公開処理は post upsert、curation 記録、publication 記録、discovery 状態更新を複数の DB 効果として順に行う。途中失敗は部分成功を残し得る。また DB 側の公開失敗を fetch transient と同じ retry reason に畳み込むと、原因と回復手順が不明確になる。これは Plan 24 の挙動不変な責務分離では修正しない。

## 目標

- publication の部分成功、`recordPublication()` 失敗、再実行時の idempotency を状態機械として定義する。
- fetch、LLM/schema、DB/publication の失敗理由・retry 契約を分離する。
- transaction、outbox、reconciliation job の適合性を既存 DB 能力・回復性・運用コストで決定する。

## 非目標

- 記事本文、raw HTML、container、visible text、judgment slice の保存・出力。
- 読者向け表示、LLM プロンプト、rate cap、アクセス頻度の変更。
- 根拠なしの巨大 transaction 化または outbox 導入。

## 段階

1. DB 効果順、各失敗点、unique 制約、retry reason を trace/テストで棚卸しする。
2. transaction / idempotent write / outbox / reconciliation の採否を decision log に残す。跨げない効果があれば再実行可能な reconciliation を先に設計する。
3. 選定した最小実装と failure-injection integration test を追加し、upsert 後、curate 記録後、publication 記録後の各失敗を再実行する。
4. 本番書込み前に dry-run と read-only 観測で既存部分成功を検出できることを確認する。

## 受入条件

- 各 DB 効果の成功/失敗後の永続状態と次回 retry action が表で定義される。
- `recordPublication()` を含む任意の DB 失敗を注入しても、再実行後の公開は高々一回で、必要な記録は整合する。
- retry reason は fetch と DB/publication を混同せず、内容を含まない安定コードで観測できる。
- 失敗・reconciliation・debug の全 sink で本文と judgment slice が漏れない。
- targeted integration、`pnpm verify`、fresh clone、push 後 remote CI が成功する。

## 停止条件

破壊的 migration、既存公開の無根拠な一括書換え、または §10/§11 の非永続化・アクセス規律を緩める必要が判明した時点で停止し、設計判断を別途承認する。
