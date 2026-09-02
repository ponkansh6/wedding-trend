import { FeedLoadMoreButton } from "@/components/feed/feed-load-more-button";

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
 *
 * `scroll={false}`: Next.js 16.3.1 の `<Link>` はデフォルト（`scroll=true`）でも
 * 「遷移先の Page 要素がビューポート内に見えている場合はスクロール位置を維持する」
 * が、このボタンはフィード最下部にあり Page 先頭は画面外にあるため、その分岐に
 * 落ちて「最初の Page 要素の先頭へスクロール」する（node_modules/next/dist/docs/
 * 01-app/03-api-reference/02-components/link.md の `### scroll` 節を参照）。
 * `scroll={false}` を明示することでこの巻き戻りを止め、押した位置のまま
 * 下に新しいカードが continue して見える挙動にする。
 *
 * 押下から遷移完了までの待機フィードバック（スピナー・連打対策・
 * スクリーンリーダー通知）は `useLinkStatus`（Link の子孫でのみ呼べる
 * フック）を使うため、その部分だけを独立した小さなクライアント
 * コンポーネント `FeedLoadMoreButton` に切り出している。このコンポーネント
 * 自体・`FeedLaneClassic`・`page.tsx` は Server Component のまま。
 */
export function FeedLoadMore({ visibleCount, nextCount }: FeedLoadMoreProps) {
  return (
    <div className="flex flex-col items-center gap-3 border-t border-[var(--color-border)] pt-8">
      <p className="text-meta text-[var(--color-muted-foreground)]">{visibleCount}件を表示中</p>
      <FeedLoadMoreButton href={`/?count=${nextCount}`} />
    </div>
  );
}
