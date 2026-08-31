# 13. 公開面から評価文章（判定根拠）とメディア領域を除去する

- 対象: `wedding-trend`（本プロジェクト）
- 参照: `shared_plan/12-wedding-day-content-criterion.md`（§5 影響範囲・Stage 6 と競合。本文書 §8 参照）
- 作成日: 2026-08-27
- 前提コミット: `4f24fe4`（`git log --oneline -3` で確認: `4f24fe4` chore(golden-set) / `0305f67` fix(backfill) / `c75d460` refactor(curation)!。作業ツリーはクリーン（`git status --short` で確認: 未追跡の `shared_plan/12-*.md` / `shared_plan/13-*.md` の2件のみ）。**本文書の初版作成時点で「未コミット差分あり」と記していた `spec.md`/`constants.ts`/`prompts.ts` は、その後 `c75d460` に取り込まれてコミット済みになっている**）
- 状態: **実装済み**（`1f0b16a` `refactor(feed): remove public rationale summary and media zones`）。
  2026-08-31 に archive へ移設した際、状態行が未更新のままだったため訂正した。
  なお本プランの一部（topicAnchor と有用度バッジ）は `shared_plan/14` で意図的に復活している。

---

## 1. 変更の意図

オーナーの決定により、公開面（フィードUI）から次の2領域を除去する。

1. **Summary ゾーン**（判定根拠の表示: `topicAnchor` / `rationaleText` / 有用度判定バッジ / 「自動判定」バッジ、および `aiSummary` フォールバック）
2. **メディア領域**（画像サムネイル・SNS 埋め込み: `Media()` / `Thumbnail()` / `FallbackTile()` / `SnsEmbed`）

### 1-1. `aiSummary` フォールバックの罠

`src/components/feed/feed-card.tsx` の `Summary()` 関数は
`const hasRationale = card.topicAnchor !== null || card.usefulness !== null;` で分岐し、
`hasRationale` が false の場合は `card.aiSummary` を描画する（後述 §2 で逐語引用）。
rationale の描画部分だけを削り、この false 分岐（`aiSummary` 描画）を残すと、rationale
を持たないカードがすべて `aiSummary` 表示に落ちる。これは本プロジェクトの改訂履歴が
明示的に避けた退行である。`openspec/specs/wedding-trend/spec.md` §10 冒頭の改訂履歴は
次のように記録している。

> 当初 AI 要約を出力する設計だったため §10-3/§10-4 は「要約の表現制限」を前提に
> 書かれていた。判定根拠（トピックアンカー＋根拠文）への転換
> （`shared_plan/06-rationale-and-scraping.md`）に伴い、§10-3 を「出力は記事の性質
> についての言明であり内容の配達ではない」に... 書き換えた。

つまり要約形式（`aiSummary`）はゼロクリック化・翻案リスクを負うため rationale 形式へ
転換した、という経緯がある。したがって本プランは Summary ゾーンを**丸ごと**（rationale
描画部分と `aiSummary` フォールバック部分の両方）削除する。「rationale だけ消す」実装は
明確な誤りであり、実装 Stage で最初に検証すべき失敗パターンとして明記する。

### 1-2. §9.8「スコアは UI に公開表示しない」との整合

spec.md §9.8 は「有用度スコアはページ上の一般公開面には表示しない...点数そのものの
公表は評価行為であり、本プロジェクトのスコープ外とする」と定める。現行の Summary
ゾーンは生の点数こそ出さないが、有用度バッジ（「当事者本人」「意思決定に効く」等）
という**スコアの構成要素**を可視化しており、§9.8 の精神の延長線上で見れば中立
キュレーションの原則により近づける自然な変更である。本プランはこの既存方針の
延長として位置づけられる。

### 1-3. 画像の法務検討という仕様の穴

`openspec/specs/wedding-trend/spec.md` §10（法務制約）を通読したが、外部サイトの
画像・OGP画像・サムネイルの転載についての法務検討は一切記載がない。§10-2の著作者
クレジット義務、§10-3のタイトル逐語表示・根拠文の制約は文章について定めるのみで、
画像の転載可否・引用要件については触れられていない。これは仕様の欠落である。
本プランは画像を公開面から外す変更であるため、この機会に §10 へ「外部サイトの
画像を公開面に転載しない」方針を新規に明文化する（§7 Stage 参照）。

