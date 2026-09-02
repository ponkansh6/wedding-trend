import type * as React from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { FeedCard as FeedCardData } from "@/lib/types";
import { PublishedTime } from "@/components/feed/relative-time";

type FeedCardProps = {
  card: FeedCardData;
  /** 出現アニメーションの遅延に使う表示順（任意）。 */
  index?: number;
};

export function FeedCard({ card, index = 0 }: FeedCardProps) {
  return (
    <Card
      as="article"
      className="card-enter flex h-full flex-col gap-2 p-4"
      style={{ "--enter-delay": `${Math.min(index, 8) * 70}ms` } as React.CSSProperties}
    >
      {/*
       * plan B 追試: カテゴリバッジとトピックチップを同一行に集約する。
       * 実データ検証（本番134件）ではトピックは最大3件・大半が2〜4字で、
       * 典型ケースはこの1行に収まる。カテゴリ文字数が長い少数ケース
       * （約13%）では ul ブロックごと折り返って2段になるが、
       * これは意図した挙動であり崩れではない（後述）。
       *
       * 法務開示（spec.md:745）維持のため、<ul> は独立した要素として保ち、
       * role="list" / aria-label / title を保持する。カテゴリバッジは
       * その <ul> の外側の兄弟要素として置き、「トピック」ラベルの配下に
       * 含めない。<ul> を display:contents 化して chip 単位で折り返す案は、
       * 一部の AT で aria-label ごと読み上げから消える既知の不具合があり
       * 法務開示要件に反するリスクがあるため採用しない。その代わり
       * 「ul がまるごと次行へ落ちる」という block 単位の折り返しを
       * そのまま許容する — これが実測の最悪ケース（カテゴリ1行目・
       * チップ2行目）と一致する。
       */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Badge variant="category" className="text-badge">
          {card.category}
        </Badge>

        {card.topics && card.topics.length > 0 && (
          <ul
            role="list"
            className="flex flex-wrap items-center gap-1.5"
            aria-label="AIが自動選定したトピック"
            title="AI による自動判定。誤りを含む場合があります"
          >
            {card.topics.map((topic) => (
              <li key={topic} className="cursor-default">
                <Badge
                  variant="topic"
                  className="text-badge max-w-[13rem] overflow-hidden before:mr-0.5 before:shrink-0 before:content-['#']"
                >
                  <span className="min-w-0 truncate">{topic}</span>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Title originalTitle={card.originalTitle} url={card.url} cardId={card.id} />

      {card.topicAnchor && (
        <p className="line-clamp-1 text-anchor text-pretty text-[var(--color-muted-foreground)]">
          {card.topicAnchor}
        </p>
      )}

      <Footer card={card} />
    </Card>
  );
}

/**
 * originalTitle は元記事の逐語タイトル（法務不変・plan 21 §6-3）。
 * このコンポーネントは originalTitle をそのまま表示する以外の文字列加工
 * （.replace() 等による言い換え・要約・装飾的な改変）を一切行ってはならない。
 * line-clamp による視覚上の省略は文字列そのものの改変ではないため許容する。
 */
function Title({
  originalTitle,
  url,
  cardId,
}: {
  originalTitle: FeedCardData["originalTitle"];
  url: string;
  cardId: FeedCardData["id"];
}) {
  const noteId = `${cardId}-external-note`;
  return (
    <>
      <h3 className="mt-1 text-title font-display font-semibold text-pretty text-[var(--color-foreground)]">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={noteId}
          className="line-clamp-2 text-pretty rounded-sm underline decoration-[var(--color-muted-foreground-subtle)] underline-offset-2 transition-colors duration-150 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] after:absolute after:inset-0 after:z-0 after:content-['']"
        >
          {originalTitle}
        </a>
      </h3>
      {/*
       * h3.textContent は元記事タイトルと厳密一致でなければならない
       * （spec.md §10-3・tests/ui/feed-card.test.tsx が検証する法務ゲート）ため、
       * 「外部サイトへ新しいタブで遷移する」という補足は見出し要素の外側に置き、
       * aria-describedby でリンクの説明として結び付ける。aria-hidden な要素は
       * aria-describedby の参照先として読み上げられない実装があるため、
       * aria-hidden は付けない独立した sr-only 要素にする。
       */}
      <span id={noteId} className="sr-only">
        外部サイトの元記事を新しいタブで開きます
      </span>
    </>
  );
}

/**
 * カード全面がタイトル <a> の ::after でリンク化されているため（Title 参照）、
 * ここには実インタラクティブ要素を置かない（ネストしたリンクを作らないため）。
 * 「原文を読む」の見た目だけを常時表示し、押下できることの視覚的裏付けとする。
 * アクセシブルな説明（外部サイト・新しいタブである旨）は Title 側の
 * aria-describedby が担うため、ここは aria-hidden で読み上げから隠す
 * （見た目だけのラベルとして二重announceを防ぐ）。
 */
function Footer({ card }: { card: FeedCardData }) {
  return (
    <footer className="mt-auto flex flex-row items-center justify-between gap-2.5 border-t border-[var(--color-border)] pt-3">
      <p className="min-w-0 truncate text-meta text-[var(--color-muted-foreground)]">
        {card.sourceName}
        {card.author && <> ・ {card.author}</>}
        {" ・ "}
        <PublishedTime iso={card.publishedAt} />
      </p>
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center gap-1 text-badge font-semibold text-[var(--color-accent)]"
      >
        原文を読む
        <ExternalLink className="size-3.5" />
      </span>
    </footer>
  );
}
