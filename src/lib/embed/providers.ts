import type { EmbedProvider } from "@/lib/types";

/**
 * URL から SNS 埋め込みプロバイダを判定する。
 * どれにも一致しない場合は "none"（リンクボタン表示にフォールバック）。
 */
export function detectEmbedProvider(url: string): EmbedProvider {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "none";
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname;

  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    if (/^\/(p|reel|tv)\/[^/]+/.test(path)) return "instagram";
    return "none";
  }

  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    if (/^\/@[^/]+\/video\/\d+/.test(path)) return "tiktok";
    return "none";
  }

  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (path === "/watch" && parsed.searchParams.has("v")) return "youtube";
    if (/^\/shorts\/[^/]+/.test(path)) return "youtube";
    return "none";
  }
  if (host === "youtu.be") {
    if (/^\/[^/]+/.test(path)) return "youtube";
    return "none";
  }

  return "none";
}