---

## 2. 現行の公開面（逐語引用）

### 2-1. `FeedCard()` 本体（`src/components/feed/feed-card.tsx:26-71`、要旨）

`isVisual`（`variant === "visual"`）の場合は `Media()` → `Title()` → `Summary()` の順、
`editorial` の場合は横並びで `Thumbnail()` の隣に `Title()` → `Summary()` を縦積みする。
いずれも末尾に `Footer()`。

```tsx
{
  isVisual ? (
    <Media card={card} variant={variant} />
  ) : (
    <div className="flex gap-3">
      <Thumbnail card={card} variant={variant} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Title card={card} variant={variant} />
        <Summary card={card} variant={variant} />
      </div>
    </div>
  );
}

{
  isVisual && (
    <>
      <Title card={card} variant={variant} />
      <Summary card={card} variant={variant} />
    </>
  );
}

<Footer card={card} variant={variant} />;
```

### 2-2. `Summary()`（`src/components/feed/feed-card.tsx:88-170`、要旨・逐語）

```tsx
function Summary({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  const hasRationale = card.topicAnchor !== null || card.usefulness !== null;

  if (hasRationale) {
    return (
      <div className="flex flex-col gap-2">
        <Badge variant="ai" ...>
          <Sparkles className="size-3" aria-hidden />
          自動判定
        </Badge>
        {card.topicAnchor && <p ...>{card.topicAnchor}</p>}
        {card.rationaleText && <p ...>{card.rationaleText}</p>}
        {card.usefulness && (/* 有用度5フラグのバッジ群: 当事者本人 / 意思決定に効く /
             具体的 / 結婚式当日の内容 / 式前・撮影段階 */)}
      </div>
    );
  }

  // hasRationale が false のときのフォールバック（=「罠」。§1-1参照）
  return (
    <div className="flex flex-col gap-1.5">
      <Badge variant="ai" ...>
        <Sparkles className="size-3" aria-hidden />
        AI要約
      </Badge>
      <p ...>{card.aiSummary}</p>
    </div>
  );
}
```

### 2-3. `Media()` / `Thumbnail()` / `FallbackTile()`（`feed-card.tsx:207-273`、要旨）

- `Media()`: `card.embedProvider !== "none" && card.embedHtml` があれば `SnsEmbed` を
  描画し、失敗時フォールバックとして `Thumbnail()` を渡す。それ以外は `Thumbnail()`。
- `Thumbnail()`: `variant="editorial"` は `card.thumbnailUrl` があれば
  `size-24 sm:size-28` の正方形 `<img>`（生 `<img>`、`next/image` 不使用）、無ければ
  `FallbackTile()`。`variant="visual"` は `aspect-[4/5] w-full` の縦長画像、無ければ
  `FallbackTile()`。
- `FallbackTile()`: `lucide-react` の `ImageOff` アイコン＋トレンド/定番に応じた
  グラデーション背景のプレースホルダタイル。

### 2-4. `Footer()`（`feed-card.tsx:172-200`、要旨。**本プランでは変更しない**）

`sourceName` ・（あれば）`author` ・ `PublishedTime` を1行で表示し、`card.url` への
外部リンクボタン（`ExternalLink` アイコン付き、`isVisual` で文言「投稿を見る」/
「原文を読む」）を配置する。著作者クレジットと原文導線を担う唯一の箇所であり、
§10-2（著作権法32条・48条）の要件をこの関数が単独で満たしている。

---

## 3. 変更後の公開面

カードに残すもの: 「カテゴリ/トレンド・定番バッジ」「記事タイトル（逐語）」
「出典名・著者名・公開日時」「原文リンクCTA」の4要素のみ。

```
before（visual variant 例）              after（visual/editorial 共通）
┌───────────────────────┐          ┌───────────────────────┐
│ [カテゴリ][トレンド]          │          │ [カテゴリ][トレンド]          │
│ ┌─────────────────┐ │          │ 記事タイトル（逐語・2行まで）    │
│ │   Media(画像/埋込)   │ │          │ ─────────────────── │
│ │                   │ │          │ 出典名・著者・公開日時  [原文を見る→]│
│ └─────────────────┘ │          └───────────────────────┘
│ 記事タイトル（逐語）          │
│ ┌─────────────────┐ │
│ │[自動判定]バッジ         │ │
│ │ topicAnchor        │ │
│ │ rationaleText      │ │
│ │ [有用度バッジ群]        │ │
│ └─────────────────┘ │
│ ─────────────────── │
│ 出典名・著者・公開日時  [投稿を見る→]│
└───────────────────────┘
```

