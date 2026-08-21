import { RSS_FETCH_TIMEOUT_MS, RSS_USER_AGENT } from "@/lib/constants";

export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * RSS/Atom フィードを取得する。タイムアウト・ネットワークエラー・非 2xx は
 * すべて null を返して呼び出し元に伝播させる（fail soft — 1 ソースの障害で
 * ingest 全体を落とさない）。
 */
export async function fetchRssText(
  url: string,
  sourceName: string,
  options?: FetchOptions,
): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? RSS_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": RSS_USER_AGENT,
        ...options?.headers,
      },
    });
    if (!res.ok) {
      console.warn(`[${sourceName}] HTTP ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`[${sourceName}] fetch/parse error for ${url}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
