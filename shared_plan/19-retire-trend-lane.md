# 19. 最新トレンド速報レーンの廃止とフィード1本化

- 対象: `wedding-trend`（本プロジェクト）
- 作成日: 2026-09-01
- 前提コミット: `f453d1d` `fix(pipeline): 終端棄却時に再試行キュー行を掃除する`
- 参照:
  - `shared_plan/18-ai-topic-tags.md`
  - `shared_plan/17-simplification-plan.md`
  - `openspec/specs/wedding-trend/spec.md`
- 状態: **未着手（計画のみ）**
- 前提: 法務不変部分（spec.md §10）は本計画で一切緩めない。記事本文の非生成・非永続化、タイトル逐語、
  AI 出力はトピックアンカー＋判定根拠文のみ、元記事への導線・クレジットは維持する。

---

## 1. 発端

オーナーの要求は「最新トレンド速報セクションを廃止し、定番1本にする」。

**最重要の構造的事実（本計画全体の前提）**:

レーン分岐は `tag` ではなく `sourceType` 駆動である。`feed-lane-trend.tsx` は `sourceType="sns"`、
`feed-lane-classic.tsx` は `sourceType="blog"` を引く。一方 LLM が付ける `tag` は独立した軸で、
google-news（`sourceType="blog"`）は全14件 `tag="trend"` のまま**すでに定番レーンに出ている**。
したがって現状の「速報レーン」の実体は「**手動 URL 投入専用サーフェス**」であり、トレンド性とは無関係。
自動供給はゼロ（全 RSS アダプタは blog 固定）。また `tag` は現時点で掲載順にも絞り込みにも使われておらず、
表示ラベル以上の機能を持たない。

---

## 2. 現状（コード実測）

- UI: `src/components/feed/feed-lane-trend.tsx:11-27`（速報、`variant="visual"`）/
  `src/components/feed/feed-lane-classic.tsx:11-30`（定番、`variant="editorial"`）/
  `src/components/feed/feed-card.tsx:9-14`（共通カード）/
  `src/app/page.tsx:22-39`（両レーン並列取得・表示）
- 型・スキーマ: `src/lib/types.ts:10`（`TrendTag = "trend" | "classic"`）,
  `src/lib/types.ts:154`（`FeedCard.tag`）,
  `src/lib/db/schema.ts:19`（`posts.sourceType: ["sns","blog"]`）,
  `src/lib/db/schema.ts:36`（`posts.tag: ["trend","classic"]`）
- 掲載順: `src/lib/db/query.ts:123-136` — blog は有用度スコア降順→publishedAt降順→id降順、
  sns は createdAt 新着順で**採点対象外**。`src/lib/db/query.ts:163-180`（`getFeedCards()`）。
  `src/lib/scoring/usefulness.ts` の純関数と `query.ts` の `USEFULNESS_SCORE_SQL` が同一重み定数を共有し、
  `tests/feed-order-parity.test.ts` が 3,125 通りで一致検証。
- 投入経路（非対称性）: RSS アダプタは全て blog（`src/lib/sources/registry.ts`）。
  SNS は `/admin` 手動投入のみ — `src/app/api/submit-url/route.ts` →
  `src/lib/pipeline/submit-via-pipeline.ts` → `src/lib/pipeline/adapters/submit-adapter.ts:50,72,123`、
  UI は `src/components/admin/submit-url-form.tsx:27` / `src/components/admin/operator-panel.tsx:26`、
  Server Action は `src/app/actions.ts` の `submitSnsUrl`。
  blog 側は `src/lib/pipeline/ingest.ts` + `src/lib/pipeline/adapters/evergreen-adapter.ts`。
- LLM: `src/lib/llm/schemas.ts:49`（`tag: z.enum(["trend","classic"])`）,
  `src/lib/llm/prompts.ts:125`（trend=新/流行、classic=王道/定番）
- UI 付帯: `src/components/ui/badge.tsx:11-15`, `src/components/ui/button.tsx:11-14`,
  `src/components/feed/empty-state.tsx:35-36`,
  `src/app/globals.css:87,89,92,95`（`--color-trend` / `--color-classic`）,
  `src/components/admin/ingest-status-panel.tsx:27,40,60`（trend 色使用）
- テスト: `tests/feed-order-parity.test.ts`, `tests/api-submit-url.test.ts`,
  `tests/api-ingest.test.ts`, `tests/actions.test.ts`
- spec.md 該当箇所: 17-18（2レーン定義）, 52（FR-004）, 85（source_type）,
  124（`post_usefulness_criteria`）, 275-277（2-lane アーキ図）, 306-309（ソース採否実データ）,
  484-549（§9 編集方針）, 637（体験談レーン掲載順）, 672-674（速報レーン掲載順）