visual/editorial の描き分け（余白・タイポグラフィ階層・境界線・バッジ配色等）は
視覚的判断であり、§6・§9 で述べる通り `@designer` に委譲する。

---

## 4. 削除の射程（UI のみ）

以下は**維持する**（データ層・パイプラインは一切変更しない）。

| レイヤ       | 対象                                                                                                                                                | 判断                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| DB スキーマ  | `postRationales` テーブル（`src/lib/db/schema.ts:148-155`）                                                                                         | 維持                                 |
| DB スキーマ  | `posts.thumbnailUrl`（`src/lib/db/schema.ts:28`）                                                                                                   | 維持                                 |
| ゲート/生成  | `renderRationaleText()`・`RationaleUsefulnessFlags`・`USEFULNESS_LABELS`・`FLAG_ORDER`（`src/lib/publish/gate.ts:236-322`）                         | 維持（内部生成物として残す）         |
| LLM 出力     | `topicAnchor` ・有用度6 boolean（`src/lib/llm/schemas.ts` の `CurationItemSchema`）                                                                 | 維持                                 |
| 取得         | OGP `og:image` 抽出（`src/lib/sources/ogp.ts`）                                                                                                     | 維持                                 |
| 取得         | `extractFirstImage` / `resolveRss2Thumbnail` / `hatena:imageurl` / `media:thumbnail` / enclosure（`src/lib/sources/base/feed-parser.ts:58,76-136`） | 維持                                 |
| 取得         | oEmbed `thumbnail_url`（`src/lib/embed/oembed.ts`）                                                                                                 | 維持                                 |
| パイプライン | `src/lib/pipeline/evergreen.ts:185,323`・`src/lib/pipeline/submit-url.ts:183,307` の thumbnail/embed 処理                                           | 維持                                 |
| 定数         | `RATIONALE_DISPLAY_PHASE`・`RATIONALE_TEXT_MIN/MAX_CHARS`（`src/lib/constants.ts`）                                                                 | 維持（掲載可否ゲートとして。§5参照） |
| クエリ       | `getFeedCards()` の `postRationales` への `leftJoin`、`RATIONALE_DISPLAY_PHASE` 分岐（`src/lib/db/query.ts`）                                       | 維持（§5参照）                       |

UI 側のみ削る対象は §6 の表にまとめる。

---

## 5.【警告】rationale は掲載可否ゲートを兼ねる

spec.md §9.9「表示可否条件」（`openspec/specs/wedding-trend/spec.md:696-718`）は、
`getFeedCards()` が投稿を公開面に出す条件を `RATIONALE_DISPLAY_PHASE` で2段階に
切り替えると規定している。

> - **phase1（既定）**: `(posts.ai_title IS NOT NULL AND posts.ai_summary IS NOT NULL)
OR post_rationales.post_id IS NOT NULL`。
> - **phase2**: `post_rationales.post_id IS NOT NULL` のみ。

つまり `post_rationales` 行の**存在**そのものが「その投稿を公開してよいか」という
掲載可否の条件として機能しており、UI で rationale を描画しないことと、掲載可否判定に
rationale の有無を使うことは独立している。本プランは**後者を変更しない**。

- `getFeedCards()` の `postRationales` への `leftJoin`、`FEED_ROW_FIELDS` での
  `topicAnchor`/`rationaleText` 取得（`src/lib/db/query.ts:39-40`）は**削除しない**。
  UI で使わなくなっても、掲載可否判定・並び順キー算出に使われている可能性があるため
  そのまま残す。
