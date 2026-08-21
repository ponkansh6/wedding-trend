# 01. 開発パイプライン差分の補充プラン

- 対象: `wedding-trend`（本プロジェクト）
- 参照元: `../news-watch`（同一スタックの先行プロジェクト）
- 作成日: 2026-08-22
- 前提コミット: `c8c465c Implement wedding trend feed app`

---

## 1. なぜ今これをやるか

初期実装は完了し、`build` / `type-check` / `test`(56件) / `lint` の 4 ゲートは手動実行で通過している。
しかし現状これらは **「Orchestrator が思い出したときに手で叩く」以外に実行される保証がない**。

news-watch が持っている「壊れたものが自動的に止まる」機構、すなわち

- コミット時／プッシュ時に強制されるフック
- バイパス不可能な CI
- 仕様書とコードの乖離検出
- カバレッジの下限保証
- ビルド成果物が実際にレンダリングされることの確認（smoke test）

が本プロジェクトにはひとつも無い。実装が増えるほど後付けコストは上がるため、
コードベースが小さい今のうちに入れる。

---

## 2. 現状の差分

| 領域                           | news-watch                                        | wedding-trend                            | 優先度 |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------- | ------ |
| pre-commit フック              | あり（lint-staged → oxlint → tsgo → 仕様警告）    | **無し**                                 | P0     |
| pre-push フック                | あり（未コミット検知 → 2レーン並列 → drift 警告） | **無し**                                 | P1     |
| commit-msg 規約                | Conventional Commits を正規表現で強制             | **無し**                                 | P0     |
| `lint-staged.config.js`        | あり                                              | **無し**                                 | P0     |
| CI（GitHub Actions）           | `quality` ジョブで 10 ステップ                    | **無し**                                 | **P0** |
| シークレット走査               | secretlint（staged + 全件）                       | **無し**                                 | P0     |
| `format:check` スクリプト      | あり                                              | **無し**（`format:fast` のみ）           | P0     |
| smoke test（build→start→curl） | あり                                              | **無し**                                 | P1     |
| 仕様書の単一情報源             | `openspec/specs/*/spec.md`                        | **無し**                                 | P1     |
| 仕様参照の腐敗検出             | `check-spec-refs.sh`（ブロック）                  | **無し**                                 | P1     |
| 仕様未更新の警告               | `check-spec-update.sh`（非ブロック）              | **無し**                                 | P2     |
| カバレッジ下限                 | 7 ティア（95%〜65%）を機械検証                    | **無し**（計測すらしていない）           | P1     |
| ロックファイル同期検証         | `check-lockfile-sync.sh`                          | **無し**                                 | P2     |
| 依存の脆弱性監査               | `check-security.sh`（prod はブロック）            | **無し**                                 | P2     |
| 本番スキーマ drift 検出        | `check-prod-schema.sh`（警告）                    | **無し**                                 | P2     |
| RSC/Client 境界の lint         | `eslint-plugin-next-use-client-boundary`          | **無し**                                 | P1     |
| `docs/`（ツール・フック解説）  | 2 本                                              | **無し**                                 | P2     |
| プロジェクト固有の `AGENTS.md` | 7.3KB                                             | **無し**（Next.js 自動生成ブロックのみ） | P1     |
| 未使用依存検出（depcheck）     | あり                                              | **無し**                                 | P3     |

### 本プロジェクト固有の欠落（news-watch にも無いが、こちらには必要）

| 項目                         | 理由                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| **フィード死活監視**         | 収集の 100% が外部 RSS。フィードは予告なく消える。現に `AMEBLO_BLOG_IDS` はプレースホルダのまま      |
| **oEmbed 契約テスト**        | Instagram / TikTok の仕様変更で埋め込みが無言で壊れる。2026-06 にも Instagram 側の仕様変更があった   |
| **LLM 出力の規約遵守率計測** | 「見出し 30 文字以内」「要約 100〜150 文字」が本サービスの品質そのもの。守れているか誰も測っていない |
| **DB レイヤのテスト**        | `query.ts` / `repository.ts` にテストが 1 件も無い。ビルド時に実際に例外が出る経路                   |

---

## 3. 導入計画

### Phase 0 — コミットゲート（半日）

`husky` / `lint-staged` / `secretlint` を導入し、news-watch と同じ形を敷く。

```bash
pnpm add -D husky lint-staged secretlint @secretlint/secretlint-rule-preset-recommend
pnpm exec husky init
```

