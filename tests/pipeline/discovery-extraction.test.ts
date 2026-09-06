import { describe, expect, it } from "vitest";
import { computeBodyHash } from "@/lib/pipeline/body-hash";
import { extractDiscoveryArticle } from "@/lib/pipeline/discovery-extraction";
import { extractArticleContainer, extractVisibleText } from "@/lib/sources/article-text";

const HOST = "www.mwed.jp";
const FIXTURE_TEXT = "演出の予算配分を検討した当事者の具体的な記録です。";

function page(
  body: string,
  options: { htmlTitle?: string; headline?: string; paragraphs?: number; links?: string } = {},
): string {
  const htmlTitle = options.htmlTitle ?? "HTML の逐語タイトル";
  const headline = options.headline ? `<h1>${options.headline}</h1>` : "";
  const paragraphs = Array.from({ length: options.paragraphs ?? 3 }, () => `<p>${body}</p>`).join(
    "",
  );
  return `<html><head><title>${htmlTitle}</title></head><body><div class="story-detail">${headline}${options.links ?? ""}${paragraphs}</div></body></html>`;
}

describe("extractDiscoveryArticle", () => {
  it("reports a container miss without HTML or body text", () => {
    const result = extractDiscoveryArticle("<title>ページタイトル</title><main>本文</main>", HOST);
    expect(result).toEqual({ kind: "container_not_found", title: "ページタイトル" });
    expect(JSON.stringify(result)).not.toContain("本文");
  });

  it.each([
    ["text length", page("短い", { paragraphs: 3 }), "text_length"],
    [
      "link density",
      page("本文".repeat(500), { links: `<a>${"リンク".repeat(3000)}</a>`, paragraphs: 3 }),
      "link_density",
    ],
    ["paragraph count", page("本文".repeat(1000), { paragraphs: 0 }), "paragraph_count"],
  ])("reports Q1 %s failure without a text slice", (_name, html, condition) => {
    const result = extractDiscoveryArticle(html, HOST);
    expect(result.kind).toBe("extraction_insufficient");
    if (result.kind === "extraction_insufficient") {
      expect(result.failedConditions).toContain(condition);
      expect(result).not.toHaveProperty("judgmentSlice");
      expect(JSON.stringify(result)).not.toContain(FIXTURE_TEXT);
    }
  });

  it("uses h1 before HTML title and returns only the needed ready values", () => {
    const result = extractDiscoveryArticle(
      page(FIXTURE_TEXT.repeat(80), { headline: "記事見出し", paragraphs: 3 }),
      HOST,
    );
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.title).toBe("記事見出し");
      expect(result.signals.textLength).toBeGreaterThan(1500);
      const container = extractArticleContainer(
        page(FIXTURE_TEXT.repeat(80), { headline: "記事見出し", paragraphs: 3 }),
        HOST,
      );
      expect(container).not.toBeNull();
      expect(result.bodyHash).toBe(computeBodyHash(extractVisibleText(container!)));
      expect(Object.keys(result)).toEqual([
        "kind",
        "title",
        "signals",
        "judgmentSlice",
        "bodyHash",
      ]);
      for (const forbidden of ["html", "body", "container", "rawText", "visibleText"]) {
        expect(result).not.toHaveProperty(forbidden);
      }
    }
  });
});
