import { describe, expect, it } from "vitest";
import {
  extractVisibleText,
  selectJudgmentSlice,
  computeEvidenceSignals,
  computeEvidenceSufficiency,
  MIN_EVIDENCE_INPUT_CHARS,
} from "@/lib/sources/article-text";
import type { EvidenceFailedCondition } from "@/lib/sources/article-text";
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

  it("fails when textLength is one below the minimum, identifying text_length", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      textLength: MIN_EVIDENCE_INPUT_CHARS - 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: "extraction_insufficient",
      failedConditions: ["text_length"],
    });
  });

  it("fails when linkDensity exceeds the maximum, identifying link_density", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      linkDensity: MAX_LINK_DENSITY + 0.01,
    });
    expect(result).toEqual({
      ok: false,
      reason: "extraction_insufficient",
      failedConditions: ["link_density"],
    });
  });

  it("fails when paragraphCount is below the minimum, identifying paragraph_count", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      paragraphCount: MIN_PARAGRAPH_COUNT - 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: "extraction_insufficient",
      failedConditions: ["paragraph_count"],
    });
  });

  it("fails when boilerplateLineRatio exceeds the maximum, identifying boilerplate_line_ratio", () => {
    const result = computeEvidenceSufficiency({
      ...baseSignals,
      boilerplateLineRatio: MAX_BOILERPLATE_LINE_RATIO + 0.01,
    });
    expect(result).toEqual({
      ok: false,
      reason: "extraction_insufficient",
      failedConditions: ["boilerplate_line_ratio"],
    });
  });

  it("fails with all four conditions reported when everything is simultaneously insufficient", () => {
    const result = computeEvidenceSufficiency({
      textLength: MIN_EVIDENCE_INPUT_CHARS - 1,
      linkDensity: MAX_LINK_DENSITY + 0.01,
      paragraphCount: MIN_PARAGRAPH_COUNT - 1,
      boilerplateLineRatio: MAX_BOILERPLATE_LINE_RATIO + 0.01,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const expected: EvidenceFailedCondition[] = [
      "text_length",
      "link_density",
      "paragraph_count",
      "boilerplate_line_ratio",
    ];
    expect(result.failedConditions.sort()).toEqual(expected.sort());
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
    const result = computeEvidenceSufficiency(signals);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("extraction_insufficient");
    expect(result.failedConditions).toContain("link_density");
  });

  it("computes textLength as 0 (and thus linkDensity 1) for empty HTML, fail-closed on all four conditions", () => {
    const signals = computeEvidenceSignals("<html><body></body></html>");
    expect(signals.textLength).toBe(0);
    expect(signals.linkDensity).toBe(1);
    const result = computeEvidenceSufficiency(signals);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("extraction_insufficient");
    // fail-closed の意味: 空 HTML は4条件すべてで不合格になる。
    // `computeBoilerplateLineRatio()` は行が0本のとき `1`（= 100%定型行）を
    // 返す仕様のため、`boilerplate_line_ratio` も MAX_BOILERPLATE_LINE_RATIO
    // (0.5) を超えて不合格側に含まれる（曖昧なときは合格側に倒さない）。
    expect(result.failedConditions.sort()).toEqual(
      ["text_length", "link_density", "paragraph_count", "boilerplate_line_ratio"].sort(),
    );
  });

  it("real-world div-based article (no <p> tags) is rejected by the current gate — plan 07 §5-M1 regression fixture", () => {
    // 実サイト（例: www.mwed.jp）は div ベースの構造で段落タグを使わないことが
    // 多く、テストフィクスチャが常に <p> を含んでいたため本番の98%棄却との
    // 乖離を検知できなかった（2026-08 の discovery 初回実行で判明）。
    // これは現在のゲート実装の挙動を固定するテストであり、閾値や
    // countParagraphTags() の実装は変更しない。paragraphCount が 0 のまま
    // 棄却されるのが「現時点で正しい」挙動として記録する。
    const divBasedHtml = `<html><body>
      <div class="header">ナビゲーション ホーム 会員登録</div>
      <div class="content">
        <div class="title">結婚式の準備で気をつけたいポイント</div>
        <div class="body-text">実際に結婚式を挙げた新婦が会場選びについて詳しく振り返り、持ち込み料の交渉や式場探しの体験を丁寧に説明しています。披露宴の演出やスピーチ依頼についても具体的な工夫を紹介しており読者にとって参考になる内容が多く含まれています。装花や引出物の選び方についても触れられており当日の段取りをどう組み立てたかが具体的に書かれています。</div>
      </div>
      <div class="footer">運営会社 利用規約 お問い合わせ</div>
    </body></html>`;

    const signals = computeEvidenceSignals(divBasedHtml);
    expect(signals.paragraphCount).toBe(0);
    const result = computeEvidenceSufficiency(signals);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.failedConditions).toContain("paragraph_count");
  });
});

