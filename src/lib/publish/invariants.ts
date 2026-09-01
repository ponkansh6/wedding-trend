/**
 * Stage 6 (S2) Commit 1: 法務不変条件レジストリ。
 *
 * plan 07 §5-M1 の初期診断は「不変条件は9項目、それぞれの強制箇所を数えて
 * 全項目1にする」という M1 指標を掲げていたが、実際に「9項目」を列挙した
 * 箇所はリポジトリのどこにも存在せず、`INV-` アンカーも0件だった。この
 * ファイルは、架空の9項目に合わせるのではなく、**現に機械的強制がある
 * ものを棚卸ししてデータ表化**したもの。
 *
 * このモジュールは実行時の制御フローに一切関与しない（新しい抽象層を
 * パイプラインに足さない）。`tests/pipeline/invariants.test.ts` が、各 id に
 * ついて `runPipelineOnCandidates`（または INV-4 のように構造上パイプライン
 * を通せない場合は対象関数を直接）を通した結果で検証する「境界アサーション」
 * の索引として使う。
 *
 * `enforcedBy` は強制しているコードの実際の場所（ファイル:関数名）。
 *
 * shared_plan/20 P4: 旧 INV-7（逐語タイトル）と旧 INV-8（discovery 抽出本文の
 * 非永続化）を `INVARIANTS` 配列から外した。両者とも「型・ゲートによる強制では
 * なく規約」であり、機械強制のレジストリに規約を混ぜると「不変条件」の語の
 * 信頼性を損なうため。逐語タイトル・非永続化という法務要件そのものは
 * spec.md §10 に依然として存在し、実装的強制（`aiTitle` 全経路 null 固定、
 * discovery-ingest.ts の `originalExcerpt: null` 固定、`assertNoSliceLeak`）も
 * 一切変更していない。運用ポリシーとしての記述は spec.md の運用ポリシー節へ移した。
 * 残りの ID（INV-1..INV-6）は安定のため振り直さない。
 */

export type InvariantViolationKind = "drop" | "degrade" | "throw" | "convention";

export interface InvariantEntry {
  id: string;
  summary: string;
  spec: string;
  enforcedBy: string;
  onViolation: InvariantViolationKind;
  reason: string | null;
}

export const INVARIANTS = [
  {
    id: "INV-1",
    summary:
      "タイトルの機械的フィルタ（制御文字・絵文字11個以上・同一記号4連続以上・2字未満は非公開）",
    spec: "spec.md §10",
    enforcedBy: "src/lib/publish/gate.ts filterTitle",
    onViolation: "drop",
    reason: "title_filter",
  },
  {
    id: "INV-2",
    summary: "topicAnchor の長さ下限（ANCHOR_MIN_LENGTH = 6 字未満は degrade）",
    spec: "spec.md §10",
    enforcedBy:
      "src/lib/publish/gate.ts checkAnchorLength（validateTopicAnchor 経由、src/lib/llm/batch.ts curateBatch から呼ばれる）",
    onViolation: "degrade",
    reason: "anchor_too_short",
  },
  {
    id: "INV-3",
    summary: "topicAnchor の個人識別情報 denylist（SNS ハンドル・敬称付き人名は degrade）",
    spec: "spec.md §10",
    enforcedBy:
      "src/lib/publish/gate.ts checkAnchorDenylist（validateTopicAnchor 経由、src/lib/llm/batch.ts curateBatch から呼ばれる）",
    onViolation: "degrade",
    reason: "anchor_prohibited_term",
  },
  {
    id: "INV-4",
    summary: "判定根拠文の字数（RATIONALE_TEXT_MIN_CHARS=38 〜 RATIONALE_TEXT_MAX_CHARS=210）",
    spec: "spec.md §10",
    enforcedBy: "src/lib/publish/gate.ts renderRationaleText",
    onViolation: "throw",
    reason: null,
  },
  {
    id: "INV-5",
    summary: "LLM 判定前に判定材料（抜粋）が存在すること（Evidence Gate）",
    spec: "spec.md §10",
    enforcedBy: "src/lib/pipeline/run-pipeline.ts runPipelineOnCandidates（Evidence Gate 区画）",
    onViolation: "drop",
    reason: "extraction_insufficient",
  },
  {
    id: "INV-6",
    summary: "日次公開上限（DAILY_PUBLISH_CAP = 150）のサーキットブレーカー",
    spec: "spec.md §10",
    enforcedBy: "src/lib/pipeline/run-pipeline.ts runPipelineOnCandidates（Rate Cap 区画）",
    onViolation: "degrade",
    reason: "rate_capped",
  },
] as const satisfies readonly InvariantEntry[];

export type InvariantId = (typeof INVARIANTS)[number]["id"];
