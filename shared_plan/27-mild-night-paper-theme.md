# 27. Mild Night Paper Theme

- 対象: ナイトモードのデザイン token、視覚的階層、テーマ回帰検証
- 作成日: 2026-09-07
- 状態: **中核実装・自動検証・公開フィード静止画受入完了／追加受入待ち**
- 前提: 通常モードの紙面感・朱アクセントを保ったまま、夜間に読みやすい表示へ翻訳する。

## 背景

現行ナイトモードは背景、surface、境界線、影が一斉に暗くなり、通常モードの生成り紙・軽い朱・雑誌的な面の階層が弱く見える。テーマ切替の仕組みや画面構造を変えず、`.dark` の semantic token を中心に「通常モードの延長として読める夜の表現」へ調整する。

## コンセプト: 薄暮の和紙

純黒と純白を避け、低彩度の温灰褐色、生成り寄りの文字色、意味を持つ箇所だけの穏やかな朱で構成する。カードは強い黒影で浮かせず、面色と控えめな境界線で紙面の階層を保つ。

## 目標

- ナイトモードでも通常モードの温度感、面の階層、朱アクセントの役割が読み取れる。
- 通常テキストは WCAG 4.5:1 以上、interactive state と focus indicator は 3:1 以上を満たす。
- 背景、surface、hover、sticky header、skeleton、topic、classic、AI 表示が一つの夜間トーンとして機能する。
- テーマ切替時の構造変化、CLS、ちらつきを増やさない。

## 非目標

- 通常モード、カード構造、余白、タイポグラフィ、テーマ切替方法、system 追従の変更。
- カテゴリ別カラー追加、本文・画像表現の追加、本文その他の法務制約の変更。
- 装飾的な border へ一律 3:1 を強制すること。border は面の階層が視認できることを評価し、意味を持つ interactive/focus state とは区別する。

## Token 対応表

| 役割                    | 提案 token            |
| ----------------------- | --------------------- |
| 背景                    | `#2c2926`             |
| surface                 | `#393532`             |
| hover surface           | `#46403b`             |
| 本文 foreground         | `#f7f0e8`             |
| muted text              | `#d4c9be`             |
| subtle text             | `#c5b9ae`             |
| border                  | `#5b544e`             |
| accent                  | `#e08a72`             |
| accent 上の文字         | `#2b211d`             |
| focus ring              | `#f0ad96`             |
| skeleton                | `#4b4540`             |
| topic surface / border  | `#473a30` / `#665649` |
| classic accent          | `#b8c7ee`             |
| AI surface / foreground | `#40354b` / `#ead5ff` |

## 段階と現在地

1. **TDD RED — 完了**: token contract を追加し、提案値に未達であることを確認した。
2. **GREEN — 完了**: `globals.css` の `.dark` 主要 semantic token、暖色の `--shadow-card` と `--topic-chip-shadow` を更新し、契約テストを GREEN 化した。通常モード token は不変である。
3. **自動検証 — 完了**: `tests/theme-tokens.test.ts` は 5/5 passed、`pnpm verify` は 57 files・640 passed / 1 skipped で通過した。
4. **公開フィード静止画受入 — 完了**: 390x844 と 1440x960 の light/dark 公開フィードを比較し、紙面階層・可読性・アクセント・レイアウトを pass とした。
5. **追加受入 — 待ち**: CLS 数値・ちらつき、画面状態・操作状態・Sonner 実画面、端末・reduced motion を確認・記録する。

- 2026-09-07 — 作業ツリー後退検出しGREEN再適用（16token+2影+color-scheme:dark）。`--shadow-card` と `--topic-chip-shadow` を暖色化し、影 token 専用 contract を追加。tests/theme-tokens.test.ts は 5/5 passed。

- 2026-09-07 — TDD RED を確認。`pnpm exec vitest run tests/theme-tokens.test.ts` は 4 tests 中 2 failed / 2 passed。
  - 意図した失敗: `.dark` の `--background` が現行 `#1a1512` であり、目標 `#2c2926` に未達。
  - 意図した失敗: `--topic-chip-shadow` が半透明の純黒影を含み、温かい影へ移行する契約に未達。
  - parser/runtime 由来の偶発的失敗はなし。
- 2026-09-07 — GREEN と自動検証を確認。`.dark` の主要 target token と 2 種の影を暖色化し、light token は変更していない。
  - token contract で確認した本文・accent/focus のコントラスト、背景 → surface → hover の階層、pure black/pure white を含まない影 token は基準を満たす。
  - 全検証は 57 files、640 passed / 1 skipped。lint、型検査、smoke、coverage tiers、schema 確認を通過。
- 2026-09-07 — 公開フィードの静止画受入を確認。390x844 と 1440x960 の light/dark 比較で、温かい紙面感、面の階層、可読性、朱アクセント、レイアウトの連続性を pass とした。
- 未確認: CLS 数値・ちらつき、loading/error/admin/toast、hover/focus/sticky header、Sonner toast の実画面、OLED 低輝度、iOS Safari、Android Chrome、reduced motion。追加受入が済むまで Plan 全体は完了扱いにしない。

## 残作業（優先度順）

### P1 — 追加の視覚・挙動受入

- theme switch の CLS 数値・ちらつきを計測・記録する。
- 390px・1440px で loading、error、admin、toast をライト/ナイトで比較する（公開フィード静止画は完了）。
- hover、focus-visible、sticky header、skeleton、topic、classic、AI 表示を確認する。
- Sonner toast が周囲の面・文字・accent と調和するか、実画面で判定する。

### P2 — 端末受入

- OLED 低輝度、iOS Safari、Android Chrome、reduced motion でコントラスト、focus、theme switch、sticky header を確認し、結果を記録する。

## 受入条件

- RED の token contract が変更前に失敗し、`.dark` token 実装後に成功した記録がある。通常モード token の変更では通らないことも確認済みである。
- `--shadow-card` を含むすべての影 token が pure black・高不透明度に依存せず、専用 contract で回帰を検出できる（完了）。
- 390x844 と 1440x960 で公開フィードをライト/ナイト両方で撮影・比較する（完了）。loading、error、admin、toast は追加受入で確認する。
- 通常テキストは 4.5:1 以上、interactive/focus は 3:1 以上である。装飾 border は面の階層が判別できることを目視・比較で確認する。
- theme toggle による CLS・ちらつきがなく、DOM 構造、レイアウト、テーマ切替契約は不変である。
- OLED 低輝度、iOS Safari、Android Chrome の確認結果を実施記録へ残す。
- `pnpm verify` が成功している。追加受入に伴う変更後に同じゲートを再実行し、コミット後の fresh clone と push 後 remote CI も成功する。

## 次の実行順序

1. P1 の CLS 数値・ちらつき、loading/error/admin/toast、hover/focus/sticky、Sonner 実画面を確認・記録する。
2. P2 の端末・reduced-motion 受入を記録する。
3. 追加受入後に全ゲート、fresh clone、remote CI を通して完了判定する。

## 停止条件

提案 token が必要コントラストを満たせない、通常モードとのデザイン連続性を維持できない、または theme toggle の構造・CLS 契約に影響する場合は実装を止める。token 値の確定、比較画像、失敗した条件を decision log に残し、コンポーネント改修を伴う別計画へ切り出す。

## Rollback

`.dark` token のみを単一コミットとして分離する。視認性、端末互換性、テーマ切替の回帰が確認された場合は、そのコミットを revert して既存 token へ戻す。通常モード、構造、テーマ永続化には変更を加えないため、rollback は配色変更だけで完結する。
