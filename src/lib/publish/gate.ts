/**
 * plan 07 §5-M1 「無検閲の公開チャネルを閉じる」の実装。
 *
 * ここに置く関数はすべて純粋関数（DB・ネットワーク・ファイルシステムに一切
 * 触れない）。パイプラインへの結線（どこでこれらを呼ぶか）は別レーンが担う。
 *
 * このモジュールが閉じる経路:
 * - `filterTitle`: 第三者（元サイト）が書いた逐語タイトルの無検閲公開
 * - `validateTopicAnchor`（`checkAnchorLength` + `checkAnchorDenylist`）:
 *   LLM が出力する `topicAnchor` の長さ下限と個人識別情報 denylist を機械強制する
 * - `renderRationaleText`: 根拠文を LLM の自由生成から締め出し、
 *   構造化フィールド（`topicAnchor` + 6 boolean）からの決定的なテンプレート
 *   生成に置き換える（plan 07 §6-Q5）
 */

import { RATIONALE_TEXT_MAX_CHARS, RATIONALE_TEXT_MIN_CHARS } from "@/lib/constants";
import type { DropReason } from "@/lib/types";

export type GateResult =
  | { ok: true }
  | {
      ok: false;
      reason: DropReason;
      missingTerms?: string[];
      /**
       * `anchor_prohibited_term`（`checkAnchorDenylist`）で、実際に抵触した
       * denylist 語・パターンの照合結果（マッチした部分文字列）。可視化専用の
       * 追加情報であり、判定ロジック自体には一切影響しない
       * （バックフィルのドライラン等で「なぜ落ちたか」を人が読める形にするため。
       * `src/lib/publish/gate.ts` の `checkAnchorDenylist` JSDoc 参照）。
       */
      matchedTerms?: string[];
    };

// ─────────────────────────────────────────────────────────────
// filterTitle（M1: タイトル公開フィルタ）
// ─────────────────────────────────────────────────────────────

/**
 * 制御文字（タブ・改行は `normalizeTitle` により取り込み段階ですでに単一スペースに正規化されることを
 * 前提とするためここではチェックから除外し、その他の C0/C1 制御文字・DEL のみを検知する）。
 * なお、正規化漏れ等の最終防衛線として一律拒否する設計（Option A）も考えられるが、本プロジェクトでは
 * インゲスト時の `normalizeTitle` を主防壁とし、ここでは通常のC0/C1制御文字のみを対象とする（Option B方針）。
 */
// oxlint-disable-next-line no-control-regex -- 制御文字の検知そのものが目的で意図的。
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * 絵文字・記号ピクトグラフの許容上限（これを超えるタイトルは過剰装飾として棄却）。
 * 2026-08-29 のゲート緩和で 3 → 10。
 */
const MAX_EMOJI_COUNT = 10;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** 同一の記号文字が 4 連以上続く記号連打（英数字・空白・日本語文字は対象外）。 */
const SYMBOL_REPEAT_RE = /([^\p{L}\p{N}\s])\1{3,}/u;

const MIN_TITLE_CHARS = 2;

const TITLE_FILTER_FAIL: GateResult = { ok: false, reason: "title_filter" };

/**
 * タイトル公開フィルタ（plan 07 §5-M1）。第三者が書いた文字列を無検閲で
 * 公開しないための関門。棄却しても取り込み自体は妨げない
 * （呼び出し側が `status` を published にしない、という運用）。
 *
 * 2026-08-29 のゲート緩和: 広告・PR 系キーワード（広告・タイアップ・提供・
 * 【PR】【AD】等）による棄却を撤廃した。残すのは、そもそも表示が壊れる／
 * 空タイトルという機械的に明白なケースのみ（制御文字・記号連打・過剰絵文字・
 * 最小文字数）。
 */
