import { describe, expect, it } from "vitest";
import {
  filterTitle,
  checkAnchorDenylist,
  checkAnchorLength,
  validateTopicAnchor,
  renderRationaleText,
  type RationaleTemplateInput,
} from "@/lib/publish/gate";
import { RATIONALE_TEXT_MAX_CHARS, RATIONALE_TEXT_MIN_CHARS } from "@/lib/constants";

describe("filterTitle (plan 07 §5-M1: 無検閲の公開チャネルを閉じる)", () => {
  // 2026-08-29 のゲート緩和: 広告・PR 系キーワード（【PR】【AD】/ タイアップ /
  // 広告 / 提供 / スポンサー / sponsored 等）による棄却は撤廃した。これらは
  // 通過する。
  it("no longer rejects titles carrying an ad / PR marker (2026-08-29 relaxation)", () => {
    for (const title of [
      "【PR】理想の結婚式場が見つかる方法",
      "［ＰＲ］新作ウェディングドレスのご紹介",
      "【タイアップ】会場からのお知らせ",
      "[広告] 式場フェア開催中",
      "スポンサー企業からのお知らせ",
      "プロモーション企画:結婚式アイデア集",
      "This is a Sponsored post about wedding venues",
      "結婚式レポ #PR",
      "[AD] 憧れの会場を紹介します",
    ]) {
      expect(filterTitle(title)).toEqual({ ok: true });
    }
  });

  it("does NOT reject titles where PR/AD appear only as part of a longer English word", () => {
    expect(filterTitle("PRESS RELEASE: 結婚式トレンド最新情報")).toEqual({ ok: true });
    expect(filterTitle("ADVICE for choosing your wedding venue")).toEqual({ ok: true });
    expect(filterTitle("結婚式のADVANCE予約について")).toEqual({ ok: true });
  });

  it("accepts an ordinary, well-formed title", () => {
    expect(filterTitle("実際に挙式を挙げて分かった会場選びのポイント")).toEqual({ ok: true });
  });

  it("rejects empty, whitespace-only, and too-short titles", () => {
    expect(filterTitle("")).toEqual({ ok: false, reason: "title_filter" });
    expect(filterTitle("   ")).toEqual({ ok: false, reason: "title_filter" });
    expect(filterTitle("あ")).toEqual({ ok: false, reason: "title_filter" });
  });

  it("rejects titles containing control characters", () => {
    expect(filterTitle(`結婚式レポート${String.fromCharCode(7)}不正な制御文字`)).toEqual({
      ok: false,
      reason: "title_filter",
    });
  });

  it("rejects titles with excessive emoji (2026-08-29: 上限 10)", () => {
    expect(filterTitle("結婚式レポート🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉")).toEqual({
      ok: false,
      reason: "title_filter",
    });
  });

  it("accepts titles with a small, reasonable number of emoji", () => {
    expect(filterTitle("結婚式レポート🎉🎉🎉 会場選びのコツ")).toEqual({ ok: true });
  });

  it("rejects titles with 4+ repeated symbol characters", () => {
    expect(filterTitle("結婚式レポート!!!!必見")).toEqual({ ok: false, reason: "title_filter" });
    expect(filterTitle("会場選び〜〜〜〜のコツ")).toEqual({ ok: false, reason: "title_filter" });
  });

  it("does not reject ordinary punctuation repeated fewer than 4 times", () => {
    expect(filterTitle("結婚式レポート!!会場選びのコツ")).toEqual({ ok: true });
  });
});

