// FeedCard コンポーネントのレンダリングテスト。
// spec.md §10-11 の法務不変部分（記事本文非生成・非永続化、逐語タイトル、
// アクセス規律）を DOM 出力レベルで直接検証する。
// 従来 smoke-test.sh は DB 空の状態しか curl していなかったため、
// 「カードが実際に描画された状態」を検証するテストが存在しなかった穴を埋める。
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("既読カードは主タッチの水平左スワイプだけで一度だけ未読へ戻し、capture と click 抑止を行う", () => {
    const onMarkRead = vi.fn();
    const { container } = render(<FeedCard card={makeCard()} isRead onMarkRead={onMarkRead} />);
    const article = container.querySelector("article");
    if (!article) throw new Error("card must be rendered as an article");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(article, {
      setPointerCapture,
      releasePointerCapture,
      hasPointerCapture: () => true,
    });

    fireEvent.pointerDown(article, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 7,
      clientX: 148,
      clientY: 20,
    });
    fireEvent.pointerUp(article, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 7,
      clientX: 100,
      clientY: 20,
    });
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith(1, "unread");
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);

    const link = screen.getByRole("link", { name: "元記事のタイトルそのまま" });
    expect(fireEvent.click(link)).toBe(false);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(fireEvent.click(link)).toBe(true);
    expect(onMarkRead).toHaveBeenCalledWith(1);
  });

  it("スワイプの閾値・方向・ポインタ種別とキャンセルを厳格に扱い、次の操作は継続できる", () => {
    const onMarkRead = vi.fn();
    const { container } = render(<FeedCard card={makeCard()} isRead onMarkRead={onMarkRead} />);
    const article = container.querySelector("article");
    if (!article) throw new Error("card must be rendered as an article");
    const gesture = (down: Record<string, unknown>, up: Record<string, unknown>) => {
      fireEvent.pointerDown(article, down);
      fireEvent.pointerUp(article, up);
    };
    gesture(
      { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 148, clientY: 10 },
      { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 101, clientY: 10 },
    );
    gesture(
      { pointerType: "touch", isPrimary: true, pointerId: 2, clientX: 100, clientY: 10 },
      { pointerType: "touch", isPrimary: true, pointerId: 2, clientX: 160, clientY: 10 },
    );
    gesture(
      { pointerType: "touch", isPrimary: true, pointerId: 3, clientX: 160, clientY: 10 },
      { pointerType: "touch", isPrimary: true, pointerId: 3, clientX: 100, clientY: 50 },
    );
    gesture(
      { pointerType: "mouse", isPrimary: true, pointerId: 4, clientX: 160, clientY: 10 },
      { pointerType: "mouse", isPrimary: true, pointerId: 4, clientX: 100, clientY: 10 },
    );
    gesture(
      { pointerType: "pen", isPrimary: true, pointerId: 5, clientX: 160, clientY: 10 },
      { pointerType: "pen", isPrimary: true, pointerId: 5, clientX: 100, clientY: 10 },
    );
    gesture(
      { pointerType: "touch", isPrimary: false, pointerId: 6, clientX: 160, clientY: 10 },
      { pointerType: "touch", isPrimary: false, pointerId: 6, clientX: 100, clientY: 10 },
    );
    expect(onMarkRead).not.toHaveBeenCalled();

    fireEvent.pointerDown(article, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 8,
      clientX: 160,
      clientY: 10,
    });
    fireEvent.pointerUp(article, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 9,
      clientX: 100,
      clientY: 10,
    });
    fireEvent.pointerCancel(article, { pointerId: 8 });
    fireEvent.lostPointerCapture(article, { pointerId: 8 });
    expect(onMarkRead).not.toHaveBeenCalled();

    gesture(
      { pointerType: "touch", isPrimary: true, pointerId: 10, clientX: 148, clientY: 10 },
      { pointerType: "touch", isPrimary: true, pointerId: 10, clientX: 100, clientY: 10 },
    );
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(article).toHaveStyle({ touchAction: "pan-y pinch-zoom" });
  });

  it("ボタン起点のタッチは親スワイプにせず、未読化は一度だけ行う", () => {
    const onMarkRead = vi.fn();
    render(<FeedCard card={makeCard()} isRead onMarkRead={onMarkRead} />);
    const button = screen.getByRole("button", { name: "未読に戻す" });
    fireEvent.pointerDown(button, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 3,
      clientX: 150,
      clientY: 10,
    });
    fireEvent.pointerUp(button, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 3,
      clientX: 10,
      clientY: 10,
    });
    expect(onMarkRead).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith(1, "unread");
  });
});