- `RATIONALE_DISPLAY_PHASE` の2段階分岐ロジックは**削除しない**。
- `FeedCard` 型（`src/lib/types.ts:130-161`）から `topicAnchor` / `rationaleText` /
  `usefulness` / `aiSummary` フィールド自体を削除するかどうかは §7 Stage 2 で判断する
  （UI コンポーネントの利用箇所が消えても、型・DTO はゲート判定のサーバ側ロジックが
  参照し続ける可能性があるため、フィールド削除は型定義とサーバ側ロジックの依存関係を
  再確認したうえで行う。安全側に倒すなら「型は残し、コンポーネントで使わないだけ」に
  留める判断もありうる。この判断は Stage 2 で明示的に記録すること）。

**spec.md の改訂内容**: §9.9 の以下の一文を書き換える。

- before: 「描画は判定根拠（`topicAnchor`/`rationaleText`）を優先し、無ければ
  `aiSummary` にフォールバックする（`src/components/feed/feed-card.tsx`）。」
- after: 「判定根拠（`post_rationales` 行）の存在は掲載可否の条件としてのみ用い、
  `topicAnchor`/`rationaleText`/`aiSummary` はいずれも公開面には描画しない
  （`src/components/feed/feed-card.tsx`）。」

---

## 6. 影響範囲

| パス                                          | 変更内容                                                                                                                                                                                                                                          | 担当レーン                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `src/components/feed/feed-card.tsx`           | `Summary()` 全廃、`Media()`/`Thumbnail()`/`FallbackTile()` 全廃。`FeedCardVariant` の統合可否・visual/editorial の描き分け方法を再設計。`lucide-react` の `ImageOff`/`Sparkles` import 削除（`Flame`/`Landmark`/`ExternalLink`/`Badge` 等は維持） | `@designer`                       |
| `src/components/feed/sns-embed.tsx`           | 公開面から未使用になる。ファイル削除 or 休眠のいずれかを Stage 2 で判断（§6-1参照）                                                                                                                                                               | `@fixer`（判断は Stage 2 で確定） |
| `src/components/feed/feed-lane-trend.tsx`     | header 文言「SNS で見つかった『今』の投稿を、AI要約と元投稿へのリンクでまとめました。」が `aiSummary` 廃止後に事実と乖離するため文言見直しが必要                                                                                                  | `@designer`                       |
| `src/components/feed/feed-lane-classic.tsx`   | header 文言「...AI要約と元記事へのリンクでまとめました。」も同様に見直しが必要                                                                                                                                                                    | `@designer`                       |
| `src/lib/types.ts:130-161`                    | `FeedCard` 型から UI 未使用となるフィールドの扱いを検討（§5 参照。削除するか残すかは Stage 2 で確定）                                                                                                                                             | `@fixer`                          |
| `next.config.ts`                              | `images.remotePatterns`（10-27行）は現状 `next/image` 未使用のため既に死んでいる設定。画像を公開面から外す本プランでは実質的な影響なし。削除するかは任意判断（Stage で決定）                                                                      | `@fixer`                          |
| `src/app/api/submit-url/route.ts`             | 公開フィードではなく投稿フォーム用 API。`card`（`thumbnailUrl` 含む）を返すレスポンス自体は投稿確認用途のため変更不要と判断（Stage で再確認）                                                                                                     | `@fixer`（確認のみ）              |
| `src/components/admin/submit-url-form.tsx:22` | 「thumbnail すべて欠落」というコメントの整合性を確認。`/admin` は公開面ではないため変更対象外の可能性が高いが Stage で確認                                                                                                                        | `@fixer`（確認のみ）              |
| `openspec/specs/wedding-trend/spec.md`        | §9.9 の描画に関する記述を改訂（§5参照）。§10 に画像転載しない方針を新規追記（§1-3参照）                                                                                                                                                           | `@fixer`                          |
| テスト                                        | `tests/publish-gate.test.ts` 等 rationale 生成系テストは維持（射程はUIのみ）。`tests/ogp.test.ts`/`tests/feed-parser.test.ts`/`tests/sources-and-embed.test.ts` 等の取得系テストは変更不要と推定（要確認・Stage で再確認）                        | `@fixer`（確認・必要時更新）      |

### 6-1. feed-card.tsx のコンポーネントテストについて

`tests/` ディレクトリを確認したところ、`feed-card.tsx` を直接レンダリングして検証する
コンポーネントテストは**存在しない**（`tests/feed-order-parity.test.ts` と
`tests/pipeline-submit-url.test.ts` は `FeedCard` 型を扱うが DOM レンダリングの
テストではない）。したがって本プランに「既存 feed-card テストの更新」Stage は不要。

