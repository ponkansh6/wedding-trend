# 20. 開発ゲート制約の緩和（運用簡素化）

- 対象: `wedding-trend`（本プロジェクト）
- 作成日: 2026-09-01
- 前提コミット: `f453d1d` `fix(pipeline): 終端棄却時に再試行キュー行を掃除する`
- 参照: `openspec/specs/wedding-trend/spec.md` §7.1 / §9.3 / §9.6 / §9.5a / §10 / §11、`shared_plan/17-simplification-plan.md`
- 状態: **P1〜P4 実装済み（2026-09-01）**。P3 の Tier1 対象は当初計画と実態が乖離していたため下記「実施メモ」を参照。`check-spec-update.sh` の blocking 化/削除（P1 後段）は未決着。
- 前提: 法務不変部分（記事本文の非生成・非永続化、逐語タイトル、discovery アクセス規律）は一切緩和しない。本計画の対象は**開発 CI / git フック側の摩擦**のみ。

---

## 背景

「制約が厳しすぎる」の中身は2種類ある。

- (A) 公開判定ゲートが厳しく記事が通らない = コンテンツ供給の問題
- (B) 開発 CI / フックが厳しく変更コストが高い = 開発運用の問題

調査の結果、**(A) は 2026-08-29 の3段緩和で既に底値に近く、摩擦の主因は (B)** であると判明した。本計画は (B) に絞る。

(A) の緩和実績（これ以上は緩めない）:

| 定数 / ゲート              | 旧   | 現     |
| -------------------------- | ---- | ------ |
| `MIN_EVIDENCE_INPUT_CHARS` | 80   | 30     |
| `MAX_LINK_DENSITY`         | 0.25 | 0.70   |
| `MIN_PARAGRAPH_COUNT`      | 3    | 1      |
| `checkAnchorLength`        | 12字 | 6字    |
| `filterTitle` 絵文字閾値   | 3個  | 11個   |
| 広告 / PR キーワード棄却   | 有   | 撤廃済 |

これ以上の緩和は §10-4「判定に足る原文テキストが無ければ LLM 判定結果を公開しない」を空文化させるため、本計画では対象外とする。

## 採用する施策（4件）

---

### P1. `check-prompt-version-bump.sh` の blocking 化（緩和ではなく強制の追加）

- 現状: `scripts/gates/check-prompt-version-bump.sh` は pre-commit で実行されるが **non-blocking の警告のみ**。`prompts.ts` を stage したのに `CURATION_PROMPT_VERSION` を bump し忘れると、古い curationSignature のまま再判定がスキップされる。**過去に実際に見落とし、87件が未再スコアとなる事故が発生している**。
- 変更内容: pre-commit で blocking（非ゼロ終了）にする。合わせて `scripts/gates/check-spec-update.sh` も「blocking 化」か「削除」の二択で決着させる（P2 実施後に spec 更新頻度が下がるため blocking 化が現実的になる。P2 完了までは現状維持）。
- 対象ファイル: `scripts/gates/check-prompt-version-bump.sh`、`.husky/pre-commit`
- 受け入れ条件: `prompts.ts` を変更し `CURATION_PROMPT_VERSION` を据え置いた状態で commit を試み、**実際にブロックされること**を確認する（AGENTS.md「ゲートが緑であることと、ゲートが機能していることは別」に従い、意図的に壊して落ちることを確認するまで完了としない）。bump 済みの場合は通ること。
- リスクと緩和策: 正当な理由でプロンプトを触るが再スコア不要なケースで詰まる。→ 修正コストは定数1行の bump のみ。回避が本当に必要なら明示的な環境変数エスケープを1つだけ用意する（既定は blocking）。
- 補足: 本計画で警告を減らす方向に動かす以上、**残す警告は blocking にする**のが一貫した設計。non-blocking 警告が複数併存する状態は、慣れて全部無視するようになるため最悪である。

---

### P2. spec.md から具体的な数値を追い出し、`constants.ts` を単一の真実とする