- `package.json` に `"prepare": "husky"` と `"format:check": "oxfmt --check ."` を追加
- `lint-staged.config.js`:
  ```js
  export default {
    "*.{ts,tsx}": ["oxfmt --write", "vitest related --passWithNoTests"],
    "*.{js,jsx,mjs,cjs,mts,cts,json,md,css,yaml,yml}": ["oxfmt --write"],
    "*": ["secretlint"],
  };
  ```
- `.secretlintrc.json` は preset-recommend のみ。`.secretlintignore` に
  `node_modules/ .git/ .next/ coverage/ pnpm-lock.yaml log/ shared_plan/ *.tsbuildinfo .env*` を列挙
- `.husky/pre-commit`: lint-staged → `oxlint` → `tsc --noEmit`
- `.husky/commit-msg`: Conventional Commits を正規表現で検証（merge / revert / fixup! / squash! は素通し）

**判断**: news-watch は型チェックに `tsgo`（`@typescript/native-preview`、dev 版）を使っているが、
本プロジェクトは規模が小さく `tsc --noEmit` が数秒で終わる。**dev 版依存は入れない**。
遅さが実測で問題になってから移行する。

### Phase 1 — CI（最優先・半日）

**フックはバイパス可能だが CI はできない。** 単独で最も費用対効果が高い。

`.github/workflows/ci.yml` — トリガーは `push: [main]` と全 `pull_request`。
`pnpm/action-setup@v4` + `actions/setup-node@v4`（Node 22、pnpm キャッシュ有効）。

ステップ:

1. `pnpm install --frozen-lockfile`
2. `pnpm run lint:fast`
3. `pnpm exec eslint src/`
4. `pnpm run type-check`
5. `pnpm run format:check`
6. `pnpm exec vitest run --coverage`
7. `node scripts/check-coverage-tiers.mjs`（Phase 4 で有効化）
8. `bash scripts/check-spec-refs.sh`（Phase 3 で有効化）
9. `bash scripts/smoke-test.sh`（Phase 2 で有効化）

7〜9 は該当スクリプト導入後に追加する。**先に 1〜6 だけで CI を回し始める**こと。
完璧な CI を待つより、不完全な CI が今日動いているほうが価値が高い。

### Phase 2 — smoke test（半日）

`scripts/smoke-test.sh` を news-watch から移植し、本プロジェクト向けに書き換える。

- ポート 3100 の占有を事前確認 → `next build` → `TURSO_DATABASE_URL=":memory:" PORT=3100 setsid next start`
- 最大 30 秒待って `curl localhost:3100/`
- **HTTP 200 を成功と見なさない**。以下を判定する:
  - レスポンス本文に `E{"digest"` を**含まない**（RSC エラーダイジェスト）
  - 本文に `ウエディング・トレンド` を**含む**（レンダリング成功）
  - 本文に `速報はまだありません` を**含む**（← 本プロジェクト固有）
- `trap` でプロセスグループごと kill し、orphan な next-server を残さない

**なぜ空状態の文言まで検証するか**: 初回起動時の実状態が「DB にテーブルが無い」であり、
`getFeedCards` はそこでフェイルソフトして `[]` を返す設計になっている。
この経路が壊れるとトップページが 500 になる。実際に初回 `pnpm build` で
`SQLITE_ERROR: no such table: posts` が出てなおプリレンダリングが成功することを確認済みで、
**この挙動こそが回帰させてはならない仕様**である。

### Phase 3 — 仕様の単一情報源（1 日）

`openspec/specs/wedding-trend/spec.md` を作り、AGENTS.md からは技術詳細を排除して
「spec.md を唯一の参照先とする」と書く（news-watch と同じ乖離防止ポリシー）。

spec.md の章立て（news-watch を踏襲しつつ本企画向けに調整）:

1. Executive Summary
2. Scope（in / out）— **「本文を生成しない」を明示的に Out of Scope に置く**
3. Functional Requirements（FR-001〜）
4. Non-Functional Requirements
5. Data Model（`posts` 単一テーブル）
6. Architecture（2 レーン構成・収集パイプライン・oEmbed フォールバック）
7. Test Strategy（§7.1 にカバレッジティア表）
8. Non-Goals
9. **法務制約**（← 本企画固有の新設章）
   - 元ソースへの導線を主動線に置く
   - 著作者クレジットの必須化
   - 要約が原文の創作的表現を再現しないこと
   - これらが**プロンプトと UI の両方で**担保されていることの記述

