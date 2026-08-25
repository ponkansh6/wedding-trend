/**
 * plan 07 §5-M1 「無検閲の公開チャネルを閉じる」の実装。
 *
 * ここに置く関数はすべて純粋関数（DB・ネットワーク・ファイルシステムに一切
 * 触れない）。パイプラインへの結線（どこでこれらを呼ぶか）は別レーンが担う。
 *
 * このモジュールが閉じる経路は3つ:
 * - `filterTitle`: 第三者（元サイト）が書いた逐語タイトルの無検閲公開
 * - `checkAnchorGrounding`: LLM が出力する `topicAnchor`（プロンプトインジェクション
 *   の主要な出口になりうる）を、取得本文に逐語で存在する語だけに制限する
 * - `renderRationaleText`: 根拠文を LLM の自由生成から締め出し、
 *   構造化フィールド（`topicAnchor` + 6 boolean）からの決定的なテンプレート
 *   生成に置き換える（plan 07 §6-Q5）
 */

import type { DropReason } from "@/lib/types";

export type GateResult = { ok: true } | { ok: false; reason: DropReason; missingTerms?: string[] };

// ─────────────────────────────────────────────────────────────
// filterTitle（M1: タイトル公開フィルタ）
// ─────────────────────────────────────────────────────────────

/**
 * 全角/半角・大文字小文字を問わない部分一致で検知する広告・PR 系キーワード。
 * "PR" / "AD" はここに含めない —— 単語の一部（PRESS, ADVICE 等）に誤爆する
 * ため、専用のトークン境界チェック（`containsStrictAdToken`）で扱う。
 */
const LOOSE_AD_KEYWORDS = [
  "広告",
  "プロモーション",
  "スポンサー",
  "sponsored",
  "タイアップ",
  "提供",
  "第三者提供",
];

/**
 * NFKC 正規化後のタイトルから英字の「連続した塊」だけを取り出し、その塊が
 * 大文字化して厳密に "PR" または "AD" と一致する場合のみ検知する。
 * これにより「【PR】」「[AD]」「#PR」のような単独トークン／括弧内の用法だけを
 * 拾い、"PRESS" "ADVICE" のような語の一部には反応しない
 * （英字の塊は非英字文字——括弧・記号・空白・日本語——で自然に区切られるため、
 * 単語境界チェックを別途実装する必要がない）。
 */
function containsStrictAdToken(normalizedTitle: string): boolean {
  const letterRuns = normalizedTitle.match(/[A-Za-z]+/g) ?? [];
  return letterRuns.some((run) => run.toUpperCase() === "PR" || run.toUpperCase() === "AD");
}

/** 制御文字（タブ・改行は許容し、その他の C0/C1 制御文字・DEL を検知）。 */
// oxlint-disable-next-line no-control-regex -- 制御文字の検知そのものが目的で意図的。
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** 絵文字・記号ピクトグラフの許容上限（これを超えるタイトルは過剰装飾として棄却）。 */
const MAX_EMOJI_COUNT = 3;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** 同一の記号文字が 4 連以上続く記号連打（英数字・空白・日本語文字は対象外）。 */
const SYMBOL_REPEAT_RE = /([^\p{L}\p{N}\s])\1{3,}/u;

const MIN_TITLE_CHARS = 2;

const TITLE_FILTER_FAIL: GateResult = { ok: false, reason: "title_filter" };

/**
 * タイトル公開フィルタ（plan 07 §5-M1）。第三者が書いた文字列を無検閲で
 * 公開しないための関門。棄却しても取り込み自体は妨げない
 * （呼び出し側が `status` を published にしない、という運用）。
 */
export function filterTitle(title: string): GateResult {
  const trimmed = title.trim();
  if (trimmed.length < MIN_TITLE_CHARS) return TITLE_FILTER_FAIL;

  if (CONTROL_CHAR_RE.test(title)) return TITLE_FILTER_FAIL;

  const emojiMatches = title.match(EMOJI_RE);
  if (emojiMatches && emojiMatches.length > MAX_EMOJI_COUNT) return TITLE_FILTER_FAIL;

  if (SYMBOL_REPEAT_RE.test(title)) return TITLE_FILTER_FAIL;

  const normalized = trimmed.normalize("NFKC");
  const lower = normalized.toLowerCase();

  if (LOOSE_AD_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return TITLE_FILTER_FAIL;
  }

  if (containsStrictAdToken(normalized)) return TITLE_FILTER_FAIL;

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// checkAnchorGrounding（M1: topicAnchor の語彙的接地）
// ─────────────────────────────────────────────────────────────

/**
 * `topicAnchor` を、日本語の助詞・句読点・空白で区切ることで特徴語候補に
 * 分割する。形態素解析には依存しない（plan 07 §5-M1 の方針どおり）ため、
 * 助詞が語の内部に現れるケース（例:「におい」の "に"）を誤って分割する
 * ことがあり得るが、fail-closed な接地チェックとしては安全側に働く
 * （分割された断片が本文に無ければアンカーごと棄却されるため）。
 */
const PARTICLE_SPLIT_RE =
  /(?:の|を|に|は|が|で|と|も|や|から|まで|より|へ|・|、|。|「|」|【|】|\[|\]|\(|\)|\s+)/g;

/** 記号・数字のみで構成される語（特徴語として無意味）を除外する判定。 */
const SYMBOL_OR_DIGIT_ONLY_RE = /^[\p{P}\p{S}0-9０-９\s]+$/u;

function extractFeatureTerms(topicAnchor: string): string[] {
  const normalized = topicAnchor.normalize("NFKC");
  const rawTerms = normalized.split(PARTICLE_SPLIT_RE);
  const terms = rawTerms
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !SYMBOL_OR_DIGIT_ONLY_RE.test(t));
  return Array.from(new Set(terms));
}

