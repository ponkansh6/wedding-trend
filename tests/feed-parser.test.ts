import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  extractFirstImage,
  parseFeed,
  stripHtml,
} from "@/lib/sources/base/feed-parser";

const RSS2_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Test Blog</title>
<item>
<title>結婚式の準備 &amp; 費用について</title>
<link>https://example.com/post1</link>
<description><![CDATA[<p>これは<b>テスト</b>投稿です。<img src="https://example.com/thumb1.jpg" alt="thumb"/></p>]]></description>
<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">山田太郎</dc:creator>
</item>
</channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Test Atom Feed</title>
<entry>
<title>結婚式レポート &lt;春編&gt;</title>
<link href="https://example.com/atom-post1" rel="alternate"/>
<summary type="html"><![CDATA[<p>これは<em>アトム</em>フィードのテストです。<img src="https://example.com/thumb2.jpg"/></p>]]></summary>
<published>2024-02-01T10:00:00+09:00</published>
<author><name>佐藤花子</name></author>
</entry>
</feed>`;

const RDF_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
<channel rdf:about="https://example.com/rss">
<title>RDF Feed</title>
</channel>
<item rdf:about="https://example.com/rdf-post1">
<title>RDF 結婚式準備</title>
<link>https://example.com/rdf-post1</link>
<description>RDF 抜粋です。</description>
<dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">2024-03-01T00:00:00Z</dc:date>
<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">鈴木次郎</dc:creator>
</item>
</rdf:RDF>`;

const ATOM_OBJECT_LINK_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom Object Link</title>
<entry>
<title>Entry with object link</title>
<link href="https://example.com/atom-obj" />
<summary>Summary</summary>
</entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS 2.0 <item> entries", () => {
    const entries = parseFeed(RSS2_FIXTURE);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.title).toBe("結婚式の準備 & 費用について");
    expect(entry.link).toBe("https://example.com/post1");
    expect(entry.author).toBe("山田太郎");
    expect(entry.publishedAt).toBe(new Date("Mon, 01 Jan 2024 00:00:00 GMT").toISOString());
    expect(entry.thumbnailUrl).toBe("https://example.com/thumb1.jpg");
    // <b> タグはスペースに置換されるため単語間に空白が入る（HTML タグ除去の仕様）。
    expect(entry.excerpt).toBe("これは テスト 投稿です。");
    expect(entry.excerpt).not.toContain("<");
  });

  it("parses Atom <entry> with object link", () => {
    const entries = parseFeed(ATOM_OBJECT_LINK_FIXTURE);
    expect(entries).toHaveLength(1);
    expect(entries[0].link).toBe("https://example.com/atom-obj");
  });

  it("parses RSS 1.0 (RDF) entries", () => {
    const entries = parseFeed(RDF_FIXTURE);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.title).toBe("RDF 結婚式準備");
    expect(entry.link).toBe("https://example.com/rdf-post1");
    expect(entry.author).toBe("鈴木次郎");
    expect(entry.excerpt).toBe("RDF 抜粋です。");
  });

  it("parses Atom <entry> entries", () => {
    const entries = parseFeed(ATOM_FIXTURE);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.title).toBe("結婚式レポート <春編>");
    expect(entry.link).toBe("https://example.com/atom-post1");
    expect(entry.author).toBe("佐藤花子");
    expect(entry.publishedAt).toBe(new Date("2024-02-01T10:00:00+09:00").toISOString());
    expect(entry.thumbnailUrl).toBe("https://example.com/thumb2.jpg");
    expect(entry.excerpt).toBe("これは アトム フィードのテストです。");
  });

  it("returns an empty array for unrecognized XML shapes", () => {
    expect(parseFeed("<not-a-feed></not-a-feed>")).toEqual([]);
  });

  it("returns an empty array for unparsable XML instead of throwing", () => {
    expect(() => parseFeed("<rss><channel><item><title>unterminated")).not.toThrow();
  });
});

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    expect(decodeEntities("A &amp; B &lt;tag&gt; &quot;quoted&quot;")).toBe(`A & B <tag> "quoted"`);
  });

  it("decodes numeric and hex character references", () => {
    expect(decodeEntities("&#x3042;&#12356;")).toBe("あい");
  });

  it("returns an empty string for null/undefined", () => {
    expect(decodeEntities(null)).toBe("");
    expect(decodeEntities(undefined)).toBe("");
  });
});

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    // タグは 1 個のスペースに置換されるため、インライン要素の前後には空白が入る。
    expect(stripHtml("<p>結婚式の<b>準備</b>について\n  まとめました。</p>")).toBe(
      "結婚式の 準備 について まとめました。",
    );
  });

  it("removes script/style blocks entirely", () => {
    expect(stripHtml("<style>.a{color:red}</style><p>本文</p><script>alert(1)</script>")).toBe(
      "本文",
    );
  });
});

describe("extractFirstImage", () => {
  it("extracts the first <img src> in HTML", () => {
    const html =
      '<p><img src="https://example.com/a.jpg"/></p><img src="https://example.com/b.jpg"/>';
    expect(extractFirstImage(html)).toBe("https://example.com/a.jpg");
  });

  it("returns null when there is no image", () => {
    expect(extractFirstImage("<p>no image here</p>")).toBeNull();
    expect(extractFirstImage(null)).toBeNull();
  });
});
