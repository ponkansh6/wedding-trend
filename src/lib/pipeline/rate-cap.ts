import { DAILY_PUBLISH_CAP } from "@/lib/constants";
import { countPublishedSince } from "@/lib/db/repository";

/**
 * 日次公開サーキットブレーカー（spec §11 項4）。全摂取経路
 * （`ingest.ts` / `evergreen.ts` / `submit-url.ts` / `discovery-ingest.ts`）で
 * 共通に使う唯一の判定関数。
 *
 * 当日 JST の公開総数（`countPublishedSince(sinceIso)`）が `DAILY_PUBLISH_CAP`
 * に達していれば `true`。到達時、呼び出し側は公開せず `rate_capped` リトライ
 * キューへ繰り延べる（終端棄却ではない）。
 *
 * 2026-08-29 の方針転換: 単一ホストの当日公開シェア上限
 * （旧 `HOST_DAILY_SHARE_MAX`）は廃止した。この上限は供給スロットルではなく、
 * DOM 変更等で一晩に数百件を誤公開する相関カスケード事故だけを止める
 * サーキットブレーカーである。
 */
export async function isDailyPublishCapReached(sinceIso: string): Promise<boolean> {
  const total = await countPublishedSince(sinceIso);
  return total >= DAILY_PUBLISH_CAP;
}
