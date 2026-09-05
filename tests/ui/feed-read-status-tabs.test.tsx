import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedReadStatusTabs } from "@/components/feed/feed-read-status-tabs";
import { READ_STATUS_STORAGE_KEY } from "@/components/feed/read-status-storage";
import type { FeedCard } from "@/lib/types";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  cleanup();
});

function card(id: number): FeedCard {
  return {
    id,
    sourceType: "blog",
    sourceId: "source",
    sourceName: "出典",
    url: `https://example.com/${id}`,
    originalTitle: `記事 ${id}`,
    author: null,
    publishedAt: null,
    thumbnailUrl: null,
    aiSummary: null,
    category: "その他",
    tag: "classic",
    embedProvider: "none",
    embedHtml: null,
    topicAnchor: null,
    rationaleText: null,
    usefulness: null,
    topics: [],
  };
}

function panelFor(tab: HTMLElement): HTMLElement {
  const panelId = tab.getAttribute("aria-controls");
  if (!panelId) throw new Error("tab must control a panel");
  const panel = document.getElementById(panelId);
  if (!panel) throw new Error("controlled panel must exist");
  return panel;
}

describe("FeedReadStatusTabs", () => {
  it("hydration 前は非操作の2区画 Skeleton と単一記事一覧を併存する", () => {
    const markup = renderToStaticMarkup(
      <FeedReadStatusTabs cards={[card(1), card(2)]} nextCount={4} />,
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const skeleton = document.querySelector(
      '[data-testid="pre-hydration-read-status-tabs-skeleton"]',
    );

    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(
      skeleton?.querySelectorAll('[data-testid="pre-hydration-read-status-tab-skeleton"]'),
    ).toHaveLength(2);
    expect(document.body).toHaveTextContent("記事 1");
    expect(document.body).toHaveTextContent("記事 2");
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('[role="tab"]')).toBeNull();
    expect(document.querySelector("button")).toBeNull();
  });

  it("初期化後は Skeleton を実タブへ置換し、保存済み ID で分類する", () => {
    localStorage.setItem(READ_STATUS_STORAGE_KEY, '{"version":1,"readCardIds":["2"]}');
    render(<FeedReadStatusTabs cards={[card(1), card(2)]} />);

    expect(screen.queryByTestId("pre-hydration-read-status-tabs-skeleton")).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "記事の既読状態" })).toBeInTheDocument();
    const unreadPanel = panelFor(screen.getByRole("tab", { name: "未読 1件" }));
    const readPanel = panelFor(screen.getByRole("tab", { name: "既読 1件" }));
    expect(within(unreadPanel).getByText("記事 1")).toBeInTheDocument();
    expect(within(readPanel).getByText("記事 2")).toBeInTheDocument();
  });

  it("未読タブだけに未読件数ベースのもっと見る導線を表示する", () => {
    localStorage.setItem(READ_STATUS_STORAGE_KEY, '{"version":1,"readCardIds":["2"]}');
    render(<FeedReadStatusTabs cards={[card(1), card(2), card(3)]} nextCount={6} />);

    const unreadTab = screen.getByRole("tab", { name: "未読 2件" });
    const readTab = screen.getByRole("tab", { name: "既読 1件" });
    const unreadPanel = panelFor(unreadTab);
    const readPanel = panelFor(readTab);
    expect(within(unreadPanel).getByText("記事 1")).toBeInTheDocument();
    expect(within(unreadPanel).getByText("記事 3")).toBeInTheDocument();
    expect(screen.getByText("未読 2件を表示中")).toBeInTheDocument();
    expect(screen.getByText("追加した記事は未読に表示されます。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "もっと見る" })).toHaveAttribute("href", "/?count=6");

    fireEvent.click(readTab);
    expect(readPanel).not.toHaveAttribute("hidden");
    expect(within(readPanel).getByText("記事 2")).toBeInTheDocument();
    expect(screen.queryByText("未読 2件を表示中")).not.toBeInTheDocument();
    expect(screen.queryByText("追加した記事は未読に表示されます。")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "もっと見る" })).not.toBeInTheDocument();

    fireEvent.click(unreadTab);
    expect(screen.getByText("未読 2件を表示中")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "もっと見る" })).toHaveAttribute("href", "/?count=6");
  });

  it("既読化直後と追加ロード相当の新規 ID を未読件数に反映する", () => {
    localStorage.setItem(READ_STATUS_STORAGE_KEY, '{"version":1,"readCardIds":["2"]}');
    const { rerender } = render(<FeedReadStatusTabs cards={[card(1), card(2)]} nextCount={4} />);
    const unreadTab = screen.getByRole("tab", { name: "未読 1件" });
    const unreadPanel = panelFor(unreadTab);

    fireEvent.click(within(unreadPanel).getByRole("link", { name: "記事 1" }));
    expect(screen.getByRole("tab", { name: "未読 0件" })).toBeInTheDocument();
    expect(screen.getByText("未読 0件を表示中")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "もっと見る" })).toBeInTheDocument();

    // `?count=` の追加ロード後に届く ID は保存済み既読 ID に含まれないため未読になる。
    rerender(<FeedReadStatusTabs cards={[card(1), card(2), card(3)]} nextCount={6} />);
    expect(screen.getByRole("tab", { name: "未読 1件" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "既読 2件" })).toBeInTheDocument();
    expect(screen.getByText("未読 1件を表示中")).toBeInTheDocument();
    expect(screen.getByText("記事 3")).toBeInTheDocument();
  });

  it("追加先がない場合は未読タブでももっと見る導線を出さない", () => {
    render(<FeedReadStatusTabs cards={[card(1)]} nextCount={null} />);

    expect(screen.queryByText(/件を表示中/)).not.toBeInTheDocument();
    expect(screen.queryByText("追加した記事は未読に表示されます。")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "もっと見る" })).not.toBeInTheDocument();
  });

  it("保存済み ID でロード済みカードだけを分類し、クリック時に直ちに保存する", () => {
    localStorage.setItem(READ_STATUS_STORAGE_KEY, '{"version":1,"readCardIds":["2","999"]}');
    const { unmount } = render(<FeedReadStatusTabs cards={[card(1), card(2)]} />);

    const unreadTab = screen.getByRole("tab", { name: "未読 1件" });
    const readTab = screen.getByRole("tab", { name: "既読 1件" });
    const unreadPanel = panelFor(unreadTab);
    const readPanel = panelFor(readTab);
    expect(unreadTab).toHaveAttribute("aria-selected", "true");
    expect(unreadPanel).not.toHaveAttribute("hidden");
    expect(readPanel).toHaveAttribute("hidden");
    expect(within(unreadPanel).getByText("記事 1")).toBeInTheDocument();
    expect(within(readPanel).getByText("記事 2")).toBeInTheDocument();

    expect(fireEvent.click(within(unreadPanel).getByRole("link", { name: "記事 1" }))).toBe(true);
    expect(JSON.parse(localStorage.getItem(READ_STATUS_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      readCardIds: ["2", "999", "1"],
    });
    expect(within(unreadPanel).getByText("すべて確認済みです")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "既読 2件" }));
    expect(within(readPanel).getByText("記事 1")).toBeInTheDocument();
    expect(within(readPanel).getByText("記事 2")).toBeInTheDocument();

    unmount();
    render(<FeedReadStatusTabs cards={[card(1), card(2), card(3)]} />);
    // `?count=` 遷移後の新しいロード済み範囲を模した再マウントでも、保存済み ID
    // だけで再分類し、範囲外 ID（999）からカードを復元しない。
    expect(screen.getByRole("tab", { name: "未読 1件" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "既読 2件" })).toBeInTheDocument();
  });

  it("既読タブでだけ未読に戻すボタンと左スワイプを提供し、ID のみを保存する", () => {
    localStorage.setItem(READ_STATUS_STORAGE_KEY, '{"version":1,"readCardIds":["1","2"]}');
    render(<FeedReadStatusTabs cards={[card(1), card(2)]} />);

    expect(screen.queryByRole("button", { name: "未読に戻す" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "既読 2件" }));
    const readPanel = panelFor(screen.getByRole("tab", { name: "既読 2件" }));
    const firstCard = within(readPanel).getByText("記事 1").closest("article");
    if (!firstCard) throw new Error("card must be rendered as an article");

    fireEvent.pointerDown(firstCard, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 160,
      clientY: 20,
    });
    fireEvent.pointerUp(firstCard, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 1,
      clientX: 100,
      clientY: 20,
    });
    expect(JSON.parse(localStorage.getItem(READ_STATUS_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      readCardIds: ["2"],
    });
    expect(screen.getByRole("tab", { name: "未読 1件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未読に戻す" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "未読に戻す" }));
    expect(JSON.parse(localStorage.getItem(READ_STATUS_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      readCardIds: [],
    });
    expect(within(readPanel).getByText("既読の記事はまだありません")).toBeInTheDocument();
  });

  it("manual activation のキー操作と ARIA 対応を提供する", () => {
    render(<FeedReadStatusTabs cards={[]} />);
    const unread = screen.getByRole("tab", { name: "未読 0件" });
    const read = screen.getByRole("tab", { name: "既読 0件" });
    const unreadPanel = panelFor(unread);
    const readPanel = panelFor(read);

    expect(unread).toHaveAttribute("aria-controls", unreadPanel.id);
    expect(read).toHaveAttribute("aria-controls", readPanel.id);
    expect(unreadPanel).toHaveAttribute("role", "tabpanel");
    expect(unreadPanel).toHaveAttribute("aria-labelledby", unread.id);
    expect(readPanel).toHaveAttribute("role", "tabpanel");
    expect(readPanel).toHaveAttribute("aria-labelledby", read.id);
    expect(unread).toHaveAttribute("tabindex", "0");
    expect(read).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(unread, { key: "ArrowRight" });
    expect(read).toHaveFocus();
    expect(unread).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(read, { key: " " });
    expect(read).toHaveAttribute("aria-selected", "true");
    expect(read).toHaveAttribute("tabindex", "0");
    expect(unread).toHaveAttribute("tabindex", "-1");
    expect(unreadPanel).toHaveAttribute("hidden");
    expect(readPanel).not.toHaveAttribute("hidden");
    expect(within(readPanel).getByText("既読の記事はまだありません")).toBeInTheDocument();
    fireEvent.keyDown(read, { key: "Home" });
    expect(unread).toHaveFocus();
    fireEvent.keyDown(unread, { key: "End" });
    expect(read).toHaveFocus();
    fireEvent.keyDown(read, { key: "ArrowRight" });
    expect(unread).toHaveFocus();
    fireEvent.keyDown(unread, { key: "ArrowLeft" });
    expect(read).toHaveFocus();
  });

  it("保存失敗時も当該マウントのメモリ状態で既読へ移し、再マウントでは保存済み状態を復元する", () => {
    const setItem = vi.fn(() => {
      throw new Error("quota");
    });
    const unavailableStorage: Storage = {
      length: 0,
      clear: vi.fn(),
      getItem: () => null,
      key: () => null,
      removeItem: vi.fn(),
      setItem,
    };
    vi.spyOn(window, "localStorage", "get").mockReturnValue(unavailableStorage);
    render(<FeedReadStatusTabs cards={[card(1)]} />);
    const unreadTab = screen.getByRole("tab", { name: "未読 1件" });
    const unreadPanel = panelFor(unreadTab);
    fireEvent.click(within(unreadPanel).getByRole("link", { name: "記事 1" }));
    expect(within(unreadPanel).getByText("すべて確認済みです")).toBeInTheDocument();
    expect(setItem).toHaveBeenCalled();
  });

  it("未知バージョンと localStorage getter 失敗を壊さず、タブを利用可能にする", () => {
    localStorage.setItem(READ_STATUS_STORAGE_KEY, '{"version":2,"readCardIds":["1"]}');
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { unmount } = render(<FeedReadStatusTabs cards={[card(1)]} />);
    expect(screen.getByRole("tab", { name: "未読 1件" })).toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
    unmount();
  });

  it("localStorage getter 自体が失敗しても初期化を完了し、外部リンクを維持する", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("restricted");
    });
    render(<FeedReadStatusTabs cards={[card(1)]} />);
    const link = screen.getByRole("link", { name: "記事 1" });
    expect(link).toHaveAttribute("href", "https://example.com/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(fireEvent.click(link)).toBe(true);
    const unreadPanel = panelFor(screen.getByRole("tab", { name: "未読 0件" }));
    expect(within(unreadPanel).getByText("すべて確認済みです")).toBeInTheDocument();
  });
});
