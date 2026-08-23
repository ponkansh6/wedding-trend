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
});
