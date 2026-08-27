import { XMLParser } from "fast-xml-parser";
import { EXCERPT_MAX_CHARS } from "@/lib/constants";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

/** RSS 2.0 <item> / Atom <entry> を共通の中間表現に正規化した結果。 */
export interface FeedEntry {
  title: string;
  link: string;
  /** HTML タグを除去し EXCERPT_MAX_CHARS 以内に切り詰めた本文抜粋。取得できなければ null。 */
  excerpt: string | null;
  author: string | null;
  /** ISO 8601 文字列。パース不能なら null。 */
  publishedAt: string | null;
  /** 本文 HTML から抽出した最初の画像 URL。 */
  thumbnailUrl: string | null;
}

/** XML の値が {"#text": "..."} 形式・プリミティブのどちらでも文字列として取り出す。 */
export function getText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)["#text"] ?? "");
  }
  return "";
}

/** 数値文字参照・主要な名前付きエンティティをデコードする。 */
export function decodeEntities(input: unknown): string {
  const str = typeof input === "string" ? input : getText(input);
  if (!str) return "";
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** 名前付きエンティティ・数値文字参照をデコードした上で、空白（改行・タブ等、U+3000を除く）を正規化する。 */
export function normalizeTitle(input: unknown): string {
  const str = decodeEntities(input);
  if (!str) return "";
  return str.replace(/[ \t\r\n\u2028\u2029]+/g, " ").trim();
}

/** HTML タグを除去し、連続する空白を 1 個にまとめ、前後をトリムする。 */
export function stripHtml(html: string): string {
  if (!html) return "";
  const withoutTags = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

/** HTML 本文から最初の <img src="..."> を抽出する。 */
export function extractFirstImage(html: string | null | undefined): string | null {
  if (!html) return null;
  const match = /<img[^>]+src=["']([^"'>]+)["']/i.exec(html);
  return match ? decodeEntities(match[1]) : null;
}

function truncateExcerpt(text: string): string | null {
  const stripped = stripHtml(text);
  if (!stripped) return null;
  return stripped.length > EXCERPT_MAX_CHARS ? stripped.slice(0, EXCERPT_MAX_CHARS) : stripped;
}

function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** <media:thumbnail>{url}</media:thumbnail> と <media:thumbnail url="..."/> の両表記に対応。 */
function readMediaUrl(node: unknown): string | null {
  if (typeof node === "string" && node) return node;
  if (node && typeof node === "object") {
    const url = (node as Record<string, unknown>)["@_url"];
    if (typeof url === "string") return url;
  }
  return null;
}

/**
 * RSS2/RDF <item> のエンクロージャ/メディア拡張から画像 URL を探す（無ければ本文から抽出）。
 * はてなブックマークの検索 RSS には <hatena:imageurl> という独自タグで
 * OGP 画像の URL がそのまま入っている。content:encoded 内の最初の <img> は
 * favicon（お気に入りアイコン）であることが多く、これを優先すると
 * サムネイルが不適切になるため、hatena:imageurl を最優先で見る。
 */
/**
 * 著者名ノードを形式に依存せず読み取る。
 * 実フィードでは `<dc:creator xmlns:dc="...">名前</dc:creator>` のように
 * 属性付きで現れることがあり、その場合パーサはオブジェクトを返す。
 * 著作者クレジットは引用要件上必須のため、取りこぼしを許容しない。
 */
function readAuthor(...nodes: unknown[]): string | null {
  for (const node of nodes) {
    const text = decodeEntities(getText(node) || (typeof node === "string" ? node : "")).trim();
    if (text) return text;
  }
  return null;
}

/** 日付ノードを形式に依存せず読み取る。 */
function readDate(...nodes: unknown[]): string | undefined {
  for (const node of nodes) {
    const text = getText(node).trim();
    if (text) return text;
  }
  return undefined;
}

function resolveRss2Thumbnail(item: Record<string, unknown>, bodyHtml: string): string | null {
  const hatenaImage = item["hatena:imageurl"];
  if (typeof hatenaImage === "string" && hatenaImage) return decodeEntities(hatenaImage);

  const fromMediaThumbnail = readMediaUrl(item["media:thumbnail"]);
  if (fromMediaThumbnail) return fromMediaThumbnail;

  const fromMediaContent = readMediaUrl(item["media:content"]);
  if (fromMediaContent) return fromMediaContent;

  const enclosure = item.enclosure as Record<string, unknown> | undefined;
  const enclosureType = enclosure?.["@_type"];
  const enclosureUrl = enclosure?.["@_url"];
  if (
    typeof enclosureUrl === "string" &&
    (!enclosureType || /^image\//.test(String(enclosureType)))
  ) {
    return enclosureUrl;
  }

  return extractFirstImage(bodyHtml);
}

function parseRss2Item(raw: unknown): FeedEntry {
  const item = raw as Record<string, unknown>;
  const linkRaw = item.link;
  const link =
    typeof linkRaw === "string"
      ? linkRaw
      : typeof linkRaw === "object" && linkRaw !== null
        ? String((linkRaw as Record<string, unknown>)["@_href"] ?? getText(linkRaw))
        : "";

  // content:encoded（本文全体）優先、無ければ description。サムネイル抽出・要約の両方に使う。
  const bodyHtml = decodeEntities(item["content:encoded"] ?? item.description ?? "");
  const author = readAuthor(item["dc:creator"], item["note:creatorName"], item.author);

  return {
    title: normalizeTitle(item.title),
    link,
    excerpt: truncateExcerpt(bodyHtml),
    author,
    publishedAt: toIsoDate(readDate(item.pubDate, item["dc:date"])),
    thumbnailUrl: resolveRss2Thumbnail(item, bodyHtml),
  };
}

function parseAtomEntry(raw: unknown): FeedEntry {
  const entry = raw as Record<string, unknown>;
  const linkRaw = entry.link;
  let link = "";
  if (Array.isArray(linkRaw)) {
    const links = linkRaw as Record<string, unknown>[];
    const alternate = links.find((l) => !l?.["@_rel"] || l["@_rel"] === "alternate");
    link = String((alternate ?? links[0])?.["@_href"] ?? "");
  } else if (typeof linkRaw === "object" && linkRaw !== null) {
    link = String((linkRaw as Record<string, unknown>)["@_href"] ?? "");
  } else if (typeof linkRaw === "string") {
    link = linkRaw;
  }

  const bodyHtml = decodeEntities(entry.content ?? entry.summary ?? "");
  const authorNode = entry.author as Record<string, unknown> | undefined;
  const author = readAuthor(authorNode?.name, entry["dc:creator"]);
  const publishedRaw = readDate(entry.published, entry.updated);

  return {
    title: normalizeTitle(entry.title),
    link,
    excerpt: truncateExcerpt(bodyHtml),
    author,
    publishedAt: toIsoDate(publishedRaw),
    thumbnailUrl: extractFirstImage(bodyHtml),
  };
}

/**
 * RSS 2.0（<rss><channel><item>）・RSS 1.0/RDF（<rdf:RDF><item>）・
 * Atom（<feed><entry>）の 3 形式を扱う統一パーサー。
 * はてなブックマークの検索 RSS は RDF 形式で返るため、RSS2 と互換のタグ名
 * （title/link/description/dc:date/dc:creator）を共有する RDF もここで
 * RSS2 と同じ正規化関数に通す。どの形式でもない場合は空配列を返す
 * （呼び出し側はさらに fail soft に扱う）。
 */
export function parseFeed(xml: string): FeedEntry[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    console.warn("[feed-parser] XML parse error:", err);
    return [];
  }

  const root = parsed as Record<string, unknown>;
  const channel = (root.rss as Record<string, unknown> | undefined)?.channel as
    | Record<string, unknown>
    | undefined;
  const rssItems = channel?.item;
  if (rssItems) {
    const items = Array.isArray(rssItems) ? rssItems : [rssItems];
    return items.map(parseRss2Item);
  }

  const rdfRoot = root["rdf:RDF"] as Record<string, unknown> | undefined;
  const rdfItems = rdfRoot?.item;
  if (rdfItems) {
    const items = Array.isArray(rdfItems) ? rdfItems : [rdfItems];
    return items.map(parseRss2Item);
  }

  const feed = root.feed as Record<string, unknown> | undefined;
  const atomEntries = feed?.entry;
  if (atomEntries) {
    const entries = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    return entries.map(parseAtomEntry);
  }

  return [];
}