function normalizeForGrounding(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/**
 * topicAnchor の語彙的接地（plan 07 §5-M1）。アンカーから抽出した
 * 2文字以上の特徴語すべてが、取得本文（`bodyText`）に逐語で存在することを
 * 要求する。1つでも欠ければ棄却。特徴語が1つも抽出できないアンカーも
 * 棄却する（接地を検証できないため fail-closed）。
 *
 * 誤棄却率を計測できるよう、棄却時は `missingTerms` に本文中に無かった語を
 * 詰めて返す（`missingTerms.length === 0` は「特徴語ゼロ」による棄却を表す）。
 */
export function checkAnchorGrounding(topicAnchor: string, bodyText: string): GateResult {
  const terms = extractFeatureTerms(topicAnchor);
  if (terms.length === 0) {
    return { ok: false, reason: "anchor_ungrounded", missingTerms: [] };
  }

  const normalizedBody = normalizeForGrounding(bodyText);
  const missingTerms = terms.filter(
    (term) => !normalizedBody.includes(normalizeForGrounding(term)),
  );

  if (missingTerms.length > 0) {
    return { ok: false, reason: "anchor_ungrounded", missingTerms };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// renderRationaleText（Q5: rationaleText のテンプレート化）
// ─────────────────────────────────────────────────────────────

/** LLM の有用度判定 6 boolean。フィールド名は `src/lib/llm/schemas.ts` の
 * `CurationItemSchema` と一致させること。 */
export interface RationaleUsefulnessFlags {
  firsthand: boolean;
  ceremonyDecision: boolean;
  specific: boolean;
  tradeoff: boolean;
  promotional: boolean;
  preDecisionOrPhotoShoot: boolean;
}

export interface RationaleTemplateInput {
  topicAnchor: string;
  usefulness: RationaleUsefulnessFlags;
}

/**
 * 固定のラベル対応表。フラグ名 → 決定的な日本語ラベル。数字・固有の表現・
 * 原文からの引用は一切含めない（spec.md §10-3 を証明可能にするのが目的）。
 */
const USEFULNESS_LABELS: Record<keyof RationaleUsefulnessFlags, string> = {
  firsthand: "実際に挙式・披露宴を経験した立場からの記述である",
  ceremonyDecision: "挙式・披露宴の中身の意思決定に役立つ内容を含む",
  specific: "具体的な選択や工夫についての記述がある",
  tradeoff: "判断の理由や振り返りが述べられている",
  promotional: "特定のサービス・会場への誘導を含む可能性がある",
  preDecisionOrPhotoShoot: "式場決定前の段階や前撮り・後撮りに関する話題が中心である",
};

/** テンプレート内での出現順序（判定意図の一貫性のため固定）。 */
const FLAG_ORDER: (keyof RationaleUsefulnessFlags)[] = [
  "firsthand",
  "ceremonyDecision",
  "specific",
  "tradeoff",
  "promotional",
  "preDecisionOrPhotoShoot",
];

/**
 * Q5: 構造化フィールド（`topicAnchor` + 6 boolean）から根拠文を決定的に
 * 生成する。LLM の自由文は一切受け取らない。同一入力からは常に同一出力に
 * なる純粋関数。
 */
export function renderRationaleText(input: RationaleTemplateInput): string {
  const activeLabels = FLAG_ORDER.filter((flag) => input.usefulness[flag]).map(
    (flag) => USEFULNESS_LABELS[flag],
  );

  const anchorPhrase = `「${input.topicAnchor}」に関する記事`;

  if (activeLabels.length === 0) {
    return `${anchorPhrase}です。自動判定では特筆すべき特徴は検出されませんでした。`;
  }

  return `${anchorPhrase}で、${activeLabels.join("、")}という特徴が自動判定されました。`;
}
