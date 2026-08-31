# 14. topicAnchor・有用度バッジ・表題3行化を復活させ、表題の改行を正規化する

- 対象: `wedding-trend`（本プロジェクト）
- 参照: `shared_plan/13-remove-rationale-display-and-media-zone.md`（本プランはこの実装後の揺り戻し。§1 参照）
- 作成日: 2026-08-27
- 前提コミット: `1f0b16a` `refactor(feed): remove public rationale summary and media zones`
  （`git log -1 --format='%h %s'` で確認。`shared_plan/13` の計画はこのコミットで実装済み）。
  作業ツリーはクリーン（`git status --short` の出力は未追跡の `shared_plan/12-*.md` と
  `shared_plan/14-*.md` の2件のみ。`shared_plan/13-*.md` は `1f0b16a` に含めてコミット済み）
- 状態: **実装済み**。成果は現行コードに存在する（`src/components/feed/feed-card.tsx` の
  topicAnchor 表示・有用度ラベル・`line-clamp-3`）。2026-08-31 に archive へ移設した際、
  状態行が未更新のままだったため訂正した。

---

## 1. 変更の意図

`shared_plan/13` はオーナーの決定に基づき、公開カードから Summary ゾーン（`topicAnchor` /
`rationaleText` / 有用度バッジ / 「自動判定」バッジ / `aiSummary` フォールバック）と
メディア領域を丸ごと除去した。実装は `1f0b16a` で完了済みであり、現在のカードは
「カテゴリ/トレンド・定番バッジ → タイトル（`line-clamp-2`）→ 出典/著者/日時＋原文CTA」
の4要素のみで構成されている。

本プランは、13 で削ぎ落としすぎた分の**揺り戻し**である。オーナーは13の全廃を撤回した
わけではなく、次の4点に限定して要素を戻すことを決定した。

1. `topicAnchor`（40字以内の話題アンカー）のみを公開面に復活。`rationaleText` と
   `aiSummary` は引き続き非表示のまま。
2. 有用度バッジのうち**肯定的な4種**（`firsthand` / `ceremonyDecision` / `specific` /
   `weddingDayContent`）のみを復活。`preDecisionOrPhotoShoot` は復活させない。
3. タイトルの表示行数を `line-clamp-2` → `line-clamp-3` に拡張。
4. タイトルに稀に生じる「謎の改行」を、表示時の対症療法ではなくデータ取得時の
   正規化で恒久的に解消する。

13 が「Summary ゾーンを丸ごと消す」という一つの決定だったのに対し、本プランは
「Summary ゾーンの構成要素のうち何を戻すか」という選別の決定であり、13 の判断
（`aiSummary` フォールバックの罠・メディア領域の全廃・掲載可否ゲートの維持）を
覆すものではない。13 が確立した制約（§5「rationale は掲載可否ゲートを兼ねる」・
§1-3「画像は公開面に転載しない」）は本プランでも維持する。

---

## 2. 現状の公開面（`1f0b16a` 後）

`src/components/feed/feed-card.tsx`（2026-08-27 時点、全98行）の構造は次の通り。

- `FeedCard()`（1-54行目）: カテゴリ/トレンド・定番バッジ → `Title()` → `Footer()`。
  `Media()`/`Thumbnail()`/`Summary()` はファイルに存在しない。
- `Title()`（56-68行目、逐語）:

```tsx
function Title({ card, variant }: { card: FeedCardData; variant: FeedCardVariant }) {
  return (
    <h3
      className={cn(
        "font-display leading-jp-heading tracking-jp-heading text-balance text-[var(--color-foreground)]",
        variant === "visual" ? "text-[17px] font-semibold" : "text-[15px] font-semibold",
        "line-clamp-2",
      )}
    >
      {card.originalTitle}
    </h3>
  );
}
```

- `Footer()`（70-98行目）: 出典名・著者・公開日時＋原文リンク CTA。**本プランでは
  変更しない**（13 §2-4 の位置づけを継続する）。
- import は `ExternalLink` / `Flame` / `Landmark` / `Badge` / `Button` / `Card` のみ。
  `Sparkles` や `ImageOff` は 13 で既に削除済み。

---

## 3. 変更後の公開面

```
before（現状。1f0b16a 後）              after（本プラン適用後・構造イメージ）
┌───────────────────────┐          ┌───────────────────────┐
│ [カテゴリ][トレンド]          │          │ [カテゴリ][トレンド]          │
│ 記事タイトル（逐語・2行まで）    │          │ 記事タイトル（逐語・最大3行）    │
│ ─────────────────── │          │ topicAnchor（1行程度のひと言）  │
│ 出典名・著者・公開日時  [原文を見る→]│          │ [肯定的有用度バッジ 0〜4個]     │
└───────────────────────┘          │ ─────────────────── │
                                       │ 出典名・著者・公開日時  [原文を見る→]│
                                       └───────────────────────┘
```