- 実データ（2026-08-22 検証）: 有効=google-news（全14件→trend 分類）, note（18/20件→classic 分類）。
  停止中=hatena-bookmark, ameblo。

---

## 3. 廃止スコープの切り分け（論点と結論）

選択肢: (a) UI のみ削除しデータ経路温存 / (b) 投入経路まで削除 /
(c) DB の `sourceType`・`tag` カラムまで廃止。

**結論: (b) まで踏み込み、(c) は別リリースに分離。`sourceType` カラムは残し（値 "sns" も残す）、
`tag` も DB/LLM には残す。**

根拠:

- (a) は不整合を残す。sns 行は採点対象外（`query.ts:123-136`）のため、統合クエリに流すとスコア未定義の
  行が混ざる。読み手のいない書き込み経路（submit-url）の温存は、後から投入されて未定義挙動を踏むライアビリティ
  そのもの。よって投入経路停止はオプションではなく整合性要件。
- (c) は不可逆。Postgres の enum 値削除は型再作成＋既存行書き換えを伴う一方、得られるのはスキーマの見た目の
  綺麗さだけで実行時挙動は (b) と同一。可逆な変更と不可逆な変更を同一コミットに混ぜない原則から分離する。
- `sourceType` を残す積極的理由: プロヴェナンス（出所種別）として、レーン分岐から解放されれば純粋な
  メタデータとして正しく機能する。ソース構成の診断に効く。
- `tag` は「残す積極的理由はないが急いで消す理由もない」。google-news 全件 trend という事実は
  tag が実質ソース種別の代理変数に堕している（情報量ほぼゼロ）ことを示す。ただし削除は
  LLM schema・prompt・型・バッジ・CSS 変数を横断し、レーン廃止の可逆性を汚す。
  **Stage 3 で UI からの露出のみ落とし、DB/LLM からの除去は (c) と同じ不可逆バケットへ送る。**

却下した代替案:

- 「tag をレーンの代わりに絞り込みフィルタにする」: google-news=trend / note=classic の 1:1 対応が
  成立している以上、ソース別フィルタの遠回しな再実装にすぎず、2レーンを2フィルタに言い換えただけで
  フィード一本化という目的を達成しない。
- 「手動投入を `sourceType="blog"` として存続」: §6 の理由により却下（ただし未決事項として残す）。

残るリスク: 手動投入の完全喪失。「どうしても入れたい1本」の逃げ道がなくなる。使用実績が不明（未決事項へ）。

---

## 4. google-news の扱い

**結論: 今回のリリースでは停止しない。有用度スコアで自然に沈むに任せ、統合後の実分布を1〜2週間観測してから
別コミットで判断する。**

根拠:

- 有用度ルーブリック（spec.md:124 の5項目）は体験談前提であり、ニュース記事は具体性・再現性・費用実感で
  伸びず統合フィード下位に沈む。これは「満足度の高い王道・定番」という製品命題と整合した挙動であり、
  ルーブリックの誤動作ではなく意図通りの選別である。
- ただし供給量に警戒。有効ソースは実質 google-news(14) と note(18) の2本のみ。google-news 停止は供給を
  note 単独に落とす。`HOST_DAILY_SHARE_MAX` は 2026-08-29 に廃止済みでポリシー違反ではないが、
  可用性リスクとしては実質的。
- 同一リリースで停止しない理由: 「レーン廃止の影響」と「ソース停止の影響」を同時投入すると品質劣化時の
  切り分けが不能になる。registry のエントリ無効化は1行で可逆なので後から独立に打てる。

却下: ニュース向けルーブリックの追加/分岐は YAGNI。母数14件・観測1回で採点体系を分岐させるのは早すぎる上、
`usefulness.ts` と `USEFULNESS_SCORE_SQL` の二重実装を分岐数だけ増やし parity テストの組合せを
掛け算で膨らませる（現状 3,125 通り）。

残るリスク: 統合後の上位が note の体験談で埋まり、実質「note まとめサイト」に見える。
製品としての正しさとは別の、見え方の問題。

---

## 5. 掲載順の統合

**結論: 「有用度スコア降順 → publishedAt 降順 → id 降順」で確定。時間減衰項は導入しない。**

根拠:

1. 速報レーン廃止という意思決定自体が「recency は主軸ではない」という判断である。同時に減衰項で recency を
   再輸入するのは自己矛盾。
