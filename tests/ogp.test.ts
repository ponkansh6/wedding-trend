import { describe, expect, it } from "vitest";
import { parseOgpMetadata } from "@/lib/sources/ogp";

describe("parseOgpMetadata (src/lib/sources/ogp.ts)", () => {
  it("extracts full OGP tags and JSON-LD author/datePublished", () => {
    const html = `
      <html>
        <head>
          <title>Fallback Title</title>
          <meta property="og:title" content="OGP Title &amp; More" />
          <meta property="og:description" content="OGP Description here" />
          <meta property="og:image" content="https://example.com/img.jpg" />
          <meta property="og:site_name" content="Wedding Site Name" />
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Article",
              "author": {
                "@type": "Person",
                "name": "JSON-LD Author"
              },
              "datePublished": "2026-06-01T12:00:00.000Z"
            }
          </script>
        </head>
        <body></body>
      </html>
    `;

    const meta = parseOgpMetadata(html);

    expect(meta.title).toBe("OGP Title & More");
    expect(meta.description).toBe("OGP Description here");
    expect(meta.image).toBe("https://example.com/img.jpg");
    expect(meta.siteName).toBe("Wedding Site Name");
    expect(meta.author).toBe("JSON-LD Author");
    expect(meta.datePublished).toBe("2026-06-01T12:00:00.000Z");
  });

  it("falls back to <title> and article:published_time when OGP/JSON-LD are missing", () => {
    const html = `
      <html>
        <head>
          <title>HTML Title Tag</title>
          <meta name="description" content="Standard meta description" />
          <meta property="article:published_time" content="2026-05-15T00:00:00.000Z" />
        </head>
        <body></body>
      </html>
    `;

    const meta = parseOgpMetadata(html);

    expect(meta.title).toBe("HTML Title Tag");
    expect(meta.description).toBe("Standard meta description");
    expect(meta.image).toBeNull();
    expect(meta.siteName).toBeNull();
    expect(meta.author).toBeNull();
    expect(meta.datePublished).toBe("2026-05-15T00:00:00.000Z");
  });

  it("handles attribute order variations (content before property) and entity decoding", () => {
    const html = `
      <html>
        <head>
          <meta content="Reversed &quot;Attr&quot; Order" property="og:title" />
          <meta content="Description &lt;test&gt;" name="description" />
        </head>
        <body></body>
      </html>
    `;

    const meta = parseOgpMetadata(html);

    expect(meta.title).toBe('Reversed "Attr" Order');
    expect(meta.description).toBe("Description <test>");
  });

  // T5: 本文 DOM を一切読まないことの証明（実パーサに通し、モックしない）
  it("T5: never reads body DOM — a distinctive body-only string does not leak into any parsed field", () => {
    const html = `
      <html>
        <head>
          <title>Head Title</title>
          <meta property="og:title" content="OGP Title" />
          <meta property="og:description" content="OGP Description" />
          <meta property="og:image" content="https://example.com/img.jpg" />
          <meta property="og:site_name" content="Site Name" />
        </head>
        <body>
          <p>UNIQUE_BODY_MARKER_9f3a2c</p>
          <div>UNIQUE_BODY_MARKER_9f3a2c another</div>
        </body>
      </html>
    `;

    const meta = parseOgpMetadata(html);
    const serialized = JSON.stringify(meta);

    expect(serialized).not.toContain("UNIQUE_BODY_MARKER_9f3a2c");
    expect(meta.title).toBe("OGP Title");
    expect(meta.description).toBe("OGP Description");
    expect(meta.siteName).toBe("Site Name");
  });

  // T5b: og:description が無いページでは description は null のまま。
  // 本文テキストへの「親切な」フォールバックが存在しないことの証明
  // （§10-4 / P1 ガード: 原文テキスト不在時に要約材料を捏造しないための前提）。
  it("T5b: with no meta description at all, description stays null — no body-text fallback exists", () => {
    const html = `
      <html>
        <head>
          <title>Head Title Only</title>
        </head>
        <body>
          <p>UNIQUE_BODY_MARKER_b7e41d</p>
          <article>UNIQUE_BODY_MARKER_b7e41d creative prose</article>
        </body>
      </html>
    `;

    const meta = parseOgpMetadata(html);

    expect(meta.description).toBeNull();
    expect(JSON.stringify(meta)).not.toContain("UNIQUE_BODY_MARKER_b7e41d");
  });
});