`topicAnchor` の有無・バッジの個数（0〜4個、有用度6項目のうち肯定的4種で true の
ものだけ）に応じたカードの伸縮、visual/editorial 2バリアントでの余白・配色・
タイポグラフィ階層の描き分けは視覚的判断であり、`@designer` に委ねる。上図は
構造の目安であり、最終的なレイアウトを規定するものではない。

---

## 4. 4つの変更の詳細

### 4-1. `topicAnchor` の復活

- 描画対象は `topicAnchor` **のみ**。`rationaleText` と `aiSummary` は非表示のまま
  維持する（13 §1-1 の「`aiSummary` フォールバックの罠」の教訓を継続する。
  `hasRationale` 分岐を安易に復元し `aiSummary` フォールバックまで一緒に復活させる
  実装は誤りである）。
- 生成・保存は現在も継続している。`src/lib/db/query.ts` の `FEED_ROW_FIELDS`
  （23-45行目付近）は次の通り既に `topicAnchor: postRationales.topicAnchor` を
  SELECT 済みであることを確認した（`src/lib/db/query.ts:39`）。

  ```ts
  topicAnchor: postRationales.topicAnchor,
  rationaleText: postRationales.rationaleText,
  ```

  `getFeedCards()`（133行目〜）の返り値組み立て（223-224行目）も
  `topicAnchor: row.topicAnchor ?? null` を既に含む。**新規の生成処理・クエリ変更は
  不要であり、`feed-card.tsx` 側で表示を戻すだけでよい。**

- `src/lib/types.ts:156` の `FeedCard.topicAnchor: string | null` はフィールドとして
  既に存在する（13 Stage 2 で削除しない判断がなされていたことを確認した）。
- 制約: `openspec/specs/wedding-trend/spec.md:744`（§10-3）が定める「40字以内・
  トピックのアンカーであって結論のアンカーであってはならない」制約は据え置き。
  この制約はプロンプト（`src/lib/llm/prompts.ts` の `RATIONALE_RULES`）でのみ
  指示され、文字数以外は機械的検証を持たない、という既存の限界も変わらない。

### 4-2. 有用度バッジ（肯定的4種のみ）の復活

- 復活対象: `firsthand`（当事者本人）/ `ceremonyDecision`（意思決定に効く）/
  `specific`（具体的）/ `weddingDayContent`（結婚式当日の内容）の4種。
- 復活させない対象: `preDecisionOrPhotoShoot`（式場決定前・撮影段階）。
  spec.md §10-3（`openspec/specs/wedding-trend/spec.md:750`、逐語）は次の通り
  この項目を意図的な残置として整理しているが、**本プランはこの整理を UI 復活の
  可否には適用しない**——理由は次の通り。

  > `preDecisionOrPhotoShoot` は対象外（意図的な残置）: 「式場決定前の段階や
  > 前撮り・後撮りに関する話題が中心である」というラベルは、上記の削除対象に
  > 含めず根拠文に残した。これは記事の質に対する否定的評価ではなく、話題の
  > 分類という事実の言明であり、読者にとってはむしろ有用な分類情報であるため、
  > 本項冒頭の「否定的評価は公開画面に一切出さない」の適用範囲には含めない、
  > という整理をとった。

  この一文は「`renderRationaleText()`（根拠文テキスト）からの削除対象ではない」
  という文脈での整理であり、**UI バッジとして公開画面に出すかどうかとは別の
  判断**である。オーナーは今回「肯定的4種のみ」を明示的に選択しており、
  `preDecisionOrPhotoShoot` は事実分類ではあってもポジティブな評価軸ではない
  （4種はいずれも「役に立つ」方向の言明だが、これは中立的な分類軸であり、
  他の4種と並べて公開すると相対的にネガティブなニュアンスを帯びうる）。
  §9.8（スコア非公開方針）・§10-3（否定的評価非公開の原則）の精神——公開面には
  「評価」に転じうる情報を極力出さない——との整合を優先し、本プランでは
  `preDecisionOrPhotoShoot` を UI バッジ対象から除外する。

- `promotional` はバッジ対象外（既存の判断であり、本プランで変更しない）。
  `src/lib/publish/gate.ts:256-262` の `USEFULNESS_LABELS` は次の通り
  `promotional` を含まない5キー構成であり（`firsthand` / `ceremonyDecision` /
  `specific` / `weddingDayContent` / `preDecisionOrPhotoShoot`）、`FLAG_ORDER`
  直前のコメント（`src/lib/publish/gate.ts:265-267`、逐語）は次の通り明記する。

  > `promotional` は spec.md §10-3（否定的評価を公開画面に一切出さない）に
  > より根拠文のラベル対象から除外する。`RationaleUsefulnessFlags` には
  > フィールドとして残るが、ここでは参照しない。

  したがって本プランのバッジ復活対象4種は `USEFULNESS_LABELS` の5キーから
  `preDecisionOrPhotoShoot` を除いたものと一致する。