describe("New Anchor Gate Checks (D3, D6, validateTopicAnchor)", () => {
  it("D3: hard denylist — 残すのは個人識別情報のみ（2026-08-29 第2段: 数値・日付・金額・漢数字パターンも撤廃）", () => {
    // 残す: 個人識別情報（SNS ハンドル・敬称付き人名）。
    expect(checkAnchorDenylist("@yamada さんの話").ok).toBe(false);
    expect(checkAnchorDenylist("マイさんが悩んだ席次").ok).toBe(false);
    // 撤廃: 数値・金額・日付・元号・漢数字は通す（接地検証と根拠文の数値 refine に委ねる）。
    expect(checkAnchorDenylist("30万の節約術").ok).toBe(true);
    expect(checkAnchorDenylist("結婚式は20万円").ok).toBe(true);
    expect(checkAnchorDenylist("令和7年のトレンド").ok).toBe(true);
    expect(checkAnchorDenylist("二部制ウェディングをどう組んだか").ok).toBe(true); // 漢数字の過剰棄却解消
    // 撤廃: clickbait 語・語尾パターン。
    expect(checkAnchorDenylist("衝撃の事実").ok).toBe(true);
    expect(checkAnchorDenylist("会場をどう選ぼう").ok).toBe(true);
  });

  it("D3 可視化対応: checkAnchorDenylist は抵触した個人識別情報パターンの識別子を matchedTerms として返す", () => {
    const snsHit = checkAnchorDenylist("@yamada さんの話");
    expect(snsHit.ok).toBe(false);
    if (!snsHit.ok) {
      expect(snsHit.reason).toBe("anchor_prohibited_term");
      expect(snsHit.matchedTerms).toEqual(["personal_info_sns_handle"]);
    }

    const honorificHit = checkAnchorDenylist("マイさんの会場選び");
    expect(honorificHit.ok).toBe(false);
    if (!honorificHit.ok) {
      expect(honorificHit.matchedTerms).toEqual(["personal_info_honorific"]);
    }

    // gate 通過時は matchedTerms を持たない。
    const passing = checkAnchorDenylist("持ち込み料は20万円かかった話");
    expect(passing).toEqual({ ok: true });
  });

  it("D6: length tier — 下限 6（2026-08-29: 12 から緩和）", () => {
    expect(checkAnchorLength("あいうえ").ok).toBe(false); // 4 < 6
    expect(checkAnchorLength("あいうえお").ok).toBe(false); // 5 < 6（境界の直下）
    expect(checkAnchorLength("あいうえおか").ok).toBe(true); // 6（境界ちょうど）
    expect(checkAnchorLength("式場見学のポイントについて詳しく紹介").ok).toBe(true);
  });

  it("validateTopicAnchor orchestration", () => {
    const corpus = "本日はホテルの館内案内と実際に何が起きているのかをご案内します。";
    const title = "式場見学で確認すべきポイント";

    // Good anchor
    const good = validateTopicAnchor("館内案内で実際に何が起きているのか", { corpus, title });
    expect(good).toEqual({ ok: true });

    // 2026-08-29: タイトル冗長性は validateTopicAnchor の合否に用いない。
    // 接地さえ成立すれば、タイトルと語が丸かぶりでも通す。
    const redundant = validateTopicAnchor("式場見学の件数と決定理由", {
      corpus:
        "本日はホテルの館内案内と実際に何が起きているのかをご案内します。式場見学の件数と決定理由について。",
      title: "式場見学の件数と決定理由",
    });
    expect(redundant).toEqual({ ok: true });

    // Prohibited term / denylist（2026-08-29 第2段以降は個人識別情報のみ）
    const badDeny = validateTopicAnchor("マイさんが館内案内で何を確認したのか", {
      corpus: `${corpus}新婦マイさん`,
      title,
    });
    expect(badDeny.ok).toBe(false);
    if (!badDeny.ok) {
      expect(badDeny.reason).toBe("anchor_prohibited_term");
    }

    // 2026-08-29 第2段: 数値・金額はアンカーの denylist 対象外。
    const numeric = validateTopicAnchor("館内案内で20万円がどう出たのか", {
      corpus: `${corpus}20万円`,
      title,
    });
    expect(numeric).toEqual({ ok: true });

    // 2026-08-29: 語彙的接地検証（コーパス許可制度）はオーナー判断で撤廃。
    // 元記事本文に無い漢字・カタカナ語を含んでいても validateTopicAnchor は通す
    // （shared_plan/20 P4 で checkAnchorGrounding 関数自体も削除済み）。
    const ungrounded = validateTopicAnchor("函館旅行の予算をどう組んだのか", { corpus, title });
    expect(ungrounded).toEqual({ ok: true });
  });
});

