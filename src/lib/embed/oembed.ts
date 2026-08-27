import { OEMBED_TIMEOUT_MS } from "@/lib/constants";
import { detectEmbedProvider } from "./providers";
import type { EmbedProvider } from "@/lib/types";
import { normalizeTitle } from "@/lib/sources/base/feed-parser";

export interface OEmbedResult {
  html: string | null;
  thumbnailUrl: string | null;
  authorName: string | null;
  title: string | null;
  provider: EmbedProvider;
}

/**
 * 各プロバイダのキー不要（またはキー任意）な oEmbed エンドポイント。
 * Instagram は公開投稿に対しては access_token 無しでも動作するが（2026年6月時点、
 * 1000 req/hr）、INSTAGRAM_OEMBED_TOKEN が設定されていれば将来の仕様変更に
 * 備えて付与する。
 */
function buildOEmbedUrl(provider: EmbedProvider, url: string): string | null {
  const encoded = encodeURIComponent(url);
  switch (provider) {
    case "instagram": {
      const token = process.env.INSTAGRAM_OEMBED_TOKEN;
      const base = `https://graph.facebook.com/v25.0/instagram_oembed?url=${encoded}&omitscript=true`;
      return token ? `${base}&access_token=${encodeURIComponent(token)}` : base;
    }
    case "tiktok":
      return `https://www.tiktok.com/oembed?url=${encoded}`;
    case "youtube":
      return `https://www.youtube.com/oembed?url=${encoded}&format=json`;
    default:
      return null;
  }
}

/**
 * 公式 oEmbed を取得する。失敗・タイムアウト時は null を返し、呼び出し側は
 * embedProvider を "none" にしてリンクボタン表示にフォールバックする
 * （SNS 投稿が埋め込みできなくても保存自体は継続する）。
 */
export async function fetchOEmbed(url: string): Promise<OEmbedResult | null> {
  const provider = detectEmbedProvider(url);
  if (provider === "none") return null;

  const oembedUrl = buildOEmbedUrl(provider, url);
  if (!oembedUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);
  try {
    const res = await fetch(oembedUrl, { signal: controller.signal });
    if (!res.ok) {
      console.warn(`[oembed] HTTP ${res.status} for provider=${provider} url=${url}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      html: typeof data.html === "string" ? data.html : null,
      thumbnailUrl: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
      authorName: typeof data.author_name === "string" ? data.author_name : null,
      title: typeof data.title === "string" ? normalizeTitle(data.title) : null,
      provider,
    };
  } catch (err) {
    console.warn(`[oembed] fetch error for provider=${provider} url=${url}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
