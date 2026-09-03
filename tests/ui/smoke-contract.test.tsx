import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FeedLaneClassic } from "@/components/feed/feed-lane-classic";
import { SiteShell } from "@/components/layout/site-shell";

// Keep this independent from production exports: the contract must catch a
// production URL regression rather than sharing its mistaken value.
const EXPECTED_GITHUB_ISSUES_URL = "https://github.com/ponkansh6/wedding-trend/issues";

afterEach(cleanup);

/** Pure DOM checks used by the sandbox-safe smoke gate's rendered fixture. */
export function getSiteShellContractIssues(root: ParentNode): string[] {
  const issues: string[] = [];
  const homeLink = Array.from(root.querySelectorAll('a[href="/"]')).find((link) =>
    link.textContent?.includes("ウエディング・トレンド"),
  );
  const banner = homeLink?.closest("header");
  if (!banner) {
    issues.push("site name home link is missing from header");
  }

  const main = root.querySelector("main");
  if (!main || !main.textContent?.includes("定番の体験談はまだありません")) {
    issues.push("main content is missing");
  }

  const footer = root.querySelector("footer");
  if (!footer?.textContent?.includes("AIによる自動処理")) {
    issues.push("AI disclosure is missing from footer");
  }
  const issuesLink = footer?.querySelector(`a[href="${EXPECTED_GITHUB_ISSUES_URL}"]`);
  if (!issuesLink || issuesLink.textContent?.trim() !== "GitHub Issues") {
    issues.push("GitHub Issues contact link is missing or incorrect");
  }
  return issues;
}

describe("public site shell smoke contract", () => {
  it("renders the actual public shell and empty feed with all required public/legal landmarks", () => {
    const { container } = render(
      <SiteShell>
        <FeedLaneClassic cards={[]} />
      </SiteShell>,
    );

    const homeLink = screen.getByRole("link", { name: /ウエディング・トレンド/ });
    expect(homeLink).toHaveAttribute("href", "/");
    expect(homeLink.closest("header")).toHaveTextContent("ウエディング・トレンド");
    expect(screen.getByRole("main")).toContainElement(
      screen.getByText("定番の体験談はまだありません"),
    );
    const issuesLink = screen.getByRole("link", { name: "GitHub Issues" });
    expect(issuesLink).toHaveAttribute("href", EXPECTED_GITHUB_ISSUES_URL);
    expect(issuesLink.closest("footer")).toHaveTextContent("AIによる自動処理");
    expect(getSiteShellContractIssues(container)).toEqual([]);
  });

  it("reports failures for a broken fixture so the validator cannot silently always pass", () => {
    const { container } = render(
      <div>
        <header>別のサイト</header>
        <main />
        <footer>
          AIによる自動処理
          <a href="https://github.com/ponkansh6/wedding-trend">GitHub Issues</a>
        </footer>
      </div>,
    );

    expect(getSiteShellContractIssues(container)).toContain(
      "GitHub Issues contact link is missing or incorrect",
    );
  });
});