- 現状: spec.md が「Tier 別カバレッジ %」「`MAX_LINK_DENSITY=0.70`」「`DAILY_PUBLISH_CAP=150`」「`RATIONALE_TEXT_MAX_CHARS=210`」等の**具体値**を保持し、同じ値が `src/lib/constants.ts` にもある。二重管理のため、定数を1つ動かすたびに spec 編集 + `check-spec-refs.sh` のパス整合 + pre-commit 警告が発生する。**乖離は既に発生済み**（AGENTS.md 冒頭の 2026-08-31 訂正 = spec の記述が実装と一致していなかった件がまさにそれ）。`constants.ts` のコメントに「旧○○→○○」の改訂履歴が大量に残っており、チューニング途上であることが摩擦を増幅している。
- 変更内容: spec.md の §7.1 / §9.3 / §9.6 / §11項1 / §11-1 / §11項4 から数値そのものを削除し、「この値は `src/lib/constants.ts` の `<定数名>` を単一の真実とする」という参照に置き換える。spec に残すのは (1) 法務不変部分、(2) データモデル、(3) 不変条件の**意味**（値ではなく性質。例: 「`RATIONALE_TEXT_MAX_CHARS` は構造的最大値を上回ること」）。
- 対象ファイル: `openspec/specs/wedding-trend/spec.md`（§7.1 / §9.3 / §9.6 / §11項1 / §11-1 / §11項4）
- 受け入れ条件: spec.md 内に閾値のマジックナンバーが残っていないこと。定数名から `constants.ts` へ grep 一発で到達できること。`pnpm verify` が通ること。
- リスクと緩和策: spec 単体では閾値が読めなくなる。→ 定数名を明記すれば grep で到達可能。個人運営で読者は本人のみのため許容。
- 注意: **§10（法務制約）の記述は削らない。** 法務不変部分の意味・禁止事項は spec に残す。値の参照化の対象は品質ゲート閾値のみ。

---

### P3. Tiered Coverage を7段→3段に統合し、パターン陳腐化検出を fail → warn にする

- 現状: Tier1 95% / Tier2 85% / Tier3 80% / Tier4 80% / Tier5 70% / Tier6 65% / Tier7 除外 の7段。加えて `scripts/gates/check-coverage-tiers.mjs` に「どの実ファイルにも一致しない tier パターンがあれば即 fail」という陳腐化検出があり、ファイル改名・削除のたびにパターン更新が必須。忘れると CI が落ちる。
- 変更内容: Tier3 / Tier4（ともに 80%）を1本に、Tier5 / Tier6（70% / 65%）を1本に統合し、実質 **Tier1（法務・公開ゲート系 95%）/ Tier2（パイプライン・スコア 85%）/ その他 70%** の3段にする。未一致パターン検出は **fail をやめて warn** にする。
- **必須の付帯条件**: warn 化するなら、`verify.mjs` の終了時に「未一致 tier パターン N件」のサマリを必ず出力すること。これを省くと、`run-pipeline.ts` が長期間カバレッジ計測対象から外れていた過去事故が再発する。サマリ出力とセットでなければ warn 化してはならない。
- 対象ファイル: `scripts/gates/check-coverage-tiers.mjs`、`scripts/gates/verify.mjs`、`openspec/specs/wedding-trend/spec.md` §7.1（P2 と同時に実施）
- 受け入れ条件: 存在しないパスを tier パターンに追加した状態で `pnpm verify` を実行し、**CI が落ちずに警告サマリへ出ること**を確認する。Tier1 のカバレッジを意図的に下げた場合は**引き続き fail すること**を確認する。
- リスクと緩和策: 計測漏れの再発。→ 検出自体は残す（warn 化のみ）ため気付ける。ただし上記サマリ出力が必須条件。
- **Tier1（`src/lib/publish/gate.ts` / `src/lib/sources/access-discipline.ts` / `src/lib/publish/invariants.ts` 系）の 95% は下げない。**

---

### P4. 休眠コード・強制されていない「不変条件」の除去

- 現状:
  - `src/lib/publish/gate.ts` の `checkAnchorGrounding`（語彙的接地検証）と `checkAnchorNovelty`（タイトル冗長性）は、2026-08-29 のゲート緩和で `validateTopicAnchor` から撤廃済みであり、**呼び出し元のない休眠関数**として残存している。AGENTS.md の 2026-08-31 訂正が「`checkAnchorGrounding` は法務不変部分ではない」と明示しており、削除して差し支えない。
  - `src/lib/publish/invariants.ts` の INV-7 / INV-8 は、ファイル内で「規約であり型・ゲートによる強制ではない」と自ら明記されている。強制されないものを `INVARIANTS` 配列に置くことは「不変条件」という語の信頼性を損なう。