2. 現行 tiebreak に既に publishedAt 降順があり、同スコア帯では新しい記事が上に来る。弱い recency 選好は
   実装済み。減衰項が追加で買うのは「古い高スコア記事を新しい低スコア記事より下げる」ことだけで、
   望ましいという根拠が現時点で無い。
3. 複雑度コストが特異的に高い。時間減衰はスコア関数を時刻依存にし、`feed-order-parity.test.ts` の前提
   （決定的な純関数）を壊す。両側への時刻注入（SQL 側は `now()` ではなくパラメータ渡し）が必須になり、
   UI 主体の変更に対し不釣り合いに侵襲的。

将来「古い記事ばかり出る」が実測された場合の推奨手段は減衰項ではなく **publishedAt のフィルタ窓**
（直近 N ヶ月のみ）。時刻依存を WHERE 句に閉じ込めればスコア関数は決定的なまま保たれ parity 不変条件を
維持できる。可逆性（定数1個）と検証可能性の両面で優れる。

残るリスク: フィード固定化（毎日同じ顔ぶれ）。観測指標を Stage 1 の完了条件に含める。

---

## 6. 既存 SNS データの移行

**推奨順序: ① 論理非表示（クエリ除外）→ ② 観測期間 → ③ 物理削除は別途判断。blog への再分類は却下。**

- 論理非表示は DDL ゼロ、`git revert` 1発で完全復旧。Stage 1 で `getFeedCards()` が blog のみを引くように
  すれば自動的に達成され追加作業も不要。
- blog 再分類の却下理由: (i) sns 行は採点前提のフィールドを備えていない可能性が高く（`query.ts` で明示的に
  採点対象外）、統合スコア順に混ぜると未定義スコアの行が意図しない位置に入る。(ii) 出所種別の書き換えは
  プロヴェナンスの改竄であり、元記事への導線・クレジットを不変制約とする本プロジェクトの規律と矛盾する
  （§10 の文言違反ではないが同じ理由で避ける）。
- 物理削除は Stage 4（不可逆バケット）。行数は手動投入分のみで小さく残置コストはほぼゼロ、急ぐ理由がない。

残るリスク: 論理非表示のままだと将来 `getFeedCards()` 以外の経路（管理画面・集計・サイトマップ等）から
sns 行が漏れる可能性。**除外条件はクエリ層1箇所に集約し、複数箇所に散らさないこと。**

---

## 7. Stage 構成

- **Stage 0 — 仕様確定（コード変更なし / 完全可逆）**
  spec.md の 17-18, 52(FR-004), 275-277, 484-549(§9), 637, 672-674 を1レーン前提に改訂。
  完了条件: spec.md 更新済み、pre-commit の `scripts/check-spec-update.sh` 緑、未決事項（§9）が明文化されている。

- **Stage 1 — UI 1レーン化（1コミットで revert 可能）**
  `page.tsx` を単一クエリ・単一レーンに。`feed-lane-trend.tsx` 削除。
  `feed-lane-classic.tsx` の改名は revert 可読性を下げるため Stage 3 に送ってよい。
  `getFeedCards()` に blog 限定を明示。**DB / LLM / 投入経路は一切触らない。**
  完了条件: トップが1レーン表示、既存 blog の掲載順が不変（parity test 緑）、sns 行が UI から消えている、
  空状態が壊れていない、加えて統合後フィード上位20件のソース内訳と publishedAt 分布を記録
  （§4・§5 の後日判断のベースライン）。

- **Stage 2 — 投入経路の停止（1コミットで revert 可能）**
  `submit-url` route / `submit-via-pipeline` / `submit-adapter` / admin フォーム /
  `actions.ts:submitSnsUrl` / 対応テストを削除。
  完了条件: type-check・lint 緑、admin 画面が壊れていない、`triggerIngest()`（blog パイプライン）に回帰なし。

- **Stage 3 — 表示語彙のクリーンアップ（1コミットで revert 可能）**
  `TrendTag` の UI 露出除去、バッジ variant、未使用 CSS 変数（`--color-trend` 等）、
  `ingest-status-panel.tsx:27,40,60` の色参照を整理。**DB enum と LLM schema の `tag` は残す。**
  完了条件: 未使用シンボル・未使用 CSS 変数がゼロ、lint 緑。

--- ここまでが `git revert` で戻せる範囲 ---

- **Stage 4 — 不可逆（別リリース、Stage 1-3 の soak 後）**
  4a 既存 sns 行の物理削除 / 4b `posts.tag` の DB・LLM からの除去 /
  4c `posts.sourceType` からの "sns" 値除去（**推奨しない。カラム自体は残す**）。
  完了条件: マイグレーション適用前のバックアップ取得が手順に含まれること。

