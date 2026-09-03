"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";
import { readReadStatus, writeReadStatus } from "@/components/feed/read-status-storage";
import type { FeedCard } from "@/lib/types";

type TabName = "unread" | "read";

type FeedReadStatusTabsProps = {
  cards: FeedCard[];
};

const TABS: TabName[] = ["unread", "read"];

// Accessing window.localStorage itself can throw in restricted browser modes,
// before getItem/setItem are ever called.
function getBrowserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function FeedReadStatusTabs({ cards }: FeedReadStatusTabsProps) {
  const instanceId = useId();
  const [hydrated, setHydrated] = useState(false);
  const [activeTab, setActiveTab] = useState<TabName>("unread");
  const [readCardIds, setReadCardIds] = useState<Set<string>>(() => new Set());
  const readCardIdsRef = useRef<Set<string>>(new Set());
  const tabRefs = useRef<Record<TabName, HTMLButtonElement | null>>({ unread: null, read: null });

  useEffect(() => {
    const storage = getBrowserStorage();
    const result = storage ? readReadStatus(storage) : { readCardIds: [], shouldRepair: false };
    // Preserve an event-time update if one occurs before this effect completes.
    const ids = new Set([...result.readCardIds, ...readCardIdsRef.current]);
    readCardIdsRef.current = ids;
    setReadCardIds(ids);
    if (storage && result.shouldRepair) writeReadStatus(storage, ids);
    setHydrated(true);
  }, []);

  const markRead = (cardId: FeedCard["id"]) => {
    const id = String(cardId);
    const current = readCardIdsRef.current;
    if (current.has(id)) return;
    const next = new Set(current);
    next.add(id);
    readCardIdsRef.current = next;
    // Do not await or prevent the external link's normal navigation.
    const storage = getBrowserStorage();
    if (storage) writeReadStatus(storage, next);
    setReadCardIds(next);
  };

  // Keep SSR and the first client render identical. This is also the usable
  // no-JavaScript fallback: all loaded cards remain in one ordinary list.
  if (!hydrated) {
    return <FeedLaneClassic cards={cards} onMarkRead={markRead} />;
  }

  const unreadCards = cards.filter((card) => !readCardIds.has(String(card.id)));
  const readCards = cards.filter((card) => readCardIds.has(String(card.id)));
  const ids = {
    tablist: `${instanceId}-tablist`,
    unreadTab: `${instanceId}-unread-tab`,
    readTab: `${instanceId}-read-tab`,
    unreadPanel: `${instanceId}-unread-panel`,
    readPanel: `${instanceId}-read-panel`,
    unreadHeading: `${instanceId}-unread-heading`,
    readHeading: `${instanceId}-read-heading`,
  };

  const moveFocus = (tab: TabName) => tabRefs.current[tab]?.focus();
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: TabName) => {
    const index = TABS.indexOf(tab);
    let next: TabName | null = null;
    if (event.key === "ArrowLeft") next = TABS[(index + TABS.length - 1) % TABS.length];
    if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length];
    if (event.key === "Home") next = TABS[0];
    if (event.key === "End") next = TABS[TABS.length - 1];
    if (next) {
      event.preventDefault();
      moveFocus(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveTab(tab);
    }
  };

  const tab = (name: TabName, label: string, count: number, tabId: string, panelId: string) => (
    <button
      ref={(element) => {
        tabRefs.current[name] = element;
      }}
      type="button"
      role="tab"
      id={tabId}
      aria-controls={panelId}
      aria-selected={activeTab === name}
      aria-label={`${label} ${count}件`}
      tabIndex={activeTab === name ? 0 : -1}
      onClick={() => setActiveTab(name)}
      onKeyDown={(event) => onTabKeyDown(event, name)}
      className="-mb-px rounded-sm border-b-2 border-transparent px-3 py-2 text-meta font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] aria-selected:border-[var(--color-accent)] aria-selected:text-[var(--color-accent)]"
    >
      {label} <span aria-hidden="true">({count})</span>
    </button>
  );

  return (
    <div>
      <div
        role="tablist"
        aria-label="記事の既読状態"
        id={ids.tablist}
        className="flex gap-2 border-b border-[var(--color-border)]"
      >
        {tab("unread", "未読", unreadCards.length, ids.unreadTab, ids.unreadPanel)}
        {tab("read", "既読", readCards.length, ids.readTab, ids.readPanel)}
      </div>
      <div
        role="tabpanel"
        id={ids.unreadPanel}
        aria-labelledby={ids.unreadTab}
        hidden={activeTab !== "unread"}
        className="pt-4"
      >
        <FeedLaneClassic
          cards={unreadCards}
          headingId={ids.unreadHeading}
          emptyState={{
            title: "すべて確認済みです",
            description: "読み込み済みの記事はすべて確認済みです。",
          }}
          onMarkRead={markRead}
        />
      </div>
      <div
        role="tabpanel"
        id={ids.readPanel}
        aria-labelledby={ids.readTab}
        hidden={activeTab !== "read"}
        className="pt-4"
      >
        <FeedLaneClassic
          cards={readCards}
          headingId={ids.readHeading}
          emptyState={{
            title: "既読の記事はまだありません",
            description: "元記事を開くと、ここに既読として表示されます。",
          }}
          onMarkRead={markRead}
        />
      </div>
    </div>
  );
}
