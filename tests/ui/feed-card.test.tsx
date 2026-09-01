// FeedCard コンポーネントのレンダリングテスト。
// spec.md §10-11 の法務不変部分（記事本文非生成・非永続化、逐語タイトル、
// アクセス規律）を DOM 出力レベルで直接検証する。
// 従来 smoke-test.sh は DB 空の状態しか curl していなかったため、
// 「カードが実際に描画された状態」を検証するテストが存在しなかった穴を埋める。
import { describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { FeedCard } from "@/components/feed/feed-card";
import type { FeedCard as FeedCardData } from "@/lib/types";

afterEach(() => {
  cleanup();
});

const RATIONALE_MARKER = "__RATIONALE_TEXT_MARKER__この根拠文は表示されてはならない";
const SUMMARY_MARKER = "__AI_SUMMARY_MARKER__この要約は表示されてはならない";
const THUMBNAIL_URL = "https://example.com/thumb/__THUMBNAIL_MARKER__.jpg";

function makeCard(overrides: Partial<FeedCardData> = {}): FeedCardData {
  return {
    id: 1,
    sourceType: "blog",
    sourceId: "ameblo",
    sourceName: "アメーバブログ",
    url: "https://example.com/article/1",
    originalTitle: "元記事のタイトルそのまま",
    author: "花子",
    publishedAt: "2026-08-01T00:00:00.000Z",
    thumbnailUrl: THUMBNAIL_URL,
    aiSummary: SUMMARY_MARKER,
    category: "衣装・ドレス",
    tag: "classic",
    embedProvider: "none",
    embedHtml: '<blockquote data-thumb="' + THUMBNAIL_URL + '">埋め込みHTML</blockquote>',
    topicAnchor: "アンカーテキスト",
    rationaleText: RATIONALE_MARKER,
    usefulness: null,
    topics: ["ドレス", "白ドレス"],
    ...overrides,
  };
}

describe("FeedCard", () => {
  it("rationaleText を一切描画しない（spec.md:732 の法務不変条件）", () => {
    render(<FeedCard card={makeCard()} />);
    expect(screen.queryByText(RATIONALE_MARKER)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(RATIONALE_MARKER);
  });

  it("aiSummary を一切描画しない", () => {
    render(<FeedCard card={makeCard()} />);
    expect(screen.queryByText(SUMMARY_MARKER)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SUMMARY_MARKER);
  });

  it("外部画像を一切描画しない（<img> 不在、thumbnailUrl の値も DOM 内に一切出現しない。spec.md §10-11）", () => {
    const { container } = render(<FeedCard card={makeCard()} />);
    expect(container.querySelectorAll("img").length).toBe(0);
    // thumbnailUrl / embedHtml に値を渡していても、DOM 全体（属性含む）に
    // マーカー文字列が出現してはならない。
    expect(container.innerHTML).not.toContain(THUMBNAIL_URL);
  });

  it("originalTitle を逐語表示する（前後に文字が付加されない）", () => {
    const title = "元記事のタイトルそのまま";
    render(<FeedCard card={makeCard({ originalTitle: title })} />);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading).toHaveTextContent(title);
    // 完全一致（前後付加なし）であることを厳密に確認する。
    expect(heading.textContent).toBe(title);
  });

  it("元記事への導線が存在し、noopener/noreferrer/target=_blank が付与されている", () => {
    const url = "https://example.com/article/specific-1";
    render(<FeedCard card={makeCard({ url })} />);
    const links = screen.getAllByRole("link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", url);
      expect(link).toHaveAttribute("target", "_blank");
      const rel = link.getAttribute("rel") ?? "";
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
  });

  it("sourceName は常に表示され、author は非 null のときのみ表示される", () => {
    render(<FeedCard card={makeCard({ sourceName: "アメーバブログ", author: "花子" })} />);
    expect(screen.getByText(/アメーバブログ/)).toBeInTheDocument();
    expect(screen.getByText(/花子/)).toBeInTheDocument();
  });

  it("author が null のとき著者名が出ない", () => {
    render(<FeedCard card={makeCard({ author: null, sourceName: "はてなブログ" })} />);
    expect(screen.getByText(/はてなブログ/)).toBeInTheDocument();
    expect(screen.queryByText(/花子/)).not.toBeInTheDocument();
  });

  it("topicAnchor が null のときアンカー行が描画されない", () => {
    render(<FeedCard card={makeCard({ topicAnchor: null })} />);
    expect(screen.queryByText("アンカーテキスト")).not.toBeInTheDocument();
  });

  it("topicAnchor が非 null のとき描画される", () => {
    render(<FeedCard card={makeCard({ topicAnchor: "特徴的なアンカー文言" })} />);
    expect(screen.getByText("特徴的なアンカー文言")).toBeInTheDocument();
  });

  it("トピックチップが 0 個のときコンテナごと描画されない", () => {
    render(<FeedCard card={makeCard({ topics: [] })} />);
    expect(
      screen.queryByRole("list", { name: "AIが自動選定したトピック" }),
    ).not.toBeInTheDocument();
  });

  it("トピックチップが 2〜4 個のとき全て描画される", () => {
    const topics = ["ドレス", "白ドレス", "会場装花", "撮影"];
    render(<FeedCard card={makeCard({ topics })} />);
    const list = screen.getByRole("list", { name: "AIが自動選定したトピック" });
    for (const topic of topics) {
      // "#" は CSS ::before の content によるものであり DOM テキストには含まれない。
      expect(within(list).getByText(topic)).toBeInTheDocument();
    }
  });

  it("カテゴリバッジが描画される", () => {
    render(<FeedCard card={makeCard({ category: "会場・装花" })} />);
    expect(screen.getByText("会場・装花")).toBeInTheDocument();
  });
});
