/**
 * Purpose: 情報源名（クレジット）解決の中立ヘルパ。もとは `evergreen.ts`
 * （旧骨格）にあったが、evergreen レーン固有ではなく `discovery-ingest.ts`
 * （S2 スコープ外の別レーン）からも import されていたため、evergreen.ts
 * 削除にあたり中立モジュールへ切り出した（Stage 6 S2 Commit 4）。
 */

import type { OgpMetadata } from "@/lib/sources/ogp";

/**
 * 情報源名（クレジット）の解決。spec.md §10-2 の「著者名・情報源名を必ず表示する」
 * 要件を満たすため、実在しない媒体名は絶対に生成しない。
 * 解決順: 手動指定 (opts.sourceName) → og:site_name → URL の登録可能ドメイン。
 * いずれも得られない場合は null を返し、呼び出し側で保存を拒否する
 * （捏造したクレジットを出すくらいなら取り込まない）。
 */
export function resolveSourceName(
  canonical: string,
  meta: OgpMetadata,
  opts?: { sourceName?: string },
): string | null {
  const explicit = opts?.sourceName?.trim();
  if (explicit) return explicit;
  const siteName = meta.siteName?.trim();
  if (siteName) return siteName;
  return registrableDomain(canonical);
}

/** URL から登録可能ドメイン（www. 等のサブドメインを除いたホスト名）を取り出す。事実であり捏造にあたらない。 */
export function registrableDomain(canonical: string): string | null {
  try {
    const hostname = new URL(canonical).hostname;
    if (!hostname) return null;
    return hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}
