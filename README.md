# ウエディング・トレンド ＆ リアルフィード

結婚式準備の「今」のトレンドと「リアル」な体験談を、1 分で俯瞰できるキュレーションフィード。

**記事は一切書かない。** 公開されている SNS 投稿・ブログ記事に対して AI が「見出し」と「短い要約」を付け、
元投稿への導線（公式埋め込み or リンク）とセットでカード表示するだけの、中立なキュレーションメディア。

## コアな設計判断

| 判断                             | 理由                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 本文を生成しない                 | LLM コスト・ハルシネーション・著作権リスクを同時に最小化する                                   |
| 元ソースへの導線を主動線に置く   | 「ゼロクリック要約」は日本の著作権実務上もっとも危険。読者を原文に送ることが法的アンカーになる |
| 著作者名を必ずクレジット         | 引用（著作権法 32 条）の要件を満たすため                                                       |
| 要約は原文の言い回しを再現しない | 翻案（同法 27 条）と評価されるリスクを避ける。プロンプトに明示的に制約として書き込んでいる     |
| パーソナライズしない             | 中立キュレーションを標榜するため、スコアリング／嗜好プロファイルは持たない                     |

## 2 つのレーン

- **上段：最新トレンド速報**（`sourceType: "sns"`）— 視覚優先。演出・衣装・DIY などのビジュアル情報
- **下段：満足度の高い王道・定番**（`sourceType: "blog"`）— テキスト優先。卒花の体験談・費用感・アドバイス

## データ収集の方針

### 体験談レーン（自動巡回）

RSS のみを使う。API キー不要・無料・ToS 上クリーン。

- はてなブックマーク タグ検索 RSS
- Google News RSS（日本語クエリ）
- note.com フィード
- アメーバブログ 個別ブログ RSS

> **調査済みの制約**: ゼクシィ・ハナユメ・マイナビウエディング・Wedding Park・みんなのウェディングは
> いずれも公開 RSS / API を提供していない。これらは自動収集の対象にできない。

### SNS レーン（管理者が URL を投入）

Instagram / TikTok の**ハッシュタグ自動収集は現実的に不可能**である。

- Instagram Graph API のハッシュタグ検索 → ビジネスアカウント＋Meta のアプリ審査が必須
- TikTok Research API → 学術・非営利のみ。商用申請はほぼ通らない
- 有料スクレイピング API（Apify / Bright Data 等）→ 月額数十〜数百ドル＋ToS リスク

そのため v1 は **管理者が投稿 URL を `POST /api/submit-url` に投げると、oEmbed で埋め込みを取得し
AI 要約を付けてカード化する**半自動フローを採用する。

埋め込みは以下のキーレス oEmbed エンドポイントを使う:

- Instagram — `graph.facebook.com/v25.0/instagram_oembed`（2026 年 6 月よりトークン不要で公開投稿に利用可）
- TikTok — `www.tiktok.com/oembed`
- YouTube — `www.youtube.com/oembed`

いずれも失敗時はサムネイル＋リンクボタンにフォールバックし、カードは壊れない。

## パイプライン

```
RSS 巡回 / 管理者 URL 投入
  → 正規化・URL 重複排除
  → contentHash / curationSignature で処理済みをスキップ
  → LLM でタイトル・要約・カテゴリ・トレンド/定番タグを一括生成
  → 保存 → キャッシュ再検証
```

`posts.status` は v1 では既定 `published`（自動公開）。
将来ワンタップ承認 UI を追加する際にマイグレーション不要で `pending` 運用へ切り替えられる。

## セットアップ

```bash
pnpm install
cp .env.local.example .env.local   # 各値を設定
pnpm check-env
pnpm db:push
pnpm dev
```

## スクリプト

| コマンド                                     | 用途                    |
| -------------------------------------------- | ----------------------- |
| `pnpm dev` / `build` / `start`               | Next.js                 |
| `pnpm test`                                  | Vitest                  |
| `pnpm type-check`                            | 型生成 + `tsc --noEmit` |
| `pnpm lint:fast` / `format:fast`             | oxlint / oxfmt          |
| `pnpm check-env`                             | 環境変数の検証          |
| `pnpm db:generate` / `db:push` / `db:studio` | Drizzle                 |

## 技術スタック

Next.js 16（App Router / RSC）・React 19・TypeScript strict・Tailwind CSS v4・
Drizzle ORM + Turso (libSQL)・Google Gemini・Zod・Vitest