---

## 7. 段階設計

各ステージ末に検証ゲート（lint / type-check / vitest / coverage tiers / spec-refs /
smoke-test）を明記する。

### Stage 0: 前提確認

- 範囲: `git status --short` を実行し、未コミット差分（`spec.md`/`constants.ts`/
  `prompts.ts`）が本プランの変更と無関係であることを再確認する。無関係であれば、
  本プランの変更に含めない（別コミットのまま残す）。
- 完了判定: 未コミット差分が本プラン外であることを確認する。
- 検証ゲート: なし（調査のみ）。

### Stage 1: `@designer` によるカード再設計

- 範囲: `src/components/feed/feed-card.tsx` の `Summary()`/`Media()`/`Thumbnail()`/
  `FallbackTile()` を全廃し、§3 の before-after 構造に沿ってカードを再構築する。
  `FeedCardVariant`（`"visual"`/`"editorial"`）を統合するか、別の視覚差（余白・
  タイポグラフィ階層・境界線・バッジ配色）で速報レーン/定番レーンを描き分けるかを
  designer が判断する。`Footer()` は変更しない。`lucide-react` の `ImageOff`/
  `Sparkles` import を削除する。
- 完了判定: `Summary()`/`Media()`/`Thumbnail()`/`FallbackTile()` 関数がファイルに
  存在しないことを確認する。カードが「カテゴリ/トレンド・定番バッジ」「タイトル」
  「出典・著者・日時」「原文リンクCTA」の4要素のみで構成されていることを確認する。
- 検証ゲート: lint / type-check。

### Stage 2: 型・データ層の整理判断

- 範囲: `src/lib/types.ts` の `FeedCard` 型から UI 未使用フィールド
  （`topicAnchor`/`rationaleText`/`usefulness`/`aiSummary`）を削除するか残すかを
  判断し確定する。削除する場合、`src/lib/db/query.ts` のサーバ側ロジック
  （掲載可否判定・並び順キー算出）がこれらのフィールド自体ではなくDBの生の値
  （`postRationales` の行の有無等）だけを参照していることを確認してから行う。
  `src/components/feed/sns-embed.tsx` をファイル削除するか休眠のまま残すかを判断する。
- 完了判定: 型定義の変更方針（削除する/しないそれぞれの理由）が記録されていること、
  `sns-embed.tsx` の扱いが決定されていることを確認する。
- 検証ゲート: lint / type-check。

### Stage 3: `@designer` によるレーン文言見直し

- 範囲: `feed-lane-trend.tsx`/`feed-lane-classic.tsx` の header 説明文
  （「AI要約と...でまとめました」）を、`aiSummary` 非表示後の実態に合わせて見直す。
  視覚・操作の意図を保ったまま文言変更を行う（AGENTS.md の規定通り、コピー自体は
  Orchestrator が最終レビューする）。
- 完了判定: 両レーンの header 文言が「AI要約」に言及していないことを確認する。
- 検証ゲート: lint / type-check。

### Stage 4: `next.config.ts` / API / admin フォームの後始末確認

- 範囲: `next.config.ts` の `images.remotePatterns` を削除するか残すかを判断する
  （現状 `next/image` 未使用のため実害はないが、死んだ設定として整理する選択肢も
  ある）。`src/app/api/submit-url/route.ts` のレスポンスと
  `src/components/admin/submit-url-form.tsx:22` のコメントを確認し、公開面と無関係
  （`/admin` 専用）であることを再確認する。
- 完了判定: `next.config.ts` の扱いが決定され、admin 側の変更不要判断が記録されて
  いることを確認する。
- 検証ゲート: lint / type-check。

### Stage 5: spec.md 改訂

- 範囲: §9.9 の該当文を§5の書き換え内容に更新する。§10 に「外部サイトの画像を
  公開面に転載しない」方針を新規に明文化する。§5 データモデルの `thumbnail_url`
  説明・§9.9 の記述との整合を確認する。
- 完了判定: `scripts/check-spec-update.sh` が警告を出さないことを確認する。
- 検証ゲート: spec-refs。

### Stage 6: テスト確認・更新