- **Stage 5 — google-news 停止判断（独立・可逆）**
  registry の1行。Stage 1 の観測データに基づいて判断。

---

## 8. 検証計画

**壊れやすい箇所（優先度順）**:

1. `getFeedCards()` の絞り込み条件 — sns 除外の漏れ、または blog まで巻き込む過剰絞り込み
2. 空状態 — sns 分が消えて件数が閾値を割る経路（`empty-state.tsx`）
3. `actions.ts` / admin 画面 — `submitSnsUrl` 削除に伴う参照残り（`operator-panel.tsx:26`）
4. LLM schema と DB enum の drift — 片方だけ触ると挿入時に落ちる。Stage 3 で `tag` を両方残す判断は
   このリスク回避が主目的
5. CSS 変数の未使用残置 — 実害なしだが lint シグナル

**`tests/feed-order-parity.test.ts`**: 原則無改修。掲載順の式（重み定数、`usefulness.ts` ↔
`USEFULNESS_SCORE_SQL`）を一切変更しないため 3,125 通りの一致検証はそのまま通るべき。
**通らなかったら意図しない副作用の検出であり、テストが正しく機能した証拠**として扱う。
唯一の改修点: 現状 blog 行のみ対象なら追加不要。sns 行を含むフィクスチャを持っているなら、
**削除せず「sns 行が結果集合に含まれないこと」を主張するケースに書き換える**
（削除すると絞り込みが将来壊れても気づけない）。

**`tests/api-submit-url.test.ts`**: 改修ではなく削除。対象ルートごと消えるため残せば死んだテストになる。
**ルート削除と同一コミットで削除**すること。

**最小テスト集合**:

- 既存無改修: `feed-order-parity.test.ts`（緑であること自体がゲート）
- 既存改修: `actions.test.ts`（`submitSnsUrl` ケース削除、`triggerIngest` ケース維持）
- 既存維持: `api-ingest.test.ts`（blog パイプライン非回帰）
- 新規1本: `getFeedCards()` が blog のみを返し、順序が有用度スコア降順であること
- 削除: `api-submit-url.test.ts`

**ゲート実行の分担**: AGENTS.md の規定どおり、テスト実装は `@fixer`、実行・検証
（lint / type-check / test / coverage / spec-refs / smoke-test）は Orchestrator が行う。

**ゲートの実効性確認**: AGENTS.md「ゲートが緑であることと機能していることは別」に従い、
新規追加した sns 除外テストは除外条件を一時的に外して**実際に落ちること**を確認するまで完了と見なさない。

---

## 9. 未決事項（オーナー判断が必要）

1. 手動投入機能を完全に捨ててよいか。速報レーンの実体はこれである。
   捨てる / `sourceType="blog"` として別形で残す / 将来再導入 のどれか。使用実績が判断材料として必要。
2. google-news を継続するか停止するか。Stage 1 の観測データ（上位20件のソース内訳）を見てから。
   停止で供給が note 単独になる点を受け入れるか。
3. `tag` をユーザーに見せ続けるか。google-news=trend / note=classic の 1:1 対応が実質固定である以上、
   バッジは「ソース名の言い換え」でしかない。
4. 既存 sns 行を最終的に削除するかアーカイブとして残すか、および削除タイミング。
5. 統合フィードの最低件数と、割り込んだ場合の挙動（空状態を出す / 停止中ソースを再開する / 閾値なし）。
   停止中の hatena-bookmark・ameblo の再開可否と紐づく。
6. 記事の鮮度下限。減衰項は却下したが「N ヶ月より古い記事を出さない」窓を将来入れるか、
   入れるなら N をいくつにするか。今回は入れないが判断保留として明記。
7. spec.md §9 編集方針（484-549）の改訂範囲。2レーン前提の記述をレーン廃止に伴う機械的置換で
   済ませられるのか、編集ポリシー自体の再定義が必要か。
8. `submit-url` エンドポイントが公開面から到達可能だったか。到達可能なら削除時の応答
   （404 か 410 か）を決める必要がある。

---

## 10. やらないこと（スコープ外）

- 時間減衰項の導入（§5 で却下）
- ニュース向け有用度ルーブリックの追加・分岐（§4 で却下、YAGNI）
- 有用度スコアの重み定数の変更
- `posts.tag` / `posts.sourceType` の DB enum 変更（Stage 4 の不可逆バケット）
- sns 行の blog への再分類（§6 で却下）
- 停止中ソース（hatena-bookmark / ameblo）の再開
- 法務不変部分（spec.md §10）の緩和
