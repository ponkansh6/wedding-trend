import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
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
