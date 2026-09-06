# 26. Pipeline Budget and Observability

- 対象: discovery pipeline の時間予算契約、休眠メトリクス、性能観測
- 作成日: 2026-09-06
- 状態: **未着手（中低優先）**
- 前提: Plan 24。normalized golden diff と remote CI handoff は Plan 24 に残す。

## 背景

`processUrl` の `_opts.budgetMs` は実質的に使われず、仕様上の実行時間予算の記述との整合を判断する必要がある。`anchorUngroundedDropped` も現在のアンカー gate では実際の増分経路を持たず、観測値として誤解を招く。いずれも公開の正しさを直ちに変えないため、Plan 24 の責務分離には混在させない。

## 目標

- `budgetMs` を強制する、明示的に廃止する、または上位ランの責務へ移すかを決定し、spec・型・呼出し元を一貫させる。
- `anchorUngroundedDropped` を削除、置換、または実際に観測可能な値へ再定義する。
- fetch、抽出、LLM、永続化、retry の非内容 metadata による最小限の性能・失敗観測を定義する。

## 非目標

- 本文、raw HTML、visible text、judgment slice、raw LLM request/response の telemetry 化。
- rate cap・robots/ToS・same-host=1・host 間隔の緩和、または性能を理由にした並列 fetch 導入。
- Plan 24 の normalized golden diff、fresh clone、remote CI handoff の移管。

## 段階

1. `budgetMs` の全呼出し・仕様記述・workflow timeout を棚卸しし、単一の所有者と停止時の status/retry 契約を決める。
2. producer/consumer を確認し、休眠メトリクスを削除または互換移行する。名称だけを残してゼロ固定にはしない。
3. 許可済み非内容 metadata のみで観測・しきい値・サンプリングを導入し、意図的な leak fixture で gate が失敗することを確認する。
4. 同一 input と同一 access discipline で前後比較し、性能改善が確認できる場合だけ追加最適化を別計画に切り出す。

## 受入条件

- `budgetMs` の採否と、時間切れ時の pending/retry/統計の振る舞いが spec・型・実装・テストで一致する。
- `anchorUngroundedDropped` は実態に合う観測値だけを残し、休眠のゼロ値を KPI として扱わない。
- 新規 telemetry は本文由来データを含まず、意図的な漏洩で gate が失敗する。
- `pnpm verify`、fresh clone、push 後 remote CI が成功する。

## 停止条件

正確な時間切れ semantics を定義できない、本文由来データなしに観測不能、またはアクセス規律への影響がある場合は実装を止め、decision log のみを残す。
