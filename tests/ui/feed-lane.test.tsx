// FeedLaneClassic コンポーネントのレンダリングテスト。
// spec.md:733 の担保点2（AI 免責の恒常注記）を含め、
// 空状態・カード件数に応じた描画の不変条件を検証する。
import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";
import type { FeedCard as FeedCardData } from "@/lib/types";

afterEach(() => {
  cleanup();
});

const AI_DISCLAIMER =
  "見出しは元記事のまま。カテゴリ・トピックはAIが自動判定しており、誤りを含む場合があります。";

function makeCard(overrides: Partial<FeedCardData> = {}): FeedCardData {
  return {
    id: overrides.id ?? 1,
    sourceType: "blog",
    sourceId: "ameblo",
    sourceName: "アメーバブログ",
    url: "https://example.com/article",
    originalTitle: "記事タイトル",
    author: null,
    publishedAt: null,
    thumbnailUrl: null,
    aiSummary: null,
    category: "衣装・ドレス",
    tag: "classic",
    embedProvider: "none",
    embedHtml: null,
    topicAnchor: null,
    rationaleText: null,
    usefulness: null,
    topics: [],
    ...overrides,
  };
}

describe("FeedLaneClassic", () => {
  it("カードが 0 件のとき空状態が描画され、カードは描画されない", () => {
    const { container } = render(<FeedLaneClassic cards={[]} />);
    expect(screen.getByText("定番の体験談はまだありません")).toBeInTheDocument();
    expect(container.querySelectorAll("article").length).toBe(0);
  });

  it("カードが複数件のとき、その件数ぶん article が描画される", () => {
    const cards = [
      makeCard({ id: 1, originalTitle: "記事1" }),
      makeCard({ id: 2, originalTitle: "記事2" }),
      makeCard({ id: 3, originalTitle: "記事3" }),
    ];
    const { container } = render(<FeedLaneClassic cards={cards} />);
    expect(container.querySelectorAll("article").length).toBe(cards.length);
    expect(screen.queryByText("定番の体験談はまだありません")).not.toBeInTheDocument();
  });

  it("カードが 0 件のときも複数件のときも AI 免責の恒常注記が常に描画される（spec.md:733）", () => {
    const { rerender } = render(<FeedLaneClassic cards={[]} />);
    expect(screen.getByText(AI_DISCLAIMER)).toBeInTheDocument();

    rerender(<FeedLaneClassic cards={[makeCard({ id: 1 })]} />);
    expect(screen.getByText(AI_DISCLAIMER)).toBeInTheDocument();
  });
});