続いて `scripts/check-spec-refs.sh`（プッシュ時ブロック）を移植。
spec.md 内のバッククォート囲みの `src/` / `tests/` パスが実在するかを検証し、腐敗した参照で落とす。

`check-spec-update.sh`（非ブロック警告）は P2。**先に spec.md 本体を書くほうが先**であり、
中身の薄い spec.md に対して更新警告だけ出しても意味がない。

### Phase 4 — カバレッジティアと不足テストの補充（1〜2 日）

`vitest.config.ts` の `exclude` から `src/app/**` を外し（API ルートを計測対象に含める）、
`scripts/check-coverage-tiers.mjs` を移植する。

spec.md §7.1 に置くティア表（本プロジェクト向けに再定義）:

| Tier              | 対象                                                                                                     | 目標   | 現状のテスト      |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------ | ----------------- |
| 1. 純粋ロジック   | `lib/url.ts`, `lib/llm/signature.ts`, `lib/llm/schemas.ts`, `lib/constants.ts`                           | 95%    | ✅ あり           |
| 2. パース・判定   | `lib/sources/base/feed-parser.ts`, `lib/embed/providers.ts`                                              | 85%    | ✅ あり           |
| 3. 収集アダプタ   | `lib/sources/{hatena-bookmark,google-news,note,ameblo}.ts`, `base/rss-fetcher.ts`, `lib/embed/oembed.ts` | 80%    | ❌ **無し**       |
| 4. LLM 制御       | `lib/llm/batch.ts`, `lib/llm/client.ts`                                                                  | 80%    | △ batch のみ      |
| 5. API ルート     | `app/api/{ingest,submit-url}/route.ts`                                                                   | 70%    | ❌ **無し**       |
| 6. データアクセス | `lib/db/repository.ts`, `lib/db/query.ts`                                                                | 65%    | ❌ **無し**       |
| 7. RSC / UI       | `app/page.tsx`, `app/layout.tsx`, `components/**`                                                        | 対象外 | smoke test で担保 |

**補充すべきテストの優先順位**（Tier 6 → 5 → 3 → 4）:

1. **Tier 6 が最優先**。`getFeedCards` のフェイルソフト経路（テーブル不在で `[]` を返す）は
   初回起動時の実経路であり、ここが唯一まだ機械検証されていない。
   in-memory libSQL + マイグレーション適用でスキーマ整合性テストも同時に入れる
   （news-watch の `tests/db/schema-consistency.test.ts` 相当）。
2. **Tier 5**。`/api/ingest` の重複排除・予算制御・`revalidateTag` 呼び出しをネットワークモックで検証。
   `/api/submit-url` は LLM 失敗時に `status: "pending"` へフォールバックする分岐が未検証。
3. **Tier 3**。各アダプタは保存済み XML フィクスチャに対して検証する（実ネットワークを叩かない）。
4. **Tier 4**。`client.ts` の 429 / 5xx バックオフとタイムアウトが未検証。

### Phase 5 — 供給ライン監視（本プロジェクト固有・1 日）

外部依存が収集の 100% を占めるため、news-watch には無い監視をこちらには入れる。

#### 5-1. `scripts/check-sources.mjs`（手動 + CI 週次）

`SOURCE_REGISTRY` の全フィードに実際に HTTP アクセスし、以下を表で報告する:

- HTTP ステータス / 応答時間
- パース後のエントリ件数（0 件なら死亡扱い）
- `link` / `title` / `publishedAt` が取れているか

**PR の CI では走らせない**（外部起因で赤くなり、CI への信頼を壊すため）。
`schedule:` トリガーの別ワークフローで週次実行し、失敗時は Issue を立てる。

これが解決する既知の宿題:

- `AMEBLO_BLOG_IDS` がプレースホルダのままであること（現状 0 件を返し続けるが誰も気づかない）
- Google News RSS の `<link>` が `news.google.com` リダイレクトで、元記事 URL が直接取れない問題

#### 5-2. oEmbed 契約テスト（同上・週次）

Instagram / TikTok / YouTube の各 oEmbed エンドポイントに既知の公開投稿 URL を投げ、
`html` と `thumbnail_url` が返ることを確認する。仕様変更を最速で検知するため。

#### 5-3. LLM 出力の規約遵守率（手動評価）

保存済みフィード 20 件をゴールデンセットとし、`curatePosts` を実行して次を測る:

- 見出しが 30 文字以内である率
- 要約が 100〜150 文字に収まる率
- カテゴリが列挙から選ばれている率（zod で担保済みだが再試行回数を測る）
- **要約と原文の 5-gram 一致率**（著作権上の「創作的表現の再現」を機械的に近似する指標）

CI ゲートにはしない（LLM 出力は非決定的）。プロンプト変更時に手で回す**評価スクリプト**として置く。

### Phase 6 — 運用系ゲート（半日）

- `scripts/check-lockfile-sync.sh` — `pnpm install --frozen-lockfile --lockfile-only`
- `scripts/check-security.sh` — `pnpm audit --prod --audit-level=high` は**ブロック**、dev 依存は警告のみ
- `scripts/check-prod-schema.sh` — Turso 本番スキーマと `schema.ts` の drift 検出（**警告のみ**。ネットワーク・認証依存でブロックすると開発が止まる）
- `pnpm add -D depcheck` + `"check:deps": "depcheck"`
- `.husky/pre-push` — Phase 1〜6 のスクリプトを束ねる

### Phase 7 — ドキュメント（半日）

- `docs/tooling.md` — pnpm 固定、oxlint / oxfmt、smoke test の挙動、CI ゲート構成
- `docs/git-hooks.md` — 各フックの警告・エラーごとの対処手順
- `AGENTS.md` — 現在 Next.js 自動生成ブロックのみ。以下を追記する:
  - フックのバイパス禁止
  - 技術詳細は `openspec/specs/wedding-trend/spec.md` を唯一の参照先とすること
  - **法務制約は仕様であって努力目標ではないこと**（元リンク導線・著作者クレジット・翻案回避）

---

## 4. 意図的に採用しないもの

news-watch から機械的に移植しない判断とその理由。

| 項目                                   | 判断                   | 理由                                                                                                                                      |
| -------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| pre-push の 2 レーン並列実行           | **見送り**             | news-watch の 305 行フックは 2 コア i3 上で 35 秒を切るための実測最適化。本プロジェクトはテスト 56 件・数秒で終わる。遅くなってから入れる |
| `tsgo`（`@typescript/native-preview`） | **見送り**             | dev 版依存を初期から抱えたくない。`tsc --noEmit` で十分速い                                                                               |
| `prettier`                             | **入れない**           | `oxfmt` と役割が重複。news-watch でも導入済みだが未使用                                                                                   |
| `ts-node` / `tsc-files`                | **入れない**           | `tsx` で代替済み                                                                                                                          |
| `vercel` CLI の devDependency          | **入れない**           | デプロイ時に `pnpm dlx` で足りる                                                                                                          |
| 嗜好プロファイル系のテスト資産         | **対象外**             | 本プロジェクトは中立キュレーションでパーソナライズしない                                                                                  |
| `check-spec-update.sh`                 | **Phase 3 では見送り** | spec.md の中身が薄い段階で更新警告だけ出しても形骸化する。§9 法務制約まで書けてから入れる                                                 |

---

## 5. 実行順の推奨

依存関係を踏まえた最短経路。

```
Phase 1 (CI 1〜6)  ─┬─> Phase 0 (フック)
                    ├─> Phase 2 (smoke test) ──> CI ステップ 9 有効化
                    └─> Phase 3 (spec.md)    ──> CI ステップ 8 有効化
                                              └─> Phase 4 (ティア + テスト補充) ──> CI ステップ 7 有効化
Phase 5 (供給ライン監視) ── 独立・いつでも可
Phase 6 / 7 ── 最後
```

**Phase 1 を最初に置くこと。** フック（Phase 0）はローカルかつバイパス可能な補助輪であり、
真のゲートは CI である。順序を逆にすると「フックは通るが CI が無い」状態が長く続く。

---

## 6. 完了判定

- [ ] `main` への PR が CI 無しにマージできない
- [ ] `git commit` 時に oxfmt 整形・シークレット走査・関連テストが自動で走る
- [ ] Conventional Commits に沿わないコミットメッセージが弾かれる
- [ ] `pnpm build` が通っても**レンダリングが壊れていれば** smoke test が落ちる
- [ ] `spec.md` が実在しないファイルを参照した時点でプッシュが落ちる
- [ ] Tier 3 / 5 / 6 のテストが存在し、カバレッジ下限を機械検証している
- [ ] 週次でフィードと oEmbed の死活が報告される
- [ ] `AMEBLO_BLOG_IDS` が実在するブログ ID に置き換わっている
