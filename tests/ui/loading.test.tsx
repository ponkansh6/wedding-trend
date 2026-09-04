import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import Loading from "@/app/loading";

afterEach(cleanup);

/** Semantic contract for the route-level loading fallback. */
export function getLoadingContractIssues(root: ParentNode): string[] {
  const issues: string[] = [];
  const status = root.querySelector('[role="status"]');
  if (status?.textContent?.trim() !== "記事を読み込んでいます") {
    issues.push("loading status announcement or content-free text contract is broken");
  }

  if (root.querySelector('[role="tablist"], [role="tab"]')) {
    issues.push("completed-state tabs must not render while loading");
  }

  const lane = root.querySelector('section[aria-hidden="true"]');
  if (!lane) {
    issues.push("visual article skeleton lane must be aria-hidden");
  } else if (lane.querySelectorAll("article").length !== 4) {
    issues.push("four-card article list skeleton is missing");
  }

  if (/\d+件|もっと見る/.test(root.textContent ?? "")) {
    issues.push("speculative count or load-more information must not render while loading");
  }
  if (root.querySelector("a")) issues.push("article links must not render while loading");
  if (root.querySelector("img")) issues.push("external images must not render while loading");
  return issues;
}

describe("route-level loading UI", () => {
  it("matches FeedReadStatusTabs' pre-hydration single-lane skeleton", () => {
    const { container } = render(<Loading />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/^記事を読み込んでいます$/);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    const lane = container.querySelector('section[aria-hidden="true"]');
    expect(lane).toBeInTheDocument();
    expect(lane?.querySelectorAll("article")).toHaveLength(4);

    expect(container).not.toHaveTextContent(/\d+件|もっと見る/);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(getLoadingContractIssues(container)).toEqual([]);
  });

  it("detects a completed-state tab mixed into a loading fixture", () => {
    const { container } = render(
      <div role="status">
        記事を読み込んでいます
        <div role="tablist">
          <button role="tab">未読</button>
        </div>
        <section aria-hidden="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <article key={index} />
          ))}
        </section>
      </div>,
    );

    expect(getLoadingContractIssues(container)).toContain(
      "completed-state tabs must not render while loading",
    );
  });
});
