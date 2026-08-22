/**
 * 重複排除・DB 保存用の正規化 URL を作る。
 * - トラッキング用クエリパラメータ（utm_*, fbclid）を除去
 * - 末尾スラッシュを除去（ルートパス "/" は除く）
 * - スキームとホストのみ小文字化する
 *
 * **パスとクエリは絶対に小文字化しないこと。** RFC 3986 上ホストは大文字小文字を
 * 区別しないが、パスとクエリは区別する。実際に Instagram のショートコード
 * (`/p/CUbHfhpswxt`) や YouTube の動画 ID (`?v=dQw4w9WgXcQ`) は大文字小文字を
 * 含み、小文字化するとリンクが 404 になり oEmbed 取得も失敗する。
 * 元ソースへの導線は本プロジェクトの法務要件（spec.md §9）であり、
 * ここでリンクを壊すことは仕様違反にあたる。
 *
 * パース不能な URL は null を返す（呼び出し側はその投稿をスキップする）。
 */
export function canonicalizeUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  // http(s) 以外（javascript:, data: 等）は取り込み対象にしない。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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

  // URL のパース時点で protocol と host は既に小文字化されている。
  // href をそのまま返すことでパス・クエリの大文字小文字が保たれる。
  return parsed.href;
}