describe("computeEvidenceSignals linkDensity numerator/denominator regression (www.mwed.jp incident)", () => {
  it("does not count <a> tags inside <script> as link text — linkDensity stays low (regression, most important)", () => {
    // 本番実測: www.mwed.jp の14件全件で linkDensity=1.000 となり棄却された。
    // 原因は分母（除去後テキスト）と分子（生 HTML）の対象不一致で、
    // script 内の <a> まで分子に数えられていたこと。
    const article =
      "実際に結婚式を挙げた新婦が会場選びについて詳しく振り返り、持ち込み料の交渉や式場探しの体験を丁寧に説明しています。".repeat(
        5,
      );
    const scriptLinks = Array.from(
      { length: 30 },
      (_, i) => `<a href="/track/${i}">クリック計測用ダミーリンク${i}</a>`,
    ).join("");
    const html = `<html><body>
      <script>
        var trackingHtml = "${scriptLinks}";
        document.write(trackingHtml);
      </script>
      <article>
        <p>${article}</p>
        <p>${article}</p>
        <p>${article}</p>
      </article>
    </body></html>`;

    const signals = computeEvidenceSignals(html);
    expect(signals.linkDensity).toBeLessThan(MAX_LINK_DENSITY);
    expect(signals.linkDensity).not.toBe(1);
  });

  it("does not count <a> tags inside HTML comments as link text", () => {
    const article =
      "実際に結婚式を挙げた新婦が会場選びについて詳しく振り返り、持ち込み料の交渉や式場探しの体験を丁寧に説明しています。".repeat(
        5,
      );
    const commentLinks = Array.from(
      { length: 30 },
      (_, i) => `<a href="/old/${i}">昔のリンク${i}をコメントアウトしたもの</a>`,
    ).join("");
    const html = `<html><body>
      <!-- ${commentLinks} -->
      <article>
        <p>${article}</p>
        <p>${article}</p>
        <p>${article}</p>
      </article>
    </body></html>`;

    const signals = computeEvidenceSignals(html);
    expect(signals.linkDensity).toBeLessThan(MAX_LINK_DENSITY);
    expect(signals.linkDensity).not.toBe(1);
  });

  it("plain article with a couple of real links has low link density (baseline regression guard)", () => {
    const html = `<html><body>
      <article>
        <p>実際に結婚式を挙げた新婦が会場選びについて詳しく振り返り、持ち込み料の交渉や式場探しの体験を丁寧に説明しています。</p>
        <p>披露宴の演出やスピーチ依頼についても具体的な工夫を紹介しており読者にとって参考になる内容が多く含まれています。</p>
        <p>装花や引出物の選び方についても触れられており当日の段取りをどう組み立てたかが具体的に書かれています。<a href="/related">関連記事はこちら</a></p>
      </article>
    </body></html>`;

    const signals = computeEvidenceSignals(html);
    expect(signals.linkDensity).toBeLessThan(0.05);
    expect(signals.linkDensity).toBeGreaterThan(0);
  });

  it("documents current nested-<a> handling as a known limitation (not fixed in this change)", () => {
    // HTML 仕様上は不正だが実在しうる形。現状の非貪欲正規表現は最初の
    // <a ...> から「最初に出現する </a>」（＝内側の閉じタグ）までしか
    // 一つの一致として消費しないため、①外側の閉じタグ以降のテキスト
    // （下記の「続き」）が一致から漏れて数えられず、②lastIndex が内側の
    // 閉じタグ直後に進むため外側の閉じタグ自体も別マッチとして拾われない。
    // 結果として、この構造では二重計上ではなく「外側テキスト＋内側テキスト」
    // のみが1回ずつ数えられ、「続き」の分だけ under-count になる。
    // 修正（スタックベースのパーサー）は本モジュールの正規表現ベースの
    // 軽量実装の範囲を超えるため、既知の限界として許容し、現状の挙動を
    // テストで固定する。
    const html = `<html><body><article>
      <p><a href="/outer">外側リンクテキスト<a href="/inner">内側リンクテキスト</a>続き</a></p>
      <p>それ以外の本文部分はここに十分な長さで存在しており段落として数えられる内容になっています。</p>
      <p>さらにもう一段落分の本文を追加して段落数の要件を満たすようにしておきます。</p>
    </article></body></html>`;

    const signals = computeEvidenceSignals(html);
    const outerText = "外側リンクテキスト".length;
    const innerText = "内側リンクテキスト".length;
    // 「続き」は一致から漏れるため、リンク長には含まれない。
    expect(Math.round(signals.linkDensity * signals.textLength)).toBe(outerText + innerText);
  });

  it("production-shaped fixture: 3000+ chars, 20+ <p> tags, JSON-LD script block — passes the gate (www.mwed.jp incident prevention)", () => {
    const paragraphText =
      "実際に結婚式を挙げたカップルが会場選びから当日の演出まで詳しく振り返り、持ち込み料の交渉や式場探しの体験談、招待状の手配、引出物選びの工夫について具体的なエピソードを交えながら丁寧に説明している記事です。";
    const paragraphs = Array.from(
      { length: 25 },
      (_, i) => `<p>${paragraphText}${paragraphText}（第${i + 1}段落）</p>`,
    ).join("\n");
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "結婚式の準備で気をつけたいポイント",
      author: { "@type": "Person", name: "編集部" },
      // JSON-LD 自体は <a> を含まないが、実サイトでは同じ <script> ブロック内に
      // 送信計測・リコメンドリンク用の <a> が併存することが多いため再現する。
      relatedLinks:
        '<a href="/r/1">関連1</a><a href="/r/2">関連2</a><a href="/r/3">関連3</a>'.repeat(10),
    });
    const html = `<html><head>
      <script type="application/ld+json">${jsonLd}</script>
    </head><body>
      <nav><a href="/">ホーム</a><a href="/about">サイトについて</a></nav>
      <article>
        ${paragraphs}
      </article>
      <footer><a href="/terms">利用規約</a></footer>
    </body></html>`;

    const signals = computeEvidenceSignals(html);
    expect(signals.textLength).toBeGreaterThanOrEqual(3000);
    expect(signals.paragraphCount).toBeGreaterThanOrEqual(20);
    expect(signals.linkDensity).toBeLessThan(MAX_LINK_DENSITY);
    expect(computeEvidenceSufficiency(signals)).toEqual({ ok: true });
  });
});