- 範囲: `tests/publish-gate.test.ts` 等 rationale 生成系テストが無変更で緑であること
  を確認する。`tests/ogp.test.ts`/`tests/feed-parser.test.ts`/
  `tests/sources-and-embed.test.ts` 等取得系テストが無変更で緑であることを確認する
  （射程がUIのみのため）。Stage 2 で型を変更した場合、型エラーになるテストファイル
  があれば更新する。
- 完了判定: `pnpm exec vitest run` が全件通過することを確認する。
- 検証ゲート: vitest / coverage tiers。

### 全体検証ゲート

- lint（`pnpm exec eslint .` 相当）が通過することを確認する。
- type-check（`pnpm exec tsc --noEmit`）が通過することを確認する。
- vitest が全件通過することを確認する。
- coverage tiers が既存基準を満たしていることを確認する。
- spec-refs（`scripts/check-spec-update.sh`）が警告を出さないことを確認する。
- smoke-test（`pnpm run dev` 等での実画面確認）でフィードカードが4要素構成で表示
  され、原文リンクが機能することを確認する。

---

## 8. `shared_plan/12` との関係（12 のコード実装は完了済み）

**本節は初版から全面的に書き直した。** 初版執筆時点では `shared_plan/12` は
未着手として扱ったが、その後（本文書の作業中〜直後に）別セッションまたは
ユーザー本人により **12 のコード実装は完了しコミット済み**であることが判明した。

`git log --oneline -3` で確認した現状:

```
4f24fe4 chore(golden-set): relabel tradeoff -> weddingDayContent (38 items)
0305f67 fix(backfill): write weddingDayContent instead of stale tradeoff key
c75d460 refactor(curation)!: replace tradeoff axis with weddingDayContent
```

`c75d460` の変更ファイル（25 files, +128/-123）には
`openspec/specs/wedding-trend/spec.md` / `src/components/feed/feed-card.tsx` /
`src/lib/constants.ts` / `src/lib/db/{query,schema}.ts` / `src/lib/llm/{batch,
prompts,schemas}.ts` / `src/lib/pipeline/{discovery-ingest,evergreen,ingest}.ts` /
`src/lib/publish/gate.ts` / `src/lib/scoring/usefulness.ts` / テスト12件が含まれる。
`src/lib/constants.ts:60` は `CURATION_PROMPT_VERSION = 7` に bump 済み。

### 8-1. 「13 を先に実行すれば 12 の Stage 6 が不要になる」という初版の推奨順序は意味を失った

初版は「13 を先に実行すれば 12 の feed-card.tsx バッジ改修（Stage 6）を
丸ごと省略できる」という順序を推奨していたが、**Stage 6 はすでに実行済み**
（`c75d460` に含まれる、`feed-card.tsx` の約6行の変更）である。したがって
この順序の議論はもはや意味を持たない。**13 の Summary ゾーン廃止を実行すると、
Stage 6 で行われたバッジのプロパティ名・文言変更（`card.usefulness.tradeoff`
→ `card.usefulness.weddingDayContent`、バッジ文言の差し替え）は丸ごと削除
対象になる。** 既に払われたその変更コストは無駄になるが、これは悔やむべき
ことではなく、単純な事実として記録するに留める。

### 8-2. 12 の残タスク判定

`shared_plan/12-wedding-day-content-criterion.md` §8 の完了判定チェックリスト
（本文書執筆時点でチェックボックスはすべて `[ ]` の未着手のまま）と、実際の
コミット内容を突き合わせた判定は次の通り。