describe("renderRationaleText (plan 07 §6-Q5: rationaleText のテンプレート化)", () => {
  const baseInput: RationaleTemplateInput = {
    topicAnchor: "会場選びのコツ",
    usefulness: {
      firsthand: 9,
      ceremonyDecision: 9,
      specific: 0,
      weddingDayContent: 0,
      promotional: 0,
    },
  };

  it("never includes the negative promotional label, regardless of promotional level (spec.md §10-3: 否定的評価は公開画面に一切出さない)", () => {
    const text = renderRationaleText({
      ...baseInput,
      usefulness: { ...baseInput.usefulness, promotional: 2 },
    });
    expect(text).not.toContain("特定のサービス・会場への誘導を含む可能性がある");
    expect(text).not.toContain("PR");
    expect(text).not.toContain("広告");
  });

  it("is invariant to the promotional level: output is identical across none/light/heavy for otherwise-identical input", () => {
    const withNone = renderRationaleText({
      ...baseInput,
      usefulness: { ...baseInput.usefulness, promotional: 0 },
    });
    const withLight = renderRationaleText({
      ...baseInput,
      usefulness: { ...baseInput.usefulness, promotional: 1 },
    });
    const withHeavy = renderRationaleText({
      ...baseInput,
      usefulness: { ...baseInput.usefulness, promotional: 2 },
    });
    expect(withLight).toBe(withNone);
    expect(withHeavy).toBe(withNone);
  });

  it("is deterministic: the same input always produces the same output", () => {
    const first = renderRationaleText(baseInput);
    const second = renderRationaleText({
      topicAnchor: baseInput.topicAnchor,
      usefulness: { ...baseInput.usefulness },
    });
    expect(first).toBe(second);
  });

  it("never contains digits (half-width or full-width)", () => {
    const text = renderRationaleText(baseInput);
    expect(text).not.toMatch(/[0-9０-９]/);
  });

  it("changes output when a usefulness flag changes (not a constant string)", () => {
    const withWeddingDayContent = renderRationaleText({
      ...baseInput,
      usefulness: { ...baseInput.usefulness, weddingDayContent: 9 },
    });
    const without = renderRationaleText(baseInput);
    expect(withWeddingDayContent).not.toBe(without);
  });

  it("produces a fixed fallback sentence when all usefulness flags are false", () => {
    const allFalse: RationaleTemplateInput = {
      topicAnchor: "式場探しの記録",
      usefulness: {
        firsthand: 0,
        ceremonyDecision: 0,
        specific: 0,
        weddingDayContent: 0,
        promotional: 0,
      },
    };
    expect(renderRationaleText(allFalse)).toBe(
      renderRationaleText({
        topicAnchor: "式場探しの記録",
        usefulness: { ...allFalse.usefulness },
      }),
    );
  });

  it("incorporates the topicAnchor into the generated sentence", () => {
    const text = renderRationaleText(baseInput);
    expect(text).toContain("会場選びのコツ");
  });

  it("throws when the deterministically-assembled sentence exceeds the cap via an out-of-spec topicAnchor (fail-loud, not silent truncation)", () => {
    // `topicAnchor` の zod 上限は40字（`CurationItemSchema`）。ラベル対象4項目
    // （`promotional` は spec.md §10-3 によりラベル対象外）すべて 2 の状態で、
    // その上限を大きく超える120字のアンカー（意図的に不正な入力）を与えると、
    // 構造的最大値（169字、40字アンカー時）をさらに超え、
    // RATIONALE_TEXT_MAX_CHARS（210字）も超過する。renderRationaleText()
    // は決定的テンプレートのため、これは実装バグまたはスキーマ制約破りを
    // 意味する - 黙って切り詰めず例外を投げること。
    const overLongInput: RationaleTemplateInput = {
      topicAnchor: "あ".repeat(120),
      usefulness: {
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 9,
        promotional: 2,
      },
    };
    expect(() => renderRationaleText(overLongInput)).toThrow();
  });

  it("never exceeds RATIONALE_TEXT_MAX_CHARS at the structural maximum: topicAnchor at the zod cap (40 chars) with all 4 labeled usefulness flags at 2", () => {
    // これが今回欠けていた保護そのもの: RATIONALE_TEXT_MAX_CHARS が
    // 構造的最大値（アンカー40字×ラベル対象フラグ4個。`promotional` は
    // spec.md § 10-3 によりラベル対象外）を常に上回ることを保証する。
    // 将来テンプレートやラベル文言を増やして構造的最大値が伸びた場合、
    // このテストが落ちて気づけるようにする。
    const structuralMaxInput: RationaleTemplateInput = {
      topicAnchor: "あ".repeat(40),
      usefulness: {
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 9,
        promotional: 2,
      },
    };
    let text = "";
    expect(() => {
      text = renderRationaleText(structuralMaxInput);
    }).not.toThrow();
    expect(text.length).toBeLessThanOrEqual(RATIONALE_TEXT_MAX_CHARS);
  });

  it("fixes the structural maximum output length (topicAnchor at the zod cap, all 4 labeled flags at 2) as a literal (regression guard against silent template growth)", () => {
    // 構造的最大値の実測: 182字（`promotional` は
    // ラベル対象外のためフラグ4個分のみで計算される）。
    // テンプレート文言やラベルを変更した際、
    // この期待値がズレることで気づけるようにする。
    // 期待値は定数から導出せずリテラルで固定する。
    const structuralMaxInput: RationaleTemplateInput = {
      topicAnchor: "あ".repeat(40),
      usefulness: {
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 9,
        promotional: 2,
      },
    };
    const text = renderRationaleText(structuralMaxInput);
    expect(text.length).toBe(169);
  });

  it("fixes the actual output length for a 4-flags-at-2 combination as a literal (regression guard against silent template growth)", () => {
    // 実データ相当: ラベル対象4項目すべて 2 + 実在ケースと同じ
    // 桁数の topicAnchor。`promotional` はラベル対象外のため値を変えても
    // 出力に影響しない。テンプレート文言を将来変更した際、
    // この期待値がズレることで気づけるようにする。
    // 期待値は定数から導出せずリテラルで固定する。
    const fiveTrueInput: RationaleTemplateInput = {
      topicAnchor: "会場選びのコツ",
      usefulness: {
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 9,
        promotional: 0,
      },
    };
    const text = renderRationaleText(fiveTrueInput);
    expect(text).toBe(
      "「会場選びのコツ」に関する記事で、実際に挙式・披露宴を経験した立場からの記述である、挙式・披露宴の中身の意思決定に役立つ内容を含む、具体的な選択や工夫についての記述がある、フルパッケージ結婚式当日の内容（進行・演出など）に具体的に触れているという特徴が自動判定されました。",
    );
    expect(text.length).toBe(136);
    expect(text.length).toBeLessThanOrEqual(RATIONALE_TEXT_MAX_CHARS);
  });

  it("does not throw for a real-data-scale case: 29-char anchor with 4 labeled flags at 2 (promotional excluded from labeling)", () => {
    // アンカー29字 × ラベル対象フラグ4個（`promotional` はラベル対象外）。
    const realDataScaleInput: RationaleTemplateInput = {
      topicAnchor: "あ".repeat(29),
      usefulness: {
        firsthand: 9,
        ceremonyDecision: 9,
        specific: 9,
        weddingDayContent: 9,
        promotional: 2,
      },
    };
    let text = "";
    expect(() => {
      text = renderRationaleText(realDataScaleInput);
    }).not.toThrow();
    expect(text.length).toBe(158);
  });

  it("fixes a structural minimum output length (2-char topicAnchor, all usefulness flags false) as a literal (regression guard against silent template shrinkage)", () => {
    // 構造的最小値の目安として topicAnchor 2 字・有用度フラグ全 false を使う。
    // （実運用のアンカー長下限は checkAnchorLength = 6 字だが、renderRationaleText
    // 自体は純関数でアンカー長を検証しない。）有用度フラグ全 false
    // の投稿を止める公開ゲートは存在しない
    // （computeUsefulnessScore() はソート用スコアであり公開可否には使われ
    // ない）。期待値は定数から導出せずリテラルで固定する。
    const structuralMinInput: RationaleTemplateInput = {
      topicAnchor: "あい",
      usefulness: {
        firsthand: 0,
        ceremonyDecision: 0,
        specific: 0,
        weddingDayContent: 0,
        promotional: 0,
      },
    };
    const text = renderRationaleText(structuralMinInput);
    expect(text).toBe(
      "「あい」に関する記事です。自動判定では特筆すべき特徴は検出されませんでした。",
    );
    expect(text.length).toBe(38);
    expect(text.length).toBeGreaterThanOrEqual(RATIONALE_TEXT_MIN_CHARS);
  });

  it("throws when the deterministically-assembled sentence falls below RATIONALE_TEXT_MIN_CHARS via an out-of-spec 1-char topicAnchor (fail-loud, symmetric with the upper-bound guard)", () => {
    // renderRationaleText() 自体はアンカー長を検証しない純関数であり、
    // zod の min(1) を満たす1字の topicAnchor をそのまま受け取れる
    // （たとえ公開経路では checkAnchorLength が別途弾くとしても）。
    // 1字アンカー・全 false は37字となり、
    // RATIONALE_TEXT_MIN_CHARS（38）を下回るため、上限超過と対称に例外を
    // 投げることを検証する。
    const belowMinInput: RationaleTemplateInput = {
      topicAnchor: "あ",
      usefulness: {
        firsthand: 0,
        ceremonyDecision: 0,
        specific: 0,
        weddingDayContent: 0,
        promotional: 0,
      },
    };
    expect(() => renderRationaleText(belowMinInput)).toThrow();
  });
});
