"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type FeedLoadMoreButtonProps = {
  /** 遷移先（`?count=` 付きの相対パス）。 */
  href: string;
};

/**
 * `useLinkStatus` は Link の子孫コンポーネントでしか呼べない（node_modules/next/
 * dist/docs/01-app/03-api-reference/04-functions/use-link-status.md 「Good to
 * know」節）ため、Link 直下にこの内部コンポーネントを置き、pending を
 * `onPendingChange` 経由で親（実際に <Link> を描画している側）へ伝える。
 * 戻り値は null 専用で見た目を持たない。
 */
function PendingReporter({ onPendingChange }: { onPendingChange: (pending: boolean) => void }) {
  const { pending } = useLinkStatus();
  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);
  return null;
}

/**
 * 「もっと見る」の実体（クライアント境界はこのファイルのみ）。
 *
 * - `prefetch={false}`: docs の useLinkStatus 節に「prefetch 済みなら pending は
 *   スキップされる」「`prefetch={false}` のときに最も有用」とある。このボタンは
 *   `force-dynamic` なトップページへの遷移で、押すたびに実際の待機が発生しうる
 *   導線なので、pending が確実に観測できるようここで明示する。
 * - pending は Link の子孫（PendingReporter）でしか取得できないため、
 *   `useState` で1段だけ引き上げて Link 自体の `aria-disabled` / `aria-busy` /
 *   `onClick` に反映する。
 * - アイコン枠は常に同じ寸法で描画し、スピナーの有無を opacity で切り替える
 *   （docs 「Inline indicators can easily introduce layout shifts」節の推奨どおり、
 *   display の出し分けではなく固定サイズ+opacity にしてレイアウトシフトを防ぐ）。
 * - 連打対策: pending 中は `pointer-events-none` でクリックを吸収しつつ、
 *   `aria-disabled` はキーボードフォーカスを奪わない（`disabled` 属性は使わない）。
 *   念のため `onClick` でも pending 時は `preventDefault` し、キーボード操作
 *   （Enter/Space）経由の連続遷移も止める。
 * - スクリーンリーダー向けに `role="status"` の視覚的に隠れた領域で
 *   「読み込んでいます」を伝える。pending の間だけテキストを持たせ、完了後は
 *   空にすることで読み上げの繰り返しを避ける。
 */
export function FeedLoadMoreButton({ href }: FeedLoadMoreButtonProps) {
  const [pending, setPending] = useState(false);

  return (
    <Button asChild variant="accent" className="h-12 px-8 text-base">
      <Link
        href={href}
        scroll={false}
        prefetch={false}
        aria-disabled={pending || undefined}
        aria-busy={pending}
        className={cn(pending && "pointer-events-none")}
        onClick={(event) => {
          if (pending) {
            event.preventDefault();
          }
        }}
      >
        <PendingReporter onPendingChange={setPending} />
        <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center">
          <Loader2
            className={cn(
              "size-4 motion-safe:animate-spin transition-opacity duration-150",
              pending ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        もっと見る
        <span role="status" aria-live="polite" className="sr-only">
          {pending ? "読み込んでいます" : ""}
        </span>
      </Link>
    </Button>
  );
}
