export interface OgpMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  author: string | null;
  datePublished: string | null;
}

/** HTML エンティティのデコード（簡易版） */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

/** JSON-LD 内から author や datePublished を再帰的に探索する */
function extractFromJsonLd(obj: unknown): { author: string | null; datePublished: string | null } {
  let author: string | null = null;
  let datePublished: string | null = null;

  if (!obj || typeof obj !== "object") {
    return { author, datePublished };
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const res = extractFromJsonLd(item);
      if (!author && res.author) author = res.author;
      if (!datePublished && res.datePublished) datePublished = res.datePublished;
    }
    return { author, datePublished };
  }

  const record = obj as Record<string, unknown>;

  // datePublished / dateCreated / dateModified
  if (typeof record.datePublished === "string") {
    datePublished = record.datePublished;
  } else if (typeof record.dateCreated === "string" && !datePublished) {
    datePublished = record.dateCreated;
  }

  // author
  if (record.author) {
    if (typeof record.author === "string") {
      author = record.author;
    } else if (Array.isArray(record.author)) {
      for (const a of record.author) {
        const res = extractFromJsonLd(a);
        if (res.author) {
          author = res.author;
          break;
        }
      }
    } else if (typeof record.author === "object") {
      const authorObj = record.author as Record<string, unknown>;
      if (typeof authorObj.name === "string") {
        author = authorObj.name;
      }
    }
  }

  // 再帰的に子プロパティを走査
  for (const [key, value] of Object.entries(record)) {
    if (key === "author" || key === "datePublished") continue;
    const res = extractFromJsonLd(value);
    if (!author && res.author) author = res.author;
    if (!datePublished && res.datePublished) datePublished = res.datePublished;
  }

  return { author, datePublished };
}

/** Pure parser — extracts OGP meta tags + JSON-LD author/datePublished from HTML. Exported for unit testing. */
export function parseOgpMetadata(html: string): OgpMetadata {
  let ogTitle: string | null = null;
  let ogDesc: string | null = null;
  let ogImage: string | null = null;
  let ogSiteName: string | null = null;
  let articlePublishedTime: string | null = null;
  let htmlTitle: string | null = null;
  let metaDesc: string | null = null;

  // <title> タグの抽出
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    htmlTitle = decodeHtmlEntities(titleMatch[1].trim());
  }

  // <meta> タグの走査
  const metaRegex = /<meta\s+([^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(html)) !== null) {
    const attrsStr = match[1];

    // property or name の抽出
    const propMatch = attrsStr.match(/(?:property|name)\s*=\s*(["'])([^"']+)\1/i);
    const contentMatch = attrsStr.match(/content\s*=\s*(["'])([\s\S]*?)\1/i);

    if (propMatch && contentMatch) {
      const prop = propMatch[2].toLowerCase();
      const content = decodeHtmlEntities(contentMatch[2].trim());

      if (prop === "og:title") ogTitle = content;
      else if (prop === "og:description") ogDesc = content;
      else if (prop === "og:image") ogImage = content;
      else if (prop === "og:site_name") ogSiteName = content;
      else if (prop === "article:published_time") articlePublishedTime = content;
      else if (prop === "description") metaDesc = content;
    }
  }

  // JSON-LD の抽出
  let jsonLdAuthor: string | null = null;
  let jsonLdDate: string | null = null;
  const jsonLdRegex =
    /<script\s+type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = jsonLdRegex.exec(html)) !== null) {
    const jsonContent = ldMatch[2];
    try {
      const parsed = JSON.parse(jsonContent);
      const res = extractFromJsonLd(parsed);
      if (!jsonLdAuthor && res.author) jsonLdAuthor = res.author;
      if (!jsonLdDate && res.datePublished) jsonLdDate = res.datePublished;
    } catch {
      // JSON パースエラーは無視
    }
  }

  return {
    title: ogTitle || htmlTitle,
    description: ogDesc || metaDesc,
    image: ogImage,
    siteName: ogSiteName,
    author: jsonLdAuthor,
    datePublished: jsonLdDate || articlePublishedTime,
  };
}

/** Fetches a URL and returns its OGP/JSON-LD metadata only (NO body scraping). Returns null on any failure. */
export async function fetchOgpMetadata(url: string): Promise<OgpMetadata | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; wedding-trend-curator/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const html = await res.text();
    return parseOgpMetadata(html);
  } catch {
    return null;
  }
}
