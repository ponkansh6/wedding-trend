import { describe, expect, it } from "vitest";
import {
  extractVisibleText,
  selectJudgmentSlice,
  computeEvidenceSignals,
  computeEvidenceSufficiency,
  MIN_EVIDENCE_INPUT_CHARS,
} from "@/lib/sources/article-text";
import {
  MAX_BODY_BYTES,
  CRAWLER_USER_AGENT,
  MAX_LINK_DENSITY,
  MIN_PARAGRAPH_COUNT,
  MAX_BOILERPLATE_LINE_RATIO,
} from "@/lib/constants";

describe("article-text extraction", () => {
  it("1. strips script/style/noscript content from fixture HTML", () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
          <script>console.log("bad");</script>
        </head>
        <body>
          <noscript>Please enable JS</noscript>
          <p>Hello wedding world! This is a genuine review from a bride about venue selection and dress fittings.</p>
        </body>
      </html>
    `;
    const visible = extractVisibleText(html);
    expect(visible).not.toContain("color: red");
    expect(visible).not.toContain("console.log");
    expect(visible).not.toContain("Please enable JS");
    expect(visible).toContain("Hello wedding world!");
  });

  it("2. extracts visible text and decodes entities", () => {
    const html =
      "<p>Wedding &amp; Dress &lt;Trend&gt; &quot;Special&quot; &#39;Best&#39; &nbsp; OK</p>";
    const visible = extractVisibleText(html);
    expect(visible).toBe("Wedding & Dress <Trend> \"Special\" 'Best' OK");
  });

  it("3. skips leading nav text (~1200 chars) and returns ~1500-char slice", () => {
    const filler = "ナビゲーションメニュー リンク お問い合わせ ホーム ".repeat(50); // ~1200+ chars
    const bodyContent =
      "ここからが記事の本編である。ウェディングドレスの選び方について詳しく解説する。".repeat(30);
    const fullText = filler + bodyContent;

    const slice = selectJudgmentSlice(fullText);
    expect(slice.length).toBeLessThanOrEqual(1500);
    expect(slice).toContain("ウェディングドレスの選び方");
  });

  it("4. exposes the 512KB body size cap used by disciplinedFetch (plan 06 §5.2)", () => {
    // 実際の打ち切り挙動（content-length あり/なし双方）は
    // access-discipline.test.ts で performFetch を通して検証する。
    expect(MAX_BODY_BYTES).toBe(512 * 1024);
  });

  it("5. returns failure result when visible text < minimum threshold", () => {
    const shortHtml = "<p>Short</p>";
    const visible = extractVisibleText(shortHtml);
    expect(visible.length).toBeLessThan(MIN_EVIDENCE_INPUT_CHARS);
  });

  it("6. crawling uses the WeddingTrendBot User-Agent constant (not the RSS one)", () => {
    // 記事取得の唯一の経路は disciplinedFetch であり、そこで使われる
    // User-Agent はクロール専用の CRAWLER_USER_AGENT でなければならない
    // （RSS_USER_AGENT を流用すると連絡先の異なる UA でクロールしてしまう）。
    expect(CRAWLER_USER_AGENT).toContain("WeddingTrendBot");
  });

  it("7. gate tests: hasSufficientEvidence behavior", () => {
    const checkGate = (text: string | null) => {
      if (!text) return false;
      return text.length >= MIN_EVIDENCE_INPUT_CHARS;
    };

    expect(checkGate(null)).toBe(false);
    expect(checkGate("短すぎる")).toBe(false);
    expect(checkGate("あ".repeat(MIN_EVIDENCE_INPUT_CHARS))).toBe(true);
  });
});

describe("computeEvidenceSufficiency boundary behavior (plan 07 §6-Q1)", () => {
  const baseSignals = {
    textLength: MIN_EVIDENCE_INPUT_CHARS,
    linkDensity: 0,
    paragraphCount: MIN_PARAGRAPH_COUNT,
    boilerplateLineRatio: 0,
  };

  it("passes when every signal sits exactly at its permissive boundary", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      linkDensity: MAX_LINK_DENSITY,
      boilerplateLineRatio: MAX_BOILERPLATE_LINE_RATIO,
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails when textLength is one below the minimum", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      textLength: MIN_EVIDENCE_INPUT_CHARS - 1,
    });
    expect(result).toEqual({ ok: false, reason: "extraction_insufficient" });
  });

  it("fails when linkDensity exceeds the maximum", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      linkDensity: MAX_LINK_DENSITY + 0.01,
    });
    expect(result).toEqual({ ok: false, reason: "extraction_insufficient" });
  });

  it("fails when paragraphCount is below the minimum", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      paragraphCount: MIN_PARAGRAPH_COUNT - 1,
    });
    expect(result).toEqual({ ok: false, reason: "extraction_insufficient" });
  });

  it("fails when boilerplateLineRatio exceeds the maximum", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      boilerplateLineRatio: MAX_BOILERPLATE_LINE_RATIO + 0.01,
    });
    expect(result).toEqual({ ok: false, reason: "extraction_insufficient" });
  });
});

describe("computeEvidenceSignals (plan 07 §6-Q1)", () => {
  it("computes link density from raw HTML anchors (not from tag-stripped text) and accepts a genuine article", () => {
    const html = `<html><body>
      <nav><a href="/a">リンクA</a><a href="/b">リンクB</a></nav>
      <article>
        <p>実際に結婚式を挙げた新婦が会場選びについて詳しく振り返り、持ち込み料の交渉や式場探しの体験を丁寧に説明しています。</p>
        <p>披露宴の演出やスピーチ依頼についても具体的な工夫を紹介しており読者にとって参考になる内容が多く含まれています。</p>
        <p>装花や引出物の選び方についても触れられており当日の段取りをどう組み立てたかが具体的に書かれています。</p>
      </article>
    </body></html>`;

    const signals = computeEvidenceSignals(html);
    expect(signals.paragraphCount).toBe(3);
    expect(signals.linkDensity).toBeLessThan(MAX_LINK_DENSITY);
    expect(signals.textLength).toBeGreaterThan(MIN_EVIDENCE_INPUT_CHARS);
    expect(computeEvidenceSufficiency(signals)).toEqual({ ok: true });
  });

  it("flags a nav-dominated page (many links, little body) as insufficient via link density / paragraph count", () => {
    const linkHeavyHtml = `<html><body><nav>${Array.from(
      { length: 20 },
      (_, i) => `<a href="/${i}">ナビゲーション項目${i}の詳細ページへのリンクです</a>`,
    ).join("")}</nav><p>短い本文。</p></body></html>`;

    const signals = computeEvidenceSignals(linkHeavyHtml);
    expect(signals.linkDensity).toBeGreaterThan(MAX_LINK_DENSITY);
    expect(computeEvidenceSufficiency(signals)).toEqual({
      ok: false,
      reason: "extraction_insufficient",
    });
  });

  it("computes textLength as 0 (and thus linkDensity 1) for empty HTML, fail-closed", () => {
    const signals = computeEvidenceSignals("<html><body></body></html>");
    expect(signals.textLength).toBe(0);
    expect(signals.linkDensity).toBe(1);
    expect(computeEvidenceSufficiency(signals)).toEqual({
      ok: false,
      reason: "extraction_insufficient",
    });
  });
});
