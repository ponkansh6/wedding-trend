<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 安全に関するルール

- 推論が反復・ループ・スタックしている場合、またはプレースホルダー（「思考中...」等）や繰り返しのフィラー出力が続く場合は、直ちに停止し同じユーザーリクエストを最初から再処理すること。部分的な出力を継続しないこと。

## プロジェクト知識

技術スタック・データモデル・収集パイプライン・テスト戦略・**法務制約**などの詳細は、
仕様書 `openspec/specs/wedding-trend/spec.md` を唯一の参照先とする。
AGENTS.md には重複記載しない（乖離防止）。変更時は spec.md を必ず更新すること
（pre-commit フック `scripts/check-spec-update.sh` が未更新を警告する）。

### 法務制約は仕様であって努力目標ではない

本プロジェクトは記事本文を一切生成しない中立キュレーションメディアである。
法務制約の詳細は **spec.md §10** を参照。緩めてはならない。

## Git Hooks の対処ルール

**error で終了するチェックは commit / push をブロックする**ため必ず修正すること。
warning はブロックしないが、シグナルとして必ず対処すること。

**フックの bypass は禁止**: `git --no-verify` / `git commit -n` / `HUSKY=0` 等はすべて禁止。
**技術的にも `~/.local/bin/git` ラッパーによりブロックされている**。例外は設けない。
詳細・対処手順は `docs/git-hooks.md` を参照。

## リソース制約

- **subagent 並行実行(最大3つ)**: 同時に実行するエージェントは最大3つまで。

## ツール使用に関するガイドライン

- `npx` や `npm` を利用せず、`pnpm exec` や `pnpm` を使用すること。`preinstall` の `scripts/only-pnpm.mjs` により技術的にもブロックされる。
- **sudo を要する操作**: 非対話環境のため `sudo` は直接使えない。代わりに `lxqt-sudo` で GUI パスワードポップアップを raise する。使用例: `lxqt-sudo <command>`. チェーンする場合は一時スクリプトにまとめて渡す。
- **`rtk` CLI プロキシ**（`~/.local/bin/rtk`）: コマンド出力をトークン最適化するラッパー。エラー詳細が必要な場合は `rtk run <command>` で生出力を取得する。詳細は `docs/tooling.md` を参照。

## 委譲に関するルール

> **🚨 委譲の第一原則（この2条は最優先）**
>
> 1. **依頼単位は小さく保つ**: 1 回の委譲は「1 つの明確な成果物」を単位とし、単位を大きくし過ぎないこと。関心事が混在する場合は分割して別 agent に委譲する。
> 2. **コンテキスト過剰蓄積を防ぐため積極的に新設する**: 既存 agent の context が膨張し続ける場合は同じ役割を抱え込まず、目的特化した新しいサブエージェントを新設して責務を分離する。長大な履歴の再利用より、単位を絞った新規セッションへの再委譲を優先する。
>
> この2条に違反する delegation は、例え実装が正しくても review で差し戻す。

- Orchestrator は自らコマンド実行を行わない。
- orchestrator が自ら直接編集や探索を行うのではなく、以下の判断基準に従って各 agent に積極的に委譲すること：
  - **コード探索・ファイル検索・ファイル内容の読み取り** → `@explorer` に委譲（可能な限り orchestrator 自身での read を避け、探索・要約を任せること）
  - **外部ライブラリ調査・Web 調査** → `@librarian` に委譲
  - **アーキテクチャ判断・コードレビュー・複雑なデバッグ** → `@oracle` に委譲
  - **UI/UX デザイン・見た目の実装** → `@designer` に委譲
  - **明確な実装作業（複数ファイル跨ぎ含む）** → `@fixer` に委譲
- 単一ファイルの軽微な編集以外は、まず「この作業を委譲できる agent がいるか？」を検討してから実行に移ること
- `@fixer` への委譲時は、自分が既に持っているコンテキスト（ファイル内容など）を prompt に含めて再読込コストを削減すること
- **書き込み範囲の非重複**: 複数の write 可能 agent を並列実行する場合、担当ファイル範囲を明示的に分割し、重複させないこと。共有する型の契約は事前に確定させ、双方の prompt に含める。
- **テスト実装とテスト実行は分離する**: テストの実装は `@fixer` に委譲し、テストの実行・検証は Orchestrator 自身が行う。サブエージェントが自分の実装したテストを自ら実行して検証結果を報告する運用は禁止し、Orchestrator が検証ゲート（lint, type-check, test, coverage, spec-refs, smoke-test）を走らせて結果を確認する。
- **実装内容の一致確認**: サブエージェントの実装完了時は、Orchestrator が実装内容（変更差分・成果物）と委譲時の指示内容が一致していることを確認する。乖離があった場合は、指摘して修正を再委譲してから検証ゲートを通過させる。
- **`@designer` の成果物を後から均さない**: レイアウト・余白・階層・モーション・色・コンポーネントの手触りは意図的な設計出力である。デザインを厳密に保つ機械的な後続作業のみ `@fixer` に渡してよい。視覚的な判断を要する変更は `@designer` に差し戻す。コピー（文言）は designer の弱点のため、Orchestrator が視覚・操作の意図を保ったまま見直す。
- **`@oracle` は見解の提示のみを行う**: `@oracle` は設計判断・アーキテクチャ評価・レビュー・デバッグ方針などの「見解」を返すことに限定し、自ら手を動かした調査（コマンド実行、コードの実行・修正、ファイル漁り）を行ってはならない。根拠となるコードや実行結果が必要な場合は、Orchestrator が事前に収集して委譲時に渡すか、データ取得そのものは `@explorer` / `@librarian` に委譲する。

## 検証に関するルール

- **ゲートが緑であることと、ゲートが機能していることは別である。** 新しく検証機構を追加した場合は、意図的に壊して「実際に落ちること」を確認するまで完了と見なさない。
- **完了の定義（Definition of Done）**: 機能の完了を報告する前に、関連する CI ゲート（lint, type-check, test, coverage tiers, spec-refs, security, smoke test）がローカルまたは CI で通過していること。
- ビルドやテストの成功のみを根拠にしないこと。変更差分を確認し、実際の挙動を検証する。

## 実行モードに関する指示

- ToDo タスクを実行する際は、各ステップごとにユーザーに「続けますか？」などの確認を求めず、最後まで一括して自律的に実行すること。
- 軽微な修正や次のステップへの移行は、ユーザーの明示的な承認を待たずに連続してツール（ファイル編集、コマンド実行など）を呼び出すこと。
- すべてのプロセスが完了するか、重大な競合・エラーが発生して進行できない場合のみ、最終結果とともに確認を求めること。
- ToDo の実行という指示は、全ステップの自動実行に対する事前承認を意味する。

## Git 運用

- 個人プロジェクトのため、作業ブランチは `main` を直接使用してよい。
- コミットメッセージは Conventional Commits（commit-msg フックで強制）。