| 12 の Stage（§8 チェックリスト）                            | 判定                                              | 根拠                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 0: 前提の未コミット差分の分離コミット                 | 完了                                              | `da1c0d3`（`promotional` 厳格化・v6 bump）として別コミット済み                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stage 1: プロンプト文言の `@oracle` レビュー                | 完了（推定）                                      | `c75d460` コミットメッセージに「oracle-reviewed wording」と明記                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Stage 2: `grep tradeoff` 0件・`tsc --noEmit` 通過           | 完了（推定）                                      | `grep -rn "tradeoff" src/` の実行結果、`UsefulnessCriteria`/`CurationItemSchema`/`RationaleUsefulnessFlags` 等のフィールドとしての `tradeoff` 参照は0件。ヒットしたのは `src/lib/db/migrations/0002_dry_forge.sql` と `meta/0002_snapshot.json`（過去マイグレーションの履歴的スナップショットであり無関係）のみ                                                                                                                                                                                                        |
| Stage 3: パイプライン受け渡し経路の確認                     | 完了                                              | `c75d460` に `pipeline/{discovery-ingest,evergreen,ingest}.ts` の変更が含まれる                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Stage 4: テスト更新・vitest 全件通過                        | 完了（推定）                                      | `c75d460` にテスト12件の変更が含まれる。実行結果自体は未確認（要確認）                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Stage 5: spec.md §9.3 更新                                  | 完了                                              | `c75d460` に `spec.md` の変更（19行）が含まれる                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Stage 6: feed-card.tsx バッジ改修（`@designer` レーン）     | 完了（ただし13により捨てられる）                  | `c75d460` に `feed-card.tsx` の6行変更。§8-1参照                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Stage 7: ゴールデンセット38件の再ラベリング                 | 完了                                              | `4f24fe4`「relabel tradeoff -> weddingDayContent (38 items)」。`tests/golden-set/corpus.json`・`label-schema.md` を含む                                                                                                                                                                                                                                                                                                                                                                                                |
| Stage 8: `CURATION_PROMPT_VERSION` bump・全件再スコアリング | bump は完了／**全件再スコアリングの完了は要確認** | `constants.ts:60` で v7 への bump は確認済み。`0305f67`「fix(backfill): write weddingDayContent instead of stale tradeoff key」は、backfill スクリプトが `tradeoff` を書き続けるバグを修正したコミットであり、**このバグ修正コミットの存在自体が「バグを含んだ状態で一度 backfill が実行され、不正なデータが書かれた」ことを示唆する**。修正後に正しい内容で全件再実行されたかどうかは、コミットログ・スクリプトの存在だけからは判断できない（本番DBへの問い合わせは本プランの制約により実行しない）。**要確認**とする |

### 8-3. 13 の 12 に対する依存関係（現状ベース）

`renderRationaleText()` および `USEFULNESS_LABELS` / `FLAG_ORDER`
（`src/lib/publish/gate.ts:236-322`）は、12 のリネーム後は `weddingDayContent`
を扱う形にすでに更新されている。本プラン13は §4・§5 の通りこれらを
**内部生成物として維持する**方針のため、12 の `gate.ts` 側の成果（ラベル
置換）は13の実行後も無駄にならず、そのまま活きる。13が不要化するのは
§8-1で述べた **12 の Stage 6（feed-card.tsx の UI バッジ改修）のみ**であり、
12 の他の Stage（プロンプト・スキーマ・スコア計算・ゴールデンセット・
再スコアリング等）は13の実行と無関係に必要な作業として、既に実施済みか
今後も独立して完結する。

本プランは `shared_plan/12-wedding-day-content-criterion.md` を読むのみで、
一切書き換えない。

### 8-4. `shared_plan/12` 側への申し送り

`shared_plan/12-wedding-day-content-criterion.md` の状態欄は「未着手」の
まま、§8 完了判定チェックリストもすべて `[ ]`（未チェック）のままだが、
実際にはコード実装（Stage 0〜7、Stage 8 の bump 部分）はコミット済みである。
**この不整合は本文書からは修正できない（12 は読むだけで書き換え禁止のため）。
12 の状態欄・チェックリストは 12 の側で実装完了を反映するよう更新が必要。**

---

## 9. 完了判定

- [ ] `Summary()`/`Media()`/`Thumbnail()`/`FallbackTile()` が
      `src/components/feed/feed-card.tsx` に存在しないことを確認する
- [ ] カードが「カテゴリ/トレンド・定番バッジ」「タイトル」「出典・著者・日時」
      「原文リンクCTA」の4要素のみで構成されていることを確認する（`@designer` の
      成果物）
- [ ] `Footer()`（著作者クレジット・原文リンク）が変更されていないことを確認する
- [ ] `postRationales` への `leftJoin`・`RATIONALE_DISPLAY_PHASE` 分岐・
      `renderRationaleText()` が `src/lib/db/query.ts`・`src/lib/publish/gate.ts` に
      無変更で残っていることを確認する
