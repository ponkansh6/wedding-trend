import { isDailyPublishCapReached } from "@/lib/pipeline/rate-cap";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `now` を含む JST の暦日の開始時刻（UTC ISO 文字列）。Q4 の集計基準。 */
export function jstDayStartIso(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  const jst = new Date(jstMs);
  const startOfDayJstMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return new Date(startOfDayJstMs - JST_OFFSET_MS).toISOString();
}

/** `now` を含む JST の暦日キー（YYYY-MM-DD）。Q2 テレメトリの集計単位。 */
export function jstDayKey(nowIso: string): string {
  const jstMs = Date.parse(nowIso) + JST_OFFSET_MS;
  return new Date(jstMs).toISOString().slice(0, 10);
}

/** Q4 日次公開サーキットブレーカー。 */
export async function checkDiscoveryRateCap(now: string): Promise<{ capped: boolean }> {
  // spec §11 項4: 日次公開サーキットブレーカーのみ（ホスト別シェア上限は廃止）。
  return { capped: await isDailyPublishCapReached(jstDayStartIso(now)) };
}
