/**
 * 重複排除・DB 保存用の正規化 URL を作る。
 * - トラッキング用クエリパラメータ（utm_*, fbclid）を除去
 * - 末尾スラッシュを除去（ルートパス "/" は除く）
 * - 全体を小文字化
 * パース不能な URL は null を返す（呼び出し側はその投稿をスキップする）。
 */
export function canonicalizeUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const toDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (/^utm_/i.test(key) || key.toLowerCase() === "fbclid") toDelete.push(key);
  }
  for (const key of toDelete) parsed.searchParams.delete(key);

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.href.toLowerCase();
}