- 文言・配置: `1f0b16a^:src/components/feed/feed-card.tsx` の旧 `Summary()`
  （§1-1 参照）にあった文言・配置構成を出発点にしてよいが、そのまま復元する
  ことを前提にしない。文言と配置はデザイン判断であり `@designer` レーンに
  委ねる。「自動判定」バッジ（`variant="ai"`）の扱いは §7 で独立の論点として
  提起する（本節の4バッジとは別の判断軸）。
- データソース: `FeedCard.usefulness: UsefulnessCriteria | null`
  （`src/lib/types.ts:160`）は `getFeedCards()` が既に返している。新規の
  クエリ変更は不要。

### 4-3. 表題を最大3行に

- `src/components/feed/feed-card.tsx:62` の `Title()` 内 `"line-clamp-2"` を
  `"line-clamp-3"` へ変更する。単独では機械的な1行差分だが、次の付随判断は
  視覚的判断を伴うため `@designer` レーンとする。
  - カード高さ・グリッド内での縦位置の揃い（3行タイトルと1行タイトルが
    同一グリッド行に並ぶ場合の高さ不揃い）への対処。
  - `text-balance`（`src/components/feed/feed-card.tsx:60`）の3行時の折り返し
    挙動の再評価（§5-4 で述べる改行問題の切り分けと合わせて判断する）。
  - `variant`（`"visual"` / `"editorial"`）で行数を変える必要があるか
    （現状は両バリアント共通で `line-clamp-2`。3行化を両方に適用するか、
    どちらか一方のみにするかは `@designer` の判断対象とする）。

### 4-4. 表題の「謎の改行」を消す（正規化の新設＋既存 backfill）

詳細な原因分析は §5、Stage 設計は §8 Stage 4〜6 を参照。

---

## 5. 表題の改行問題の原因分析

### 5-1. データ側: タイトルに対する空白正規化が実装のどこにも存在しない

本文（excerpt）用の正規化関数 `stripHtml()`（`src/lib/sources/base/feed-parser.ts:49-55`、
逐語）は次の通り改行・連続空白の圧縮と `trim()` を行う。

```ts
/** HTML タグを除去し、連続する空白を 1 個にまとめ、前後をトリムする。 */
export function stripHtml(html: string): string {
  if (!html) return "";
  const withoutTags = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}
```

一方タイトルは `decodeEntities()`（同ファイル34-46行目、逐語）しか通らない。

```ts
/** 数値文字参照・主要な名前付きエンティティをデコードする。 */
export function decodeEntities(input: unknown): string {
  const str = typeof input === "string" ? input : getText(input);
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
```

`decodeEntities()` はエンティティ展開のみを行い、空白・改行には一切触れない。
`stripHtml()` の `\s+` → 半角スペース1個への圧縮＋`trim()` に相当する処理が
タイトル側には存在しないという非対称が、この問題の根本原因である。

### 5-2. タイトル取得経路の一覧（すべて確認済み）