- 変更内容: 休眠2関数と、それらのみを対象とするテストを削除する。INV-7 / INV-8 は `INVARIANTS` 配列から外し、spec.md の運用ポリシー節へ移す（将来的に実際のゲート化を検討する場合は別計画とする）。
- 対象ファイル: `src/lib/publish/gate.ts`、`src/lib/publish/invariants.ts`、対応するテスト（`tests/publish-gate.test.ts` 等）、`openspec/specs/wedding-trend/spec.md`
- 受け入れ条件: `pnpm verify` が通ること。削除により Tier1 の coverage 分母が減り、95% 達成が容易になること。`validateTopicAnchor` の現行挙動（長さ下限6字 + 個人識別情報 denylist の2点）が**変わらないこと**をテストで確認。
- リスクと緩和策: 将来再利用する可能性。→ git 履歴に残る。YAGNI。

## 実施メモ（2026-09-01）

- **P1**: `check-prompt-version-bump.sh` を blocking 化（`exit 1`）。回避は `ALLOW_PROMPT_WITHOUT_BUMP=1` のみ。prompts.ts stage + version 据え置きで実際に commit がブロックされること、bump 済み／エスケープ変数で通ることを確認。
- **P2**: spec.md §7.1 / §9.3 / §11項1 / §11-1 / §11項4 / §11項5 から閾値のマジックナンバーを撤去し `src/lib/constants.ts` / `check-coverage-tiers.mjs` への参照へ置換。§9.6 は対応する定数が無いため対象外。§10 は不変更。constants.ts の値は不変更。
- **P3**: 7段→3段（Tier1 純粋ロジック 95% / Tier2 パース・公開ゲート・LLM 制御 85% / Tier3 その他 70% / 除外）。陳腐化検出は `exit 1` を撤廃し warn 化、`verify.mjs` 末尾に「未一致 tier パターン N件」サマリを出力（`coverage/stale-tier-patterns.json` 経由）。
  - **計画との乖離**: 計画は法務・公開ゲート系（`gate.ts` / `invariants.ts` / `access-discipline.ts`）を Tier1(95%) 前提としていたが、これらは**従来どの Tier にも属さず未計測**だった。現状 `gate.ts` 87%・`publish/` 87% のため 95% 到達には新規テストが必要。オーナー判断により**暫定的に Tier2(85%) へ配置**（`batch.ts` は 77% のため Tier3 へ）。Tier1 への引き上げは別計画。
  - 検証: 存在しないパスを tier パターンに追加 → `pnpm verify` は落ちず warn サマリへ。Tier1 相当のカバレッジ低下 → 引き続き `exit 1`。
- **P4**: 休眠関数 `checkAnchorGrounding` / `checkAnchorNovelty` / `isHiraganaContaining` を `gate.ts` から削除。`INVARIANTS` から INV-7 / INV-8 を除去（INV-1〜6 の ID は据え置き。逐語タイトル・非永続化の法務要件と強制コードは §10 に存置）。対応テストを整理。`validateTopicAnchor` の挙動は長さ下限6字 + PII denylist のみで不変。
- 付随修正: plan 19（trend レーン撤去・未コミット）で `smoke-test.sh` の empty-state 検証文言が実態とズレていたため「速報はまだありません」→「定番の体験談はまだありません」に追随。
- `pnpm verify` 全ゲート green（Tier1 98.47% / Tier2 88.77% / Tier3 79.97%）。

## 実施順と依存関係

1. **P1** — 数分で終わり、実害（87件事故）の再発を止める。他への依存なし。最初に実施。
2. **P2** — 最も高頻度の摩擦。P3 の spec 側修正と重なるため先行させる。
3. **P3 + P4** — セットで実施。P4 の関数削除が P3 の tier パターン整理に影響するため同一変更単位が望ましい。
4. **P1 の後段**（`check-spec-update.sh` の blocking 化 / 削除の決着）— P2 完了後に判断する。

## 本計画で見送るもの（理由付き）