export function filterTitle(title: string): GateResult {
  const trimmed = title.trim();
  if (trimmed.length < MIN_TITLE_CHARS) return TITLE_FILTER_FAIL;

  if (CONTROL_CHAR_RE.test(title)) return TITLE_FILTER_FAIL;

  const emojiMatches = title.match(EMOJI_RE);
  if (emojiMatches && emojiMatches.length > MAX_EMOJI_COUNT) return TITLE_FILTER_FAIL;

  if (SYMBOL_REPEAT_RE.test(title)) return TITLE_FILTER_FAIL;

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// トピックアンカーの特徴語抽出（extractFeatureTerms / validateTopics で使用）
// ─────────────────────────────────────────────────────────────

/**
 * `topicAnchor` を、日本語の助詞・句読点・空白で区切ることで特徴語候補に
 * 分割する。形態素解析には依存しない（plan 07 §5-M1 の方針どおり）ため、
 * 助詞が語の内部に現れるケース（例:「におい」の "に"）を誤って分割する
 * ことがあり得る。現在は `validateTopics` の固有名詞タイトル接地と
 * `curateBatch` の再試行フィードバック生成でのみ使う。
 */
const PARTICLE_SPLIT_RE =
  /(?:の|を|に|は|が|で|と|も|や|から|まで|より|へ|・|、|。|「|」|【|】|\[|\]|\(|\)|\s+)/g;

/**
 * Grounding allowlist: kanji-only functional nouns that are genuinely a closed class
 * and may appear in an anchor WITHOUT needing a verbatim source match.
 * Content nouns and other tokens must be grounded per the asymmetric character-type rules.
 */
const CONNECTOR_ALLOWLIST = new Set<string>(["理由", "背景", "経緯", "決め手"]);

/** 記号・数字のみで構成される語（特徴語として無意味）を除外する判定。 */
const SYMBOL_OR_DIGIT_ONLY_RE = /^[\p{P}\p{S}0-9０-９\s]+$/u;

export function extractFeatureTerms(topicAnchor: string): string[] {
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

function isLikelyProperNoun(topic: string): boolean {
  return /[\u30A0-\u30FF]/.test(topic);
}

/**
 * topicAnchor の denylist 検証。
 *
 * - **2026-08-29 (第1段)**: clickbait 語群（衝撃・必見・やばい・最高・神・感動 等）
 *   と語尾パターン（しよう/すべき/N つの）を撤廃。
 * - **2026-08-29 (第2段, オーナー判断)**: 数値・漢数字・金額・日付パターンも撤廃した。
 *   漢数字パターン（`一二三…`）が「二部制」「三次会」「一緒に」等の非数値語を
 *   過剰棄却していたのが直接の契機。数値開示の抑制は接地検証（コーパスに実在
 *   する語しか使えない）と `renderRationaleText` 側の数値 refine（spec §10 K9）
 *   に委ね、アンカーの denylist としては**個人識別情報のみ**を残す。
 *
 * `matchedTerms` には発火した個人識別情報パターンの識別子
 * （`"personal_info_sns_handle"` / `"personal_info_honorific"`）を入れる
 * （実際の氏名・ハンドル文字列自体は含めない）。
 */
export function checkAnchorDenylist(topicAnchor: string): GateResult {
  const personalInfoRule = findPersonalInfoMatchRule(topicAnchor);
  if (personalInfoRule !== null) {
    return {
      ok: false,
      reason: "anchor_prohibited_term",
      missingTerms: [],
      matchedTerms: [personalInfoRule],
    };
  }
  return { ok: true };
}

/** アンカー長の下限。2026-08-29 のゲート緩和で 12 → 6。 */
export const ANCHOR_MIN_LENGTH = 6;

export function checkAnchorLength(topicAnchor: string): GateResult {
  if (topicAnchor.trim().length < ANCHOR_MIN_LENGTH) {
    return { ok: false, reason: "anchor_too_short", missingTerms: [] };
  }
  return { ok: true };
}

export function validateTopicAnchor(
  topicAnchor: string,
  _opts: { corpus: string; title: string },
): GateResult {
  const lenRes = checkAnchorLength(topicAnchor);
  if (!lenRes.ok) return lenRes;

  const denyRes = checkAnchorDenylist(topicAnchor);
  if (!denyRes.ok) return denyRes;

  // 2026-08-29 のゲート緩和で、語彙的接地検証（コーパス許可制度）とタイトル冗長性
  // 検証は `validateTopicAnchor` から外れた。アンカーの語が元記事本文に逐語で存在
  // することは要求しない。ハルシネーション抑制はプロンプト指示と有用度評価タグに
  // 委ねる。shared_plan/20 P4 で、呼び出し元の無かった休眠関数
  // `checkAnchorGrounding` / `checkAnchorNovelty` は削除した（git 履歴に残る）。
  // 現在アンカーに対する機械的検証は上記2点（長さ下限・PII denylist）のみ。

  return { ok: true };
}

export type TopicsGateResult =
  | { ok: true; topics: string[] }
  | { ok: false; dropped: string[]; reasons: Record<string, string> };

const PUNCTUATION_OR_SYMBOL_RE = /[\p{P}\p{S}\s]+/u;
const DIGIT_RE = /[0-9０-９]/u;

export function validateTopics(
  topics: string[],
  originalTitle: string,
  opts?: { topicAnchor?: string },
): TopicsGateResult {
  const kept: string[] = [];
  const dropped: string[] = [];
  const reasons: Record<string, string> = {};

  const titleTerms = new Set(extractFeatureTerms(originalTitle).map(normalizeForGrounding));

  // 重複排除のための Set（normalize 済み文字列をキーにする）
  const seenNormalized = new Set<string>();

  for (const rawTopic of topics) {
    const trimmed = rawTopic.trim();
    const normalized = trimmed.normalize("NFKC");

    // 1. 長さチェック (2〜10字)
    if (normalized.length < 2 || normalized.length > 10) {
      dropped.push(rawTopic);
      reasons[rawTopic] = "length_out_of_bounds";
      continue;
    }

    // 2. 数字禁止
    if (DIGIT_RE.test(normalized)) {
      dropped.push(rawTopic);
      reasons[rawTopic] = "contains_digit";
      continue;
    }

    // 3. 記号・URL・絵文字・句読点・空白の禁止
    if (PUNCTUATION_OR_SYMBOL_RE.test(normalized) || EMOJI_RE.test(normalized)) {
      dropped.push(rawTopic);
      reasons[rawTopic] = "contains_symbol_or_punctuation";
      continue;
    }

    // 4. PII denylist
    if (containsPersonalInfoPattern(normalized)) {
      dropped.push(rawTopic);
      reasons[rawTopic] = "contains_pii";
      continue;
    }

    // 5. topicAnchor と同一なら除外
    if (opts?.topicAnchor && normalized === opts.topicAnchor.normalize("NFKC").trim()) {
      dropped.push(rawTopic);
      reasons[rawTopic] = "identical_to_anchor";
      continue;
    }

    // 6. 重複排除
    const key = normalized.toLowerCase();
    if (seenNormalized.has(key)) {
      dropped.push(rawTopic);
      reasons[rawTopic] = "duplicate_topic";
      continue;
    }

    // 7. 固有名詞のタイトル接地（カタカナを含むトピックのみ接地チェックを適用。主要語のいずれかがタイトルに含まれれば許可）
    if (isLikelyProperNoun(normalized)) {
      const topicTerms = extractFeatureTerms(normalized).filter(
        (t) => t.length >= 2 && !CONNECTOR_ALLOWLIST.has(t),
      );
      if (topicTerms.length > 0) {
        const hasAny = topicTerms.some((term) => titleTerms.has(normalizeForGrounding(term)));
        if (!hasAny) {
          dropped.push(rawTopic);
          reasons[rawTopic] = "ungrounded_proper_noun";
          continue;
        }
      }
    }

    seenNormalized.add(key);
    kept.push(normalized);
  }

  // 最大4件に切り詰め（安全化）
  const finalTopics = kept.slice(0, 4);

  return {
    ok: true,
    topics: finalTopics,
  };
}

/**
 * 敬称の直前に付く一般名詞（人物を指さない用法）。「〜さん」等の敬称
 * パターンにマッチしても、この直前語を伴う場合は個人名ではないとみなし
 * 過剰棄却を避ける。例:「みなさん」「おふたりさん」「新郎新婦さん」
 * 「花嫁さん」「ゲストさん」「お客さん」。
 *
 * このリストは決定的な除外の要（過剰棄却対策の採用方式）。パターン自体を
 * 絞り込むアプローチではなく、「敬称パターンはやや広めに取り、既知の
 * 一般語のみ明示的に除外する」方式を採用した——一般語のバリエーションは
 * 有限で列挙可能な一方、日本語の人名は事実上無限にバリエーションがあり
 * パターン側を絞る方向では個人名を取りこぼすため。
 */
const HONORIFIC_SAFE_PREFIXES = [
  "みな",
  "皆",
  "おふたり",
  "お二人",
  "ふたり",
  "二人",
  "新郎新婦",
  "新郎",
  "新婦",
  "花嫁",
  "花婿",
  "ゲスト",
  "お客",
  "参列者",
  "スタッフ",
  "プランナー",
];

/**
 * 敬称を伴う表記（「〜さん」「〜様」「〜氏」「〜くん」「〜ちゃん」）を検知する。
 * 敬称の直前 1〜10 文字を氏名候補として取り出し、`HONORIFIC_SAFE_PREFIXES`
 * のいずれとも完全一致しない場合のみ個人名候補と判定する。
 */
const HONORIFIC_RE = /([\p{L}\p{N}ー]{1,10})(さん|様|氏|くん|君|ちゃん)/gu;

/** SNS ハンドルの形（`@` + 英数字・アンダースコア・ピリオドの連続）。 */
const SNS_HANDLE_RE = /@[A-Za-z0-9_.]{2,}/;

/**
 * 個人識別情報らしきパターンを検知する（プロンプト制約だけに頼らない
 * 決定的な二重防御）。`topicAnchor` に対して用いる想定。
 * 完全な日本語人名判定は不可能なため、再現性のある保守的なパターンのみ
 * 扱う。誤検知（過剰棄却）を避けるため、敬称直前語が既知の一般語と
 * 完全一致する場合は個人名候補から除外する。
 */
/** `findPersonalInfoMatchRule` が返す、発火した個人識別情報パターンの識別子。 */
type PersonalInfoRule = "personal_info_sns_handle" | "personal_info_honorific";

/**
 * 個人識別情報らしきパターン（SNS ハンドル・敬称付き氏名）に実際にマッチした
 * 場合、どちらのパターンが発火したかの識別子を返す（マッチしなければ
 * `null`）。判定条件自体は元の `containsPersonalInfoPattern` 実装と完全に
 * 同一——可視化目的で呼び出し元がルール識別子を使えるように、真偽値では
 * なくラベル付きの結果を返す形へ抽出しただけである（実際の氏名・ハンドル
 * 文字列そのものは返さない。ログに個人名が残ることを避けるため）。
 */
function findPersonalInfoMatchRule(text: string): PersonalInfoRule | null {
  const normalized = text.normalize("NFKC");

  if (SNS_HANDLE_RE.test(normalized)) return "personal_info_sns_handle";

  const honorificMatches = normalized.matchAll(HONORIFIC_RE);
  for (const match of honorificMatches) {
    const candidate = match[1];
    if (!HONORIFIC_SAFE_PREFIXES.includes(candidate)) return "personal_info_honorific";
  }

  return null;
}

function containsPersonalInfoPattern(text: string): boolean {
  return findPersonalInfoMatchRule(text) !== null;
}

// ─────────────────────────────────────────────────────────────
// renderRationaleText（Q5: rationaleText のテンプレート化）
// ─────────────────────────────────────────────────────────────

/** LLM の有用度判定 5 つ（すべて 0-9）。フィールド名は `src/lib/llm/schemas.ts` の
 * `CurationItemSchema` と一致させること。 */
export interface RationaleUsefulnessFlags {
  firsthand: number;
  ceremonyDecision: number;
  specific: number;
  weddingDayContent: number;
  promotional: number;
}

export interface RationaleTemplateInput {
  topicAnchor: string;
  usefulness: RationaleUsefulnessFlags;
}

/**
 * 固定のラベル対応表。フラグ名 → 決定的な日本語ラベル。数字・固有の表現・
 * 原文からの引用は一切含めない（spec.md §10-3 を証明可能にするのが目的）。
 */
const USEFULNESS_LABELS = {
  firsthand: "実際に挙式・披露宴を経験した立場からの記述である",
  ceremonyDecision: "挙式・披露宴の中身の意思決定に役立つ内容を含む",
  specific: "具体的な選択や工夫についての記述がある",
  weddingDayContent: "フルパッケージ結婚式当日の内容（進行・演出など）に具体的に触れている",
} satisfies Partial<Record<keyof RationaleUsefulnessFlags, string>>;

/** テンプレート内での出現順序（判定意図の一貫性のため固定）。
 * `promotional` は spec.md §10-3（否定的評価を公開画面に一切出さない）に
 * より根拠文のラベル対象から除外する。`RationaleUsefulnessFlags` には
 * フィールドとして残るが、ここでは参照しない。 */
const FLAG_ORDER: (keyof typeof USEFULNESS_LABELS)[] = [
  "firsthand",
  "ceremonyDecision",
  "specific",
  "weddingDayContent",
];

/**
 * Q5: 構造化フィールド（`topicAnchor` + ラベル対象の 4 判定値）から根拠文を決定的に
 * 生成する。LLM の自由文は一切受け取らない。同一入力からは常に同一出力に
 * なる純粋関数。2026-08-30 の 0-9 化以降、ラベルを付けるのは値が `>= 6`
 * （はっきり該当）の項目のみ。
 */
export function renderRationaleText(input: RationaleTemplateInput): string {
  const activeLabels = FLAG_ORDER.filter((flag) => input.usefulness[flag] >= 6).map(
    (flag) => USEFULNESS_LABELS[flag],
  );

  const anchorPhrase = `「${input.topicAnchor}」に関する記事`;

  const text =
    activeLabels.length === 0
      ? `${anchorPhrase}です。自動判定では特筆すべき特徴は検出されませんでした。`
      : `${anchorPhrase}で、${activeLabels.join("、")}という特徴が自動判定されました。`;

  // 決定的テンプレートである以上、上限超過は入力データの異常ではなく実装
  // バグ（ラベル文言・組み立てロジックが上限を踏まえずに変更された等）を
  // 意味する。フォールバックとして黙って切り詰めると文が途中で切れたまま
  // 公開されてしまうため、ここで確実に気づける形（例外）にする。
  if (text.length > RATIONALE_TEXT_MAX_CHARS) {
    throw new Error(
      `[gate] renderRationaleText() produced ${text.length} chars, exceeding ` +
        `RATIONALE_TEXT_MAX_CHARS (${RATIONALE_TEXT_MAX_CHARS}). This is a template ` +
        "implementation bug, not a data issue — renderRationaleText() is a deterministic " +
        "pure function.",
    );
  }

  // 下限側も上限側と対称に扱う。決定的テンプレートである以上、下限割れも
  // 入力データの異常ではなく実装バグ（ラベル文言の削除・組み立てロジックの
  // 変更等）を意味する。呼び出し元は公開前に `validateTopicAnchor()`
  // （`checkAnchorLength` の下限 6 字）を通しているため、ここに届く
  // `topicAnchor` は通常 6 字以上——この関数に単独で min(1) の入力が
  // 渡ることは想定しない。
  if (text.length < RATIONALE_TEXT_MIN_CHARS) {
    throw new Error(
      `[gate] renderRationaleText() produced ${text.length} chars, below ` +
        `RATIONALE_TEXT_MIN_CHARS (${RATIONALE_TEXT_MIN_CHARS}). This is a template ` +
        "implementation bug, not a data issue — renderRationaleText() is a deterministic " +
        "pure function.",
    );
  }

  return text;
}