- [ ] `posts.thumbnailUrl` カラム・OGP/RSS/oEmbed の画像URL取得・保存ロジックが
      無変更で残っていることを確認する
- [ ] `openspec/specs/wedding-trend/spec.md` §9.9 が書き換えられ、§10 に画像転載
      しない方針が新規追記されていることを確認する
- [ ] `sns-embed.tsx` の扱い（削除/休眠）が判断され記録されていることを確認する
- [ ] レーン header 文言から「AI要約」への言及が消えていることを確認する
- [ ] lint / type-check / vitest / coverage tiers / spec-refs / smoke-test が
      すべて通過していることを確認する

---

## 10. リスク

| リスク                                                                                                                     | 影響                                                                                                       | 対処                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| rationale だけ消して `aiSummary` フォールバックを残す実装ミス（§1-1の罠）                                                  | 法務上むしろ後退する（要約形式のゼロクリック化・翻案リスク）                                               | Stage 1 完了判定で `Summary()` 関数自体が存在しないことを機械的に確認する                                                                       |
| 掲載可否ゲート（`RATIONALE_DISPLAY_PHASE`・`leftJoin`）を「UIで使わないから」と誤って削除する                              | 公開判定ロジックが壊れ、想定外の投稿が公開/非公開になる                                                    | §5 を Stage 2 の判断基準として明示し、削除しないことを完了判定に含める                                                                          |
| メディア領域全廃によりフィード全体の視覚的印象が大きく変わる（特に上段レーンはメディアが視覚アイデンティティの中核だった） | ユーザー体験の急激な変化、ブランド一貫性の喪失リスク                                                       | `@designer` に Stage 1 を委譲し、視覚差の再設計を任せる。orchestrator/`@fixer` が独断でレイアウトを決めない                                     |
| `FeedCard` 型のフィールド削除判断を誤り、サーバ側ロジックが暗黙に依存していたフィールドを消してしまう                      | 型エラーにならない実行時バグ（例: 並び順キー算出の欠落）                                                   | Stage 2 で `src/lib/db/query.ts` の依存関係を確認してから判断し、安全側（型は残す）を既定とする                                                 |
| `shared_plan/12` の Stage 6（feed-card.tsx バッジ改修）は既に実装済みで、13の実装によりその変更が丸ごと削除される          | 既に払われた実装コストが無駄になる（§8-1）                                                                 | §8-1で事実として記録済み。13実装時、`feed-card.tsx` の diff に `weddingDayContent` バッジ関連の削除が含まれることを実装者が認識したうえで進める |
| 12 の Stage 8（全件再スコアリング）の完了有無が未確認のまま13を実装する                                                    | 13はデータ層を変更しないため直接の影響はないが、13完了報告時に12の状態を誤って「完了」と扱ってしまうリスク | §8-2の「要確認」区分を維持し、DBクエリでの確認が必要な旨をユーザー/次の担当者に申し送る                                                         |

---

## 11. 意図的に採用しないもの

| 禁止事項                                                        | 排除理由                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aiSummary` フォールバックだけ残す案（rationale 描画のみ削除）  | ユーザー決定事項1「Summary ゾーンごと廃止」に反する。§1-1 の通り、要約形式は本プロジェクトが既に転換済みのゼロクリック化・翻案リスクのある形式であり、これを公開面の唯一の内容表示として復活させることは法務上の後退になる |
| SNS 埋め込み（`SnsEmbed`）だけ残す案（画像サムネイルのみ廃止）  | ユーザー決定事項3「SNS 埋め込みも含めてメディア領域を全廃する」に反する。埋め込みも画像同様に第三者コンテンツの転載であり、法務上の扱いを画像と分離する理由がない                                                          |
| `thumbnail_url` カラムを物理削除する案                          | ユーザー決定事項2「削除の射程はUI表示のみ」に反する。データ層・パイプラインは変更しない方針であり、カラム削除は `ALTER TABLE` を伴う不可逆な変更で本プランの射程を超える                                                   |
| `renderRationaleText()` によるrationale生成そのものを停止する案 | ユーザー決定事項2に反する。rationale は§5の通り掲載可否ゲートとして機能し続けるため、生成を止めると公開判定ロジックが壊れる                                                                                                |

---