| ファイル:行                                        | 経路                                                            | 適用される処理                                                                                                  | 改行除去                                                         |
| -------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/lib/sources/base/feed-parser.ts:154`          | RSS2/RDF `<item><title>`                                        | `decodeEntities(item.title)`                                                                                    | なし                                                             |
| `src/lib/sources/base/feed-parser.ts:183`          | Atom `<entry><title>`                                           | `decodeEntities(entry.title)`                                                                                   | なし                                                             |
| `src/lib/sources/google-news.ts:53,56`             | Google News RSS                                                 | `rawTitle = decodeEntities(item.title)` → `stripSourceSuffix(rawTitle, sourceName)`                             | なし（`stripSourceSuffix` は末尾のソース名サフィックス除去のみ） |
| `src/lib/sources/ogp.ts:109-111`                   | HTML `<title>` タグ                                             | `decodeHtmlEntities(titleMatch[1].trim())`                                                                      | `trim()` のみ。内部改行は残る                                    |
| `src/lib/sources/ogp.ts:126,128`                   | `og:title` メタタグ                                             | `decodeHtmlEntities(contentMatch[2].trim())`                                                                    | `trim()` のみ。内部改行は残る                                    |
| `src/lib/embed/oembed.ts:61`                       | oEmbed レスポンス `title`                                       | `typeof data.title === "string" ? data.title : null`                                                            | なし（`trim()` すら無い）                                        |
| `src/lib/pipeline/discovery-ingest.ts:625,663,708` | `extractHtmlTitle` / `extractArticleHeadline` → `originalTitle` | （`extractHtmlTitle`/`extractArticleHeadline` の実装は別ファイル。要個別確認——本プランでは Stage 4 で確認する） | 未確認                                                           |

### 5-3. XML パーサ設定

`fast-xml-parser` の `XMLParser` は `src/lib/sources/base/feed-parser.ts:4-8` で
次の通り設定されている。

```ts
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});
```

`trimValues` は未指定＝デフォルト `true` だが、これは**ノード前後の空白のみ**を
トリムする挙動であり、pretty-print された複数行 `<title>\n  記事タイトル\n</title>`
のようなケースの**内部**改行は残る。

### 5-4. 決定的傍証: `CONTROL_CHAR_RE` はタブ・改行を意図的に許容している

`src/lib/publish/gate.ts:54-56`（逐語）:

```ts
/** 制御文字（タブ・改行は許容し、その他の C0/C1 制御文字・DEL を検知）。 */
// oxlint-disable-next-line no-control-regex -- 制御文字の検知そのものが目的で意図的。
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
```

このレンジは `\t`（U+0009）と `\n`（U+000A）を意図的に除外している
（`\u0000-\u0008` で止め、`\u000B` から再開）。`filterTitle()`
（`src/lib/publish/gate.ts:74-95`）はこの正規表現でタイトルを検査するが、
改行入りタイトルはこのチェックを通過して保存される。つまり改行入りタイトルは
「見落とし」ではなく、**「タブ・改行は許容する」という設計意図の下で公開ゲートを
通過するよう作られていた**ことが、このコメント付き正規表現から読み取れる。

### 5-5. CSS 側は原因ではない（ただし折り返しへの影響はありうる）

`src/components/feed/feed-card.tsx` を確認したが、`whitespace-pre` 系の指定は
無く、`Title()` の `<h3>` は既定の `white-space: normal` で描画される。CSS の
`normal` では `\n` は通常の空白として扱われ、レンダリング上は詰まって見える
はずである。したがって「改行文字がそのまま改行として描画される」ことは
CSS 側の原因ではない。

ただし、`\n` が空白1個として扱われることで**本来区切りの無い位置に空白が
生まれ**、その空白が `text-balance`・`line-clamp` の折り返し計算に影響し、
「不自然な位置での改行」に見える一因になりうる。これはデータ側の異常
（意図しない空白の混入）が原因であり、CSS 側の挙動はその症状を増幅している
だけ、という切り分けである。**`text-balance` を外すか否かは、データ側の
正規化を実装した後に再評価する `@designer` 判断とする**（正規化前に CSS だけ
弄っても根本原因は残るため、対症療法が先行しないよう順序を明記する）。

### 5-6. テストカバレッジの欠落

`tests/feed-parser.test.ts` を確認したところ、改行入りタイトルを検証する
テストケースは存在しない（12・14・25・27・38・41・51・53行目のタイトル
フィクスチャはいずれも単一行）。**この経路は現状テストで一切カバーされて
いない。**

---

## 6. spec.md §9.9 再改訂と §9.8 / §10-3 との整合

### 6-1. 矛盾の所在

`1f0b16a` は spec.md §9.9（`openspec/specs/wedding-trend/spec.md:711`）を次の
一文に書き換えた（逐語）。

> 判定根拠（`post_rationales` 行）の存在は掲載可否の条件としてのみ用い、
> topicAnchor/rationaleText/aiSummary はいずれも公開面には描画しない
> （`src/components/feed/feed-card.tsx`）。

本プランで `topicAnchor` と肯定的有用度4種のバッジを復活させると、この一文
（「いずれも公開面には描画しない」）と正面から矛盾する。**§9.9 の再改訂は
必須であり、実装 Stage の一部としてではなく spec.md 更新義務（AGENTS.md）
として明記する。**

### 6-2. 改訂後の文案

```diff
- 判定根拠（`post_rationales` 行）の存在は掲載可否の条件としてのみ用い、topicAnchor/rationaleText/aiSummary はいずれも公開面には描画しない（`src/components/feed/feed-card.tsx`）。
+ 判定根拠（`post_rationales` 行）の存在は掲載可否の条件として用いる。加えて `topicAnchor`
+ と有用度判定のうち肯定的4種（`firsthand`/`ceremonyDecision`/`specific`/`weddingDayContent`）
+ は公開面に描画する。`rationaleText`・`aiSummary`・否定的または中立的な判定
+ （`preDecisionOrPhotoShoot`・`promotional`）はいずれも公開面には描画しない
+ （`src/components/feed/feed-card.tsx`）。
```

### 6-3. §9.8（スコア非公開）との整合

§9.8（`openspec/specs/wedding-trend/spec.md:688-694`）は「有用度スコアは
ページ上の一般公開面には表示しない」「点数そのものの公表は評価行為であり、
本プロジェクトのスコープ外」と定める。本プランが復活させるのは**点数
（スコア・順序を決める数値）ではなく、判定項目という質的なラベルの提示**
である。「当事者本人の記述である」「具体的な選択の記述がある」という
バッジは、記事のどこが読者にとって参照価値を持つかを示す分類情報であり、
複数記事間の優劣を数値で比較可能にするものではない。したがって§9.8の
禁止対象（点数の公表）には該当しないという整理を取る。

### 6-4. §10-3（否定的評価非公開）との整合

§10-3（`openspec/specs/wedding-trend/spec.md:727`、判定テストの一文）は
「否定的評価（`promotional = "heavy"` 等）は公開画面に一切出さない」と
定める。本プランはバッジ対象を**肯定的4種のみ**に絞り、`preDecisionOrPhotoShoot`
（§4-2 で述べた通り「事実分類ではあるが評価軸としては中立〜否定寄りに
読まれうる」項目）と `promotional`（既存方針により対象外）を除外することで、
この原則と両立させる。**バッジは点数ではなく判定項目の提示であり、かつ
否定的・中立的な判定を明示的に除外することで、§9.8・§10-3のいずれとも
矛盾しない**、というのが本プランの論拠である。

---

## 7.【未決論点】AI 生成物の明示（`@oracle` レビュー対象）

`1f0b16a` 以前（`git show 1f0b16a^:src/components/feed/feed-card.tsx` で参照
可能な旧 `Summary()`）には、`topicAnchor` と判定バッジに
`variant="ai"`（`title` 属性「この判定はAIが自動で行っており、誤りを含む
ことがあります」）の「自動判定」バッジが併記されていた。

オーナーは今回、この「自動判定」バッジの復活を**選択していない**（要求は
「肯定的4種のバッジのみ」であり、AI 明示バッジへの言及はない）。しかし
`topicAnchor` は LLM 生成物であり、有用度バッジも LLM 判定の結果を機械的に
ラベル化したものである。**AI 生成物であることの明示なしにこれらを公開面へ
出すことの是非は、本プランのユーザー決定4点とは独立した論点として、
ここでは結論を出さず提起するに留める。**

spec.md 内を検索したが、AI 生成物であることの明示に関する明文の要件は
見当たらなかった（「AI が生成」「AI生成」「自動判定」「AIが自動」「明示」で
grep した結果、該当するのは §10-3 の根拠文生成に関する記述や§10-4の出所
明示（著作者クレジット）等であり、いずれも「読者に対しAI生成物であることを
表示すべきか」を定める条項ではない）。**明文の要件は無い。**

なお `src/components/ui/badge.tsx:20` の `ai` variant（コメント「AI 生成の
明示マーカー」）は、`1f0b16a` で `feed-card.tsx` から利用箇所が消えて以降
どこからも使われていないデッドコードになっている（`grep -rn
'variant="ai"' src/` は0件）。本プランの実装過程でこの `ai` variant を
再利用するか、新規に作り直すか、デッドコードのまま放置するかは、本論点の
結論（AI明示バッジを復活させるか）に従属する。**この判断は `@oracle` の
レビューを経てから確定する**（本文書内では断定しない）。

---

## 8. 影響範囲

| パス                                                   | 変更内容                                                                                                                                                                                              | 担当レーン                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `src/components/feed/feed-card.tsx`                    | `Summary()` 相当の再実装（`topicAnchor` 表示＋肯定的4バッジ）、`Title()` の `line-clamp-2` → `line-clamp-3`、`text-balance` の再評価、AI明示バッジの要否（§7 の結論待ち）                             | `@designer`                |
| `src/components/ui/badge.tsx`                          | `ai` variant を再利用する場合はそのまま、新規デザインにする場合は差し替え。§7 の結論に従属                                                                                                            | `@designer`（§7 決定後）   |
| `src/lib/sources/base/feed-parser.ts`                  | タイトル正規化関数の新設と、RSS2/RDF（154行目）・Atom（183行目）2箇所への適用                                                                                                                         | `@fixer`                   |
| `src/lib/sources/google-news.ts`                       | `rawTitle`（53行目）への正規化適用（`stripSourceSuffix` との適用順序を要検討）                                                                                                                        | `@fixer`                   |
| `src/lib/sources/ogp.ts`                               | `htmlTitle`（111行目）・`ogTitle`（126,128行目）への正規化適用                                                                                                                                        | `@fixer`                   |
| `src/lib/embed/oembed.ts`                              | `title`（61行目）への正規化適用（現状 `trim()` すら無い）                                                                                                                                             | `@fixer`                   |
| `src/lib/pipeline/discovery-ingest.ts`                 | `extractHtmlTitle`/`extractArticleHeadline` → `originalTitle` 経路（625,663,708行目）への正規化適用。両関数の実装箇所は本プラン未確認のため Stage 4 で確認する                                        | `@fixer`                   |
| `src/lib/publish/gate.ts`                              | `CONTROL_CHAR_RE`（56行目）のタブ・改行許容という設計意図を見直す。正規化後は改行がここに到達しない前提であれば、許容をやめて検知対象に含めるか、正規化前提であることをコメントに明記するかを判断する | `@fixer`（判断は Stage 6） |
| `scripts/backfill-title-normalization.mjs`（新設想定） | 既存 `posts.original_title`（および `ai_title` 等タイトル系カラムがあれば対象を精査）の一括正規化。`scripts/backfill-rationale-text.mjs` の命名・構造・dry-run既定/`--apply`方式に揃える              | `@fixer`                   |
| `src/lib/types.ts`                                     | 変更なし（`topicAnchor`/`usefulness` フィールドは既存のまま）                                                                                                                                         | —                          |
| `src/lib/db/query.ts`                                  | 変更なし（`FEED_ROW_FIELDS` は既に `topicAnchor` を SELECT 済み）                                                                                                                                     | —                          |
| `openspec/specs/wedding-trend/spec.md`                 | §9.9 再改訂（§6-2）。正規化関数の新設と `CONTROL_CHAR_RE` の扱いを §10-3 または近傍に追記                                                                                                             | `@fixer`                   |
| `tests/feed-parser.test.ts`                            | 改行入りタイトルの正規化を検証するテストケースを新設                                                                                                                                                  | `@fixer`                   |
| `tests/publish-gate.test.ts`                           | `CONTROL_CHAR_RE` の扱い変更に応じたテスト更新（Stage 6 の判断に従属）                                                                                                                                | `@fixer`                   |

---

## 9. 段階設計

各ステージ末に検証ゲート（lint / type-check / vitest / coverage tiers / spec-refs /
smoke-test）を明記する。

### Stage 0: 前提確認

- 範囲: `git log -1` が `1f0b16a` であること、および `git status --short` の出力が
  未追跡の `shared_plan/*.md` のみであることを確認する。他セッションによる先行実装が
  本プランの変更範囲（`feed-card.tsx` / タイトル取得経路 / spec.md §9.9）に及んでいない
  かを `git log --oneline -10` で確認する。及んでいる場合は本プランの各 Stage を
  実装済み状況に合わせて読み替える。
- 完了判定: 作業ツリーがクリーンであり、本プランの変更対象ファイルに未反映の先行実装が
  無いことを確認する。
- 検証ゲート: なし（調査のみ）。

### Stage 1: `@designer` によるカード再設計（topicAnchor・バッジ・3行化）

- 範囲: `feed-card.tsx` に `topicAnchor` 表示と肯定的4バッジを復活させる。
  `Title()` を `line-clamp-3` に変更する。§7 のAI明示論点は `@oracle` レビュー後に
  確定するため、このStageでは一旦「AI明示バッジなし」で実装し、§7 の結論が出た
  時点で追従する2段階運用とする（先に4要素の骨格を作ってからAI明示要否を追加
  判断する順序）。
- 完了判定: カードに `topicAnchor`・肯定的4バッジ・3行タイトルが表示されることを
  確認する。`preDecisionOrPhotoShoot`・`rationaleText`・`aiSummary` が描画されない
  ことを確認する。
- 検証ゲート: lint / type-check。

### Stage 2: `@oracle` によるAI明示論点のレビュー

- 範囲: §7 の論点（AI生成物明示バッジの要否）を `@oracle` にレビュー依頼する。
  判断材料として本文書 §7・旧 `Summary()` の実装（`git show
1f0b16a^:src/components/feed/feed-card.tsx`）・spec.md 内のAI明示に関する
  明文要件の不在、を Orchestrator が事前収集して渡す。
- 完了判定: `@oracle` の見解が記録され、実装方針（AI明示バッジを追加する/しない）
  が確定していることを確認する。
- 検証ゲート: なし（レビューのみ）。

### Stage 3: Stage 2 の結論を `@designer` レーンで反映

- 範囲: Stage 2 で「追加する」と決まった場合のみ、`badge.tsx` の `ai` variant
  再利用または新規デザインでAI明示バッジを実装する。「追加しない」場合は
  このStageをスキップし、その判断をStage 9 完了判定に記録する。
- 完了判定: Stage 2 の結論が実装に反映されている（または明示的にスキップされ、
  理由が記録されている）ことを確認する。
- 検証ゲート: lint / type-check。

### Stage 4: タイトル正規化関数の新設と全経路への適用

- 範囲: `src/lib/sources/base/feed-parser.ts` に正規化関数
  （`normalizeTitle()` 等の命名は `@fixer` 実装時に確定）を新設する。除去対象は
  最低限 `\n` `\r` `\t` ` `（U+2028 LINE SEPARATOR）` `（U+2029 PARAGRAPH
  SEPARATOR）、連続空白の圧縮、前後 trim とする。全角スペース（U+3000）を
  圧縮対象に含めるかどうかは、タイトル中の意図的な全角スペース区切り
  （見出し内の視覚的な区切りとして使われている可能性）を考慮し判断する
  ——**本プランの判断: 含めない**。理由は、`stripHtml()` が本文用に半角/改行系
  のみを圧縮対象としており全角スペースには触れていない既存の非対称な扱いに
  倣うこと、および全角スペースは日本語コンテンツで意図的な字下げ・区切りとして
  使われる例があり、圧縮すると原文の逐語性（§10-3「元記事タイトルの逐語表示」）
  を損なうリスクがあるため。この判断は実装時に再検証してよい。
  適用先: `feed-parser.ts` RSS2/RDF（154行目）・Atom（183行目）、
  `google-news.ts` の `rawTitle`（53行目。`stripSourceSuffix` の**前**に正規化を
  適用する——サフィックス除去は正規化後の文字列に対して行う方が安全）、
  `ogp.ts` の `htmlTitle`（111行目）・`ogTitle`（126,128行目）、`oembed.ts` の
  `title`（61行目）、`discovery-ingest.ts` の `extractHtmlTitle`/
  `extractArticleHeadline` → `originalTitle` 経路（625,663,708行目。両関数の
  実装箇所をこのStageで確認し、正規化の適用点を確定する）。
- 完了判定: 上記すべての経路が新設した正規化関数を通ることを確認する。改行・
  タブ・連続空白を含むタイトル入力に対し、正規化後の文字列に `\n`/`\r`/`\t`が
  含まれないことをユニットテストで確認する。
- 検証ゲート: lint / type-check / vitest。

### Stage 5: `tests/feed-parser.test.ts` へのテスト新設

- 範囲: 改行・タブ入りタイトルを含む RSS2/Atom フィクスチャを追加し、正規化後の
  `entry.title` が改行・タブを含まないことを検証するテストケースを新設する。
  **AGENTS.md「ゲートが緑であることと、ゲートが機能していることは別である」
  に従い、正規化関数を一時的にコメントアウトする等で意図的に壊し、新設テストが
  実際に失敗することを確認してから元に戻す**——これをこのStageの完了条件に含める。
- 完了判定: 新設テストが（a）正規化関数がある状態で緑になること、（b）正規化
  関数を意図的に無効化した状態で赤になることの両方を確認する。
- 検証ゲート: vitest / coverage tiers。

### Stage 6: `CONTROL_CHAR_RE` の設計意図見直し

- 範囲: `src/lib/publish/gate.ts:54-56` の `CONTROL_CHAR_RE` が「タブ・改行を
  許容する」設計になっている点について、Stage 4 の正規化後は改行がこの関数に
  到達しない前提が成り立つかを確認する。成り立つ場合、（a）許容をやめて
  タブ・改行も検知対象に含める、（b）許容を維持しつつ「正規化済みタイトルが
  前提であり、この関数は最終防衛線ではない」旨をコメントに明記する、のいずれかを
  選び実装する。判断はどちらでもよいが、選ばなかった理由を記録すること。
- 完了判定: `CONTROL_CHAR_RE` の扱いとその理由が記録され、コード（コメント）に
  反映されていることを確認する。関連する `tests/publish-gate.test.ts` が
  更新後の挙動と整合していることを確認する。
- 検証ゲート: lint / type-check / vitest。

### Stage 7: backfill スクリプトの新設

- 範囲: `scripts/backfill-rationale-text.mjs` の命名・構造（先頭コメントでの
  背景説明、`.env.local` 簡易パーサ、`--apply` フラグで dry-run/実行を切り替え、
  対象を「正規化前後で差分が出る行のみ」に絞ることで冪等にする）に揃えて
  `scripts/backfill-title-normalization.mjs` を新設する。対象カラムは
  `posts.original_title` を中心に、`ai_title` 等タイトル系の他カラムがあれば
  精査して対象に含めるか判断する。ロジックは複製せず、Stage 4 で新設した
  正規化関数を import して使う。
- 完了判定: dry-run 実行で対象件数が「要計測」であることを認識した上で
  スクリプトが構文的に正しく動作することを確認する（本番DB接続は本プランの
  制約により実行しない。実行はStageの範囲外とし、別途ユーザー判断で実施する）。
- 検証ゲート: lint / type-check。

### Stage 8: spec.md 改訂

- 範囲: §9.9 を §6-2 の文案に沿って書き換える。§10-3 近傍または新設の項に
  タイトル正規化関数の存在と `CONTROL_CHAR_RE` の扱い（Stage 6 の結論）を
  追記する。§9.8・§10-3 との整合を論じた本文書 §6-3・§6-4 の論拠を spec.md
  側にも要約として反映するか判断する。
- 完了判定: `scripts/check-spec-update.sh` が警告を出さないことを確認する。
- 検証ゲート: spec-refs。

### Stage 9: 統合確認・smoke-test

- 範囲: Stage 1〜8 の変更が揃った状態で、フィード全体を確認する。`topicAnchor`・
  肯定的4バッジ・3行タイトルが正しく表示されること、改行を含む新規取得タイトルが
  正規化されて表示されることを確認する。
- 完了判定: §10 の完了判定チェックリストすべてを確認する。
- 検証ゲート: lint / type-check / vitest / coverage tiers / spec-refs / smoke-test。

---

## 10. 完了判定

- [ ] `feed-card.tsx` に `topicAnchor` が表示され、`rationaleText`・`aiSummary` は
      引き続き描画されないことを確認する
- [ ] 有用度バッジが `firsthand`/`ceremonyDecision`/`specific`/`weddingDayContent`
      の4種のみで構成され、`preDecisionOrPhotoShoot`・`promotional` は表示されない
      ことを確認する
- [ ] `Title()` が `line-clamp-3` になっていることを確認する
- [ ] `Footer()`（出典・著者・日時・原文リンクCTA）が変更されていないことを確認する
- [ ] タイトル取得経路（RSS2/RDF・Atom・Google News・OGP・oEmbed・discovery-ingest）
      すべてに正規化関数が適用されていることを確認する
- [ ] 改行・タブ入りタイトルの正規化テストが新設され、正規化関数を意図的に無効化
      すると失敗することを確認済みであることを確認する（AGENTS.md のゲート機能性
      検証ルールに従う）
- [ ] `CONTROL_CHAR_RE` の扱い（維持/変更）とその理由が記録されていることを確認する
- [ ] `scripts/backfill-title-normalization.mjs` が新設され、既存 `backfill-*.mjs`
      の命名・構造規約に沿っていることを確認する
- [ ] spec.md §9.9 が §6-2 の文案に沿って改訂されていることを確認する
- [ ] §7 のAI生成物明示論点について `@oracle` の見解が記録され、実装（追加する/
      しない）が確定していることを確認する
- [ ] lint / type-check / vitest / coverage tiers / spec-refs / smoke-test が
      すべて通過していることを確認する

---

## 11. リスク

| リスク                                                                                                                                                   | 影響                                                                           | 対処                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `topicAnchor` 復活時に誤って `hasRationale` 分岐ごと復元し `aiSummary` フォールバックまで一緒に復活させる                                                | 13 §1-1 で明示的に避けた退行が再発する（要約形式のゼロクリック化・翻案リスク） | Stage 1 完了判定で `aiSummary` が描画されないことを機械的に確認する                                          |
| `preDecisionOrPhotoShoot` を誤って有用度バッジに含めてしまう                                                                                             | §6-4 で述べた §10-3 との整合が崩れる                                           | Stage 1 完了判定にバッジが4種のみであることを明記し確認する                                                  |
| タイトル正規化の適用漏れ（取得経路のうち1つでも正規化を通さない）                                                                                        | 「謎の改行」が一部経路だけ再発し、問題が再現困難な間欠バグとして残る           | Stage 4 で全経路を表形式（§8）で網羅し、Stage 5 のテストで機能検証する                                       |
| `CONTROL_CHAR_RE` の許容を安易に変更し、正規化前提が崩れた場合（例: 将来別経路が正規化を経ずにタイトルを渡す）に既存の緩さが失われ、想定外の棄却が増える | 公開率の意図しない低下                                                         | Stage 6 で判断とその理由を明記し、正規化を経ないタイトル入力経路が将来追加されないか設計意図をコメントに残す |
| 全角スペース（U+3000）を圧縮対象外とした判断が、実際には無意味な間隔として表示崩れの原因になっているケースを見落とす                                     | 表示上の見た目改善が不完全に終わる                                             | Stage 4 の判断は暫定とし、実装後に実データで再評価する余地を残す（本文書 §9 Stage 4 に明記済み）             |
| AI明示論点（§7）の結論が出るまでStage 1のカード実装が2度手間になる（先に骨格を作り、後からAI明示バッジを追加/見送り）                                    | 実装コストの若干の増加                                                         | §9 Stage 1/2/3 で意図的に2段階運用とし、手戻りを最小化する設計にしている                                     |
| backfill 対象件数を本番DB接続なしに把握できない                                                                                                          | Stage 7 の完了判定が「要計測」のまま実行判断がユーザー任せになる               | 本文書の制約（本番DB非接続）を尊重し、実行自体は別途ユーザー判断とする旨をStage 7に明記済み                  |

---

## 12. 意図的に採用しないもの

| 案                                                                                                                  | 排除理由                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rationaleText` 復活案                                                                                              | ユーザー決定により対象外。§4-1 の通り復活対象は `topicAnchor` のみであり、`rationaleText`（根拠文全体）は13で確立した「要約的テキストは公開しない」方針を維持する                                                                            |
| `aiSummary` 復活案                                                                                                  | ユーザー決定により対象外。13 §1-1 が明示的に避けた退行（要約形式のゼロクリック化・翻案リスク）であり、本プランでも継続して排除する                                                                                                           |
| `preDecisionOrPhotoShoot` バッジ復活案                                                                              | ユーザー決定により対象外。§4-2・§6-4 の通り、spec.md 上は根拠文からの削除対象外という整理があるものの、UI バッジとしては§9.8・§10-3の精神（否定的・評価的な情報を公開面に出さない）との整合を優先し、肯定的4種のみに限定する                 |
| 表示時のみのタイトル正規化案（DB保存値は改行入りのまま、`feed-card.tsx` 側で `.replace(/\s+/g, " ")` する対症療法） | ユーザー決定（取得時に正規化して保存し、既存データもbackfillする）に反する。表示時のみの正規化は新規取得データの根本原因（§5-1の非対称）を放置し、DB内のデータが汚れたまま残るため、検索・ソート・将来の別UIでの再利用時に同じ問題が再発する |

---

## 申し送り

`shared_plan/13-remove-rationale-display-and-media-zone.md` の状態欄は「未着手」の
ままだが、実装（`1f0b16a`）は完了済みである。13 のファイルは本プランの制約により
書き換えていない。**13 の状態欄と §9 完了判定チェックリストが実装完了を反映して
いないため、13 側で更新が必要。**
