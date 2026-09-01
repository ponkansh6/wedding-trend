import Link from "next/link";
import { Button } from "@/components/ui/button";

type FeedLoadMoreProps = {
  /** 現在表示しているカード数（控えめな目安表示に使う）。 */
  visibleCount: number;
  /** 「もっと見る」を押した先で表示する件数（`?count=` に渡す値）。 */
  nextCount: number;
};

/**
 * フィード末尾の「もっと見る」導線。
 *
 * Server Component のまま状態を持たせるため、クライアント状態ではなく
 * 次の表示件数を指す通常のリンク（`?count=${nextCount}`）として実装する。
 * JS 無効でも機能し、`FeedLaneClassic` の props 契約（`tests/ui/feed-lane.test.tsx`）
 * には触れないよう、フィードの外側（`page.tsx`）に独立したセクションとして置く。
 *
 * カード群と区別できるよう上に罫線を挟み、押せることが一目でわかるよう
 * `Button` の `accent`（朱色の輪郭線→塗り）を採用。タップ領域を広げるため
 * `size="lg"` 相当の縦横パディングを追加で持たせている。
 */
export function FeedLoadMore({ visibleCount, nextCount }: FeedLoadMoreProps) {
  return (
    <div className="flex flex-col items-center gap-3 border-t border-[var(--color-border)] pt-8">
      <p className="text-meta text-[var(--color-muted-foreground)]">{visibleCount}件を表示中</p>
      <Button asChild variant="accent" className="h-12 px-8 text-base">
        <Link href={`/?count=${nextCount}`}>もっと見る</Link>
      </Button>
    </div>
  );
}