- **verify の実行コスト削減（pre-push のフル verify 廃止 / secretlint スコープ縮小 / `getChangedFiles` フォールバック変更）**: 効果量が `pnpm verify` のステップ別所要時間に依存し、**未計測**のため判断保留。`smoke-test.sh` の `next build` が支配的なら効果は大きいが、そうでなければ P2 / P3 のほうが効く。まず計測すること。
- **有用度スコアの TS / SQL 二重実装の解消**（`computeUsefulnessScore()` と `USEFULNESS_SCORE_SQL` を単一定義から生成する案）: 実装コストが相応にあり、「スコア式を今後も触る予定があるか」次第。触らないなら現状維持でよい。
- **discovery の去就**: アクセス規律一式（robots ハッシュ監視・Crawl-delay・kill gate K1〜K6・`host_gate_state` の人手解除・終了コード分岐・鮮度チェック・`assertNoSliceLeak`）という最重量の機構を `www.mwed.jp` 1ホストのために維持している。**アクセス規律の緩和は法務不変で不可**だが、「discovery を続けるか」は問える（停止は法務的にはむしろ安全側）。判断には日次公開数の実測が必要。運用簡素化の最大のレバーだが、本計画のスコープ外とする。
- **`DAILY_PUBLISH_CAP=150` の緩和**: 実際に到達しているか未確認。到達していないなら効果ゼロ、到達しているなら暴走検知として機能しているので緩めるべきでない。
- **`AI_SUMMARY_VALIDATE_MIN/MAX = 60/200`（zod refine の唯一の実使用箇所）**: `renderRationaleText` が決定的テンプレート生成に切り替わった現在、この `summary` が公開面に出ているかが焦点。出ていないなら refine を外して LLM リトライを削減できる。**実装確認が必要**（`src/lib/llm/schemas.ts:47` の `summary` の消費先）。
- **`filterTitle` の細則、config の ISO8601 統一、lease / cooldown の 2分・15分→4時間**: 運用コストがほぼゼロ。触る価値なし。

## 判断保留のため要計測の項目

- `pnpm verify` のステップ別所要時間
- `rate_capped` の発生件数（`DAILY_PUBLISH_CAP` への到達有無）
- 日次公開数（discovery 停止時の影響見積り）
- ゲート別の棄却率（公開ゲートが実際に過剰棄却しているかの検証）

## Do Not Touch（緩和不可）

以下は法務不変部分および意図的な安全側設計であり、本計画でも将来の計画でも緩和対象としない。

1. **§10-3-1 逐語タイトル** — `aiTitle` の全経路 null 固定という実装的強制を外さない。
2. **§10-4 判定根拠の原文接地** — `extractArticleContainer` / `hasSufficientEvidence`。`MIN_EVIDENCE_INPUT_CHARS` のこれ以上の引き下げ、`MIN_PARAGRAPH_COUNT` の 0 化を含む。
3. **§10-5 抽出本文の非永続化** — `upsertPostRow()` の `originalExcerpt: null` 固定、`assertNoSliceLeak()` のキー許可リスト方式。**新カラム追加時に「とりあえず通す」をやらない。**
4. **§10-6 / §10-10 アクセス規律一式** — `MIN_HOST_INTERVAL_MS=5000`、robots.txt / Crawl-delay 遵守、`DAILY_REQUEST_CAP_PER_HOST=50`、`MAX_BODY_BYTES=512KB`、kill gate K1〜K6、permanent 停止からの自動復帰禁止（人手解除）、UA 変更・IP ローテーション等の回避行為禁止。**「個人運営だから」は相手先サーバへの負荷とは無関係であり、緩和の理由にならない。**
5. **§10-1 / §10-2 / §10-11** — 元ソース導線を最優先 CTA、`sourceName` 常時表示、外部サイト画像の再掲載・描画の全面禁止。
6. **§10-3-2 の機械強制** — `RATIONALE_TEXT_MIN/MAX_CHARS` の throw、および「構造的最大値 169 < MAX = 210」の関係を崩さない。
7. **§10-12 新規ホスト入場基準6項目** — チェックリストの省略・自動化禁止。`host-allowlist.ts` への自動追加禁止。
8. **§11項6 takedown / retract の人間判断** — dry-run 既定・`--reason` 必須・`--yes` 必須。自動化しない。
9. **§5 マイグレーション追加専用** — `apply-migrations-remote.mjs` の `ALTER TABLE` 全面禁止。本番 Turso 共有という前提が変わらない限り不可。
10. **§6.2 Basic 認証の多層防御 / §6.4 書き込み fail-closed** — 「読み取りフェイルソフト・書き込み fail-closed」の非対称設計は意図的。片側だけ緩めない。
11. **`pnpm` 強制・git hooks の bypass 禁止** — AGENTS.md の明文ルール。
