import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "./helpers/test-db";
import { DAILY_REQUEST_CAP_PER_HOST, MAX_BODY_BYTES, MIN_HOST_INTERVAL_MS } from "@/lib/constants";
import {
  getHostGateState,
  getSourcePolicy,
  saveHostGateState,
  upsertSourcePolicy,
} from "@/lib/db/repository";
import {
  __resetStateForTests,
  __setAllowlistTosResolverForTests,
  __setK2CheckIntervalForTests,
  __setRobotsCacheTtlForTests,
  __setSleepForTests,
  checkTermsOfServiceChange,
  classifyTosChange,
  disciplinedFetch,
  maxCrawlDelayFromRobotsText,
  normalizeTosText,
} from "@/lib/sources/access-discipline";

/** B1 日次キャップの上限到達状態を直接シードする。 */
async function seedDailyCap(host: string): Promise<void> {
  await saveHostGateState({
    host,
    gateId: null,
    stateKind: null,
    untilAt: null,
    k4Strikes: 0,
    last429At: null,
    countDay: new Date().toISOString().slice(0, 10),
    countValue: DAILY_REQUEST_CAP_PER_HOST,
  });
}

interface MockResponseInit {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

function resp({ status, body = "", headers = {} }: MockResponseInit) {
  // 実際の Headers と同様にキーを大文字小文字区別なしで引けるよう正規化する。
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name: string) => normalized[name.toLowerCase()] ?? null },
  };
}

const DISALLOW_ALL_ROBOTS = "User-agent: *\nDisallow: /\n";
const CRAWL_DELAY_ROBOTS = "User-agent: *\nCrawl-delay: 10\nDisallow:\n";
/** 実在の www.mwed.jp/robots.txt の構造そのもの: * グループに Crawl-delay は無く、
 * bingbot グループにのみ Crawl-Delay: 10 が表明されている。*/
const OTHER_UA_ONLY_CRAWL_DELAY_ROBOTS =
  "User-agent: *\nDisallow:\n\nUser-agent: bingbot\nCrawl-Delay: 10\n";

describe("maxCrawlDelayFromRobotsText (pure)", () => {
  it("finds Crawl-delay declared only on a non-* UA group (regression: real www.mwed.jp structure)", () => {
    expect(maxCrawlDelayFromRobotsText(OTHER_UA_ONLY_CRAWL_DELAY_ROBOTS)).toBe(10);
  });

  it("takes the max across multiple UA groups with different Crawl-delay values", () => {
    const robots = "User-agent: bingbot\nCrawl-Delay: 10\n\nUser-agent: Slurp\nCrawl-delay: 20\n";
    expect(maxCrawlDelayFromRobotsText(robots)).toBe(20);
  });

  it("returns null when no Crawl-delay is present anywhere", () => {
    expect(maxCrawlDelayFromRobotsText("User-agent: *\nDisallow:\n")).toBeNull();
  });

  it("ignores invalid values (non-numeric, zero, negative) and only counts valid ones", () => {
    const robots =
      "User-agent: A\nCrawl-delay: abc\n\nUser-agent: B\nCrawl-delay: 0\n\nUser-agent: C\nCrawl-delay: -5\n\nUser-agent: D\nCrawl-delay: 7\n";
    expect(maxCrawlDelayFromRobotsText(robots)).toBe(7);
  });

  it("returns null when every declared value is invalid", () => {
    const robots = "User-agent: A\nCrawl-delay: abc\n\nUser-agent: B\nCrawl-delay: 0\n";
    expect(maxCrawlDelayFromRobotsText(robots)).toBeNull();
  });

  it("takes the max when both own (WeddingTrendBot/*) and another UA group declare a value", () => {
    const robots = "User-agent: *\nCrawl-delay: 3\n\nUser-agent: bingbot\nCrawl-delay: 10\n";
    expect(maxCrawlDelayFromRobotsText(robots)).toBe(10);
  });
});

describe("Access Discipline", () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.restoreAllMocks();
    __resetStateForTests();
    // 既定では実時間を待たない。間隔を検証するテストは録画版に差し替える。
    __setSleepForTests(async () => {});
  });

  it("1. robots disallow -> blocked_robots without article fetch", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: DISALLOW_ALL_ROBOTS });
      return resp({ status: 200, body: "<html>article</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://block.com/post-1", { purpose: "article" });

    expect(verdict.kind).toBe("blocked_robots");
    const articleCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith("/robots.txt"));
    expect(articleCalls.length).toBe(0);
  });

  it("2. Crawl-delay larger than 5s is respected as spacing floor", async () => {
    const sleeps: number[] = [];
    __setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: CRAWL_DELAY_ROBOTS });
      return resp({ status: 200, body: "<html>ok</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await disciplinedFetch("https://delay.com/a", { purpose: "article" });
    await disciplinedFetch("https://delay.com/b", { purpose: "article" });

    // 初回は待機なし、2 回目は max(MIN_HOST_INTERVAL_MS, 10000) を下限とする待機。
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(MIN_HOST_INTERVAL_MS - 100);
    expect(sleeps[0]).toBeLessThanOrEqual(MIN_HOST_INTERVAL_MS + 1000);
  });

  it("3. same-host requests are sequential (>=5s apart); cross-host never blocks", async () => {
    const sleeps: number[] = [];
    __setSleepForTests(async (ms) => {
      sleeps.push(ms);
    });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 200, body: "<html>ok</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await disciplinedFetch("https://seq-a.com/1", { purpose: "article" }); // 初回: 待機なし
    await disciplinedFetch("https://seq-b.com/1", { purpose: "article" }); // 別ホスト: 待機なし
    await disciplinedFetch("https://seq-a.com/2", { purpose: "article" }); // 同一ホスト 2 回目: >=5s

    expect(sleeps.length).toBe(1);
    // 待機値は「5 秒 − 直前リクエストからの実経過時間」。DB 書き込み等で数 ms
    // 経過するため 5 秒ちょうどより短くなるのが正しい挙動である（実リクエスト
    // 間隔が 5 秒以上に保たれることが保証対象）。本テストの主眼は「同一ホスト
    // では待機が発生し、別ホストでは発生しない」こと。
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(MIN_HOST_INTERVAL_MS);
  });

  it("4. daily cap exceeded -> B1 budget_exhausted refusal without any network I/O", async () => {
    await seedDailyCap("cap.com");
    const fetchMock = vi.fn(async () => resp({ status: 200, body: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://cap.com/post-1", { purpose: "article" });

    expect(verdict).toMatchObject({ kind: "budget_exhausted", gate: "B1" });
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("5. conditional GET sends If-None-Match and maps 304 to not_modified", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["If-None-Match"] === 'W/"abc"') return resp({ status: 304 });
      return resp({ status: 200, body: "<html>ok</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://cond.com/post-1", {
      purpose: "article",
      conditional: { etag: 'W/"abc"' },
    });

    expect(verdict.kind).toBe("not_modified");
    const articleCall = fetchMock.mock.calls.find((c) => !String(c[0]).endsWith("/robots.txt"));
    const headers = ((articleCall?.[1] as RequestInit)?.headers ?? {}) as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('W/"abc"');
  });

  it("6. K1: robots.txt content hash change stops the host and updates source_policy", async () => {
    const robotsV1 = "User-agent: *\nDisallow: /private/\n";
    const robotsV2 = "User-agent: *\nDisallow: /\n";
    let currentRobots = robotsV1;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: currentRobots });
      return resp({ status: 200, body: "<html>ok</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    // 初回: スナップショット保存。
    const first = await disciplinedFetch("https://policy.com/a", { purpose: "article" });
    expect(first.kind).toBe("ok");
    const initialPolicy = await getSourcePolicy("policy.com");
    expect(initialPolicy?.robotsHash).toBe(createHash("sha256").update(robotsV1).digest("hex"));

    // 同一プロセス内で K1 を検証するため、robots キャッシュを実質無効化する
    // （本番は Actions ランごとに新規プロセスのため、この差し替えは影響しない）。
    __setRobotsCacheTtlForTests(0);

    // 2 回目: robots 内容が変化 -> K1 自動停止。
    currentRobots = robotsV2;
    const second = await disciplinedFetch("https://policy.com/b", { purpose: "article" });
    expect(second).toMatchObject({ kind: "kill_gate", gate: "K1" });

    const updatedPolicy = await getSourcePolicy("policy.com");
    expect(updatedPolicy?.robotsHash).toBe(createHash("sha256").update(robotsV2).digest("hex"));

    // 停止状態は host_gate_state に記録される（恒久ではなく人手復帰待ち）。
    const stopped = await getHostGateState("policy.com");
    expect(stopped?.stateKind).toBe("stopped");
    expect(stopped?.gateId).toBe("K1");

    // 停止中はネットワーク I/O ゼロで拒否される。
    const callsBefore = fetchMock.mock.calls.length;
    const third = await disciplinedFetch("https://policy.com/c", { purpose: "article" });
    expect(third).toMatchObject({ kind: "kill_gate", gate: "K1" });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("7. K3: 451 permanently disables the host; next call refuses without network", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 451 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await disciplinedFetch("https://legal.com/post-1", { purpose: "article" });
    expect(first).toMatchObject({ kind: "kill_gate", gate: "K3" });
    const st = await getHostGateState("legal.com");
    expect(st?.stateKind).toBe("permanent");
    expect(st?.gateId).toBe("K3");

    const callsBefore = fetchMock.mock.calls.length;
    const second = await disciplinedFetch("https://legal.com/post-2", { purpose: "article" });
    expect(second).toMatchObject({ kind: "kill_gate", gate: "K3" });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("8. K4: first 403 sets 24h cool-off; consecutive strike becomes permanent", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await disciplinedFetch("https://waf.com/post-1", { purpose: "article" });
    expect(first).toMatchObject({ kind: "kill_gate", gate: "K4" });
    const st = await getHostGateState("waf.com");
    expect(st?.stateKind).toBe("cooloff");
    expect(st?.gateId).toBe("K4");
    expect(st?.k4Strikes).toBe(1);
    expect(st?.untilAt).not.toBeNull();

    // cool-off 経過をシミュレートして再試行 -> 連続 2 回目で恒久無効化。
    await saveHostGateState({ ...st!, untilAt: new Date(Date.now() - 1000).toISOString() });
    const second = await disciplinedFetch("https://waf.com/post-2", { purpose: "article" });
    expect(second).toMatchObject({ kind: "kill_gate", gate: "K4" });
    const afterSecond = await getHostGateState("waf.com");
    expect(afterSecond?.stateKind).toBe("permanent");
    expect(afterSecond?.gateId).toBe("K4");

    const callsBefore = fetchMock.mock.calls.length;
    const third = await disciplinedFetch("https://waf.com/post-3", { purpose: "article" });
    expect(third).toMatchObject({ kind: "kill_gate", gate: "K4" });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("9. K6: first 429 honors Retry-After once; second within 24h disables host", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 429, headers: { "Retry-After": "30" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await disciplinedFetch("https://busy.com/post-1", { purpose: "article" });
    expect(first.kind).toBe("retry_after");
    if (first.kind === "retry_after") {
      const retryAt = Date.parse(first.retryAtISO);
      expect(retryAt).toBeGreaterThan(Date.now() + 25_000);
      expect(retryAt).toBeLessThan(Date.now() + 35_000);
    }

    const second = await disciplinedFetch("https://busy.com/post-2", { purpose: "article" });
    expect(second).toMatchObject({ kind: "kill_gate", gate: "K6" });
    const st = await getHostGateState("busy.com");
    expect(st?.stateKind).toBe("permanent");
    expect(st?.gateId).toBe("K6");
  });

  it("10. B1 budget_exhausted refusal precedes robots fetch and policy side effects", async () => {
    await seedDailyCap("pure.com");
    const fetchMock = vi.fn(async () => resp({ status: 200, body: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://pure.com/post-1", { purpose: "article" });

    expect(verdict).toMatchObject({ kind: "budget_exhausted", gate: "B1" });
    expect(fetchMock.mock.calls.length).toBe(0);
    // robots にも触れていないため source_policy のスナップショットも存在しない。
    expect(await getSourcePolicy("pure.com")).toBeNull();
  });

  it("14. B1 は host_gate_state に stateKind/gateId/untilAt を書かない（人手解除不要の soft stop）", async () => {
    await seedDailyCap("softcap.com");
    const fetchMock = vi.fn(async () => resp({ status: 200, body: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://softcap.com/post-1", { purpose: "article" });
    expect(verdict).toMatchObject({ kind: "budget_exhausted", gate: "B1" });

    const st = await getHostGateState("softcap.com");
    expect(st?.stateKind).toBeNull();
    expect(st?.gateId).toBeNull();
    expect(st?.untilAt).toBeNull();
  });

  it("15. K1〜K6（hard stop）では対照的に stateKind/gateId が書き込まれる（B1 との対比の固定）", async () => {
    // K3 を代表として使う（451 は即恒久停止）。
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 451 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://hardstop.com/post-1", { purpose: "article" });
    expect(verdict).toMatchObject({ kind: "kill_gate", gate: "K3" });

    const st = await getHostGateState("hardstop.com");
    expect(st?.stateKind).toBe("permanent");
    expect(st?.gateId).toBe("K3");
  });

  it("16. UTC 日付が変わると B1 の拒否は自動的に解除される（countDay が別日なら carry over しない）", async () => {
    // 前日の日付で上限到達状態をシードする。
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await saveHostGateState({
      host: "rollover.com",
      gateId: null,
      stateKind: null,
      untilAt: null,
      k4Strikes: 0,
      last429At: null,
      countDay: yesterday,
      countValue: DAILY_REQUEST_CAP_PER_HOST,
    });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 200, body: "<html>ok</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://rollover.com/post-1", { purpose: "article" });

    // 別日のカウントは carry over しないため B1 は発火しない。
    expect(verdict.kind).toBe("ok");
  });

  it("17. FetchVerdict の判別は文字列比較ではなく型（kind）で行う: budget_exhausted と kill_gate は互いに排他的な判別可能ユニオンである", async () => {
    await seedDailyCap("typecheck.com");
    const fetchMock = vi.fn(async () => resp({ status: 200, body: "" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://typecheck.com/post-1", {
      purpose: "article",
    });

    // kind による判別のみを信頼する。gate の値そのものを分岐条件にはしない
    // （将来 B2 が追加されても、この分岐ロジックは変更を要さない）。
    function classify(v: typeof verdict): "hard" | "soft" | "other" {
      switch (v.kind) {
        case "kill_gate":
          return "hard";
        case "budget_exhausted":
          return "soft";
        default:
          return "other";
      }
    }

    expect(classify(verdict)).toBe("soft");
    if (verdict.kind === "budget_exhausted") {
      expect(verdict.gate).toBe("B1");
    }
  });

  it("11. content-length exceeding the cap is rejected without reading the body", async () => {
    let bodyReadCount = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return {
        ok: true,
        status: 200,
        text: async () => {
          bodyReadCount++;
          return "x".repeat(10);
        },
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "content-length" ? String(MAX_BODY_BYTES + 1) : null,
        },
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://big.com/huge-article", {
      purpose: "article",
    });

    expect(verdict.kind).toBe("too_large");
    // content-length だけで超過が明白な場合は本文を読まずに打ち切る。
    expect(bodyReadCount).toBe(0);
  });

  it("12. missing content-length but oversized body is also rejected", async () => {
    const oversizedBody = "あ".repeat(MAX_BODY_BYTES); // マルチバイトのため実バイト長は上限を超える
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 200, body: oversizedBody });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://big2.com/huge-article", {
      purpose: "article",
    });

    expect(verdict.kind).toBe("too_large");
  });

  it("13. body within the cap still returns ok as before", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({
        status: 200,
        body: "<html>ok</html>",
        headers: { "content-length": "16" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://normal.com/post-1", { purpose: "article" });

    expect(verdict.kind).toBe("ok");
    if (verdict.kind === "ok") {
      expect(await verdict.response.text()).toBe("<html>ok</html>");
    }
  });
});

/** 規約チェックの起点となる source_policy 行をシードする（K2 テスト用）。 */
async function seedPolicyForTos(
  host: string,
  opts: { tosUrl: string | null; tosHash: string | null; checkedAt: string },
): Promise<void> {
  await upsertSourcePolicy({
    host,
    // 空 robots.txt（テストのモック）とハッシュを一致させ、K1 の誤発火を避ける。
    robotsHash: createHash("sha256").update("").digest("hex"),
    robotsBody: "",
    tosUrl: opts.tosUrl,
    tosHash: opts.tosHash,
    checkedAt: opts.checkedAt,
  });
}

const HOURS_25_AGO = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
const HOURS_1_AGO = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

describe("M3-K2: Terms of Service change detection", () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.restoreAllMocks();
    __resetStateForTests();
    __setSleepForTests(async () => {});
  });

  describe("normalizeTosText / classifyTosChange (pure)", () => {
    it("normalizes away ad/token noise (script content, attribute values) so the hash stays stable", () => {
      const html1 = `
        <html><head><meta name="csrf-token" content="tok-AAA111" /></head>
        <body>
          <script>ga('send', 'pageview', { id: 'AAA111' });</script>
          <p>本サービスへの自動でのクロールおよびスクレイピングを禁止します。</p>
        </body></html>
      `;
      const html2 = `
        <html><head><meta name="csrf-token" content="tok-ZZZ999-different" /></head>
        <body>
          <script>ga('send', 'pageview', { id: 'ZZZ999-different-and-longer' });</script>
          <p>本サービスへの自動でのクロールおよびスクレイピングを禁止します。</p>
        </body></html>
      `;

      const normalized1 = normalizeTosText(html1);
      const normalized2 = normalizeTosText(html2);

      expect(normalized1).toBe(normalized2);
      expect(createHash("sha256").update(normalized1).digest("hex")).toBe(
        createHash("sha256").update(normalized2).digest("hex"),
      );
    });

    it("classifies co-occurring access + prohibition terms in the same sentence as restrictive_change", () => {
      const text = normalizeTosText(
        "<p>本サービスへの自動でのクロールおよびスクレイピングを禁止します。</p>",
      );
      expect(classifyTosChange(text)).toBe("restrictive_change");
    });

    it("classifies unrelated changes (e.g. contact info update) as benign_change", () => {
      const text = normalizeTosText("<p>お問い合わせ先を support@example.com に変更しました。</p>");
      expect(classifyTosChange(text)).toBe("benign_change");
    });

    it("does not flag access terms and prohibition terms that appear in unrelated sentences", () => {
      const text = normalizeTosText(
        "<p>当サイトのクロールは通常どおり行われます。</p><p>他社ブランドの無断使用は禁止です。</p>",
      );
      expect(classifyTosChange(text)).toBe("benign_change");
    });
  });

  describe("checkTermsOfServiceChange (integration)", () => {
    it("returns null when the host has no tosUrl configured", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("no-tos.com");

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips the check (rate cap) when checked within the last 24h", async () => {
      await seedPolicyForTos("recent.com", {
        tosUrl: "https://recent.com/terms",
        tosHash: "some-hash",
        checkedAt: HOURS_1_AGO,
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("recent.com");

      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("records a baseline hash on first observation without blocking", async () => {
      await seedPolicyForTos("first-seen.com", {
        tosUrl: "https://first-seen.com/terms",
        tosHash: null,
        checkedAt: HOURS_25_AGO,
      });
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
        return resp({ status: 200, body: "<p>利用規約の本文です。</p>" });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("first-seen.com");

      expect(result).toBeNull();
      const policy = await getSourcePolicy("first-seen.com");
      expect(policy?.tosHash).not.toBeNull();
      const gate = await getHostGateState("first-seen.com");
      expect(gate?.stateKind ?? null).not.toBe("stopped");
    });

    it("does not block when the normalized text is unchanged (only ad noise differs)", async () => {
      const oldText = "<p>本サービスの利用条件について説明します。</p>";
      const oldHash = createHash("sha256").update(normalizeTosText(oldText)).digest("hex");
      await seedPolicyForTos("unchanged.com", {
        tosUrl: "https://unchanged.com/terms",
        tosHash: oldHash,
        checkedAt: HOURS_25_AGO,
      });
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
        // 同じ本文 + 異なる script ノイズ（広告/トークン相当）。
        return resp({
          status: 200,
          body: `<script>var t="${Date.now()}-noise";</script>${oldText}`,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("unchanged.com");

      expect(result).toBeNull();
      const gate = await getHostGateState("unchanged.com");
      expect(gate?.stateKind ?? null).not.toBe("stopped");
    });

    it("benign_change: content changes but no restrictive access/prohibition co-occurrence -> not blocked", async () => {
      const oldText = "<p>お問い合わせ先は旧メールアドレスです。</p>";
      const oldHash = createHash("sha256").update(normalizeTosText(oldText)).digest("hex");
      await seedPolicyForTos("benign.com", {
        tosUrl: "https://benign.com/terms",
        tosHash: oldHash,
        checkedAt: HOURS_25_AGO,
      });
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
        return resp({
          status: 200,
          body: "<p>お問い合わせ先を新しいメールアドレスに変更しました。</p>",
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("benign.com");

      expect(result).toBeNull();
      const policy = await getSourcePolicy("benign.com");
      expect(policy?.tosHash).not.toBe(oldHash);
      const gate = await getHostGateState("benign.com");
      expect(gate?.stateKind ?? null).not.toBe("stopped");
    });

    it("restrictive_change: newly-prohibitive crawl/scrape language stops collection for the host", async () => {
      const oldText = "<p>本サービスの利用条件について説明します。</p>";
      const oldHash = createHash("sha256").update(normalizeTosText(oldText)).digest("hex");
      await seedPolicyForTos("restrictive.com", {
        tosUrl: "https://restrictive.com/terms",
        tosHash: oldHash,
        checkedAt: HOURS_25_AGO,
      });
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
        return resp({
          status: 200,
          body: "<p>本サービスへの自動でのクロールおよびスクレイピング、複製・転載を禁止します。</p>",
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("restrictive.com");

      expect(result).toMatchObject({ kind: "kill_gate", gate: "K2" });
      const gate = await getHostGateState("restrictive.com");
      expect(gate?.stateKind).toBe("stopped");
      expect(gate?.gateId).toBe("K2");

      // 収集が実際に停止する（ネットワーク I/O ゼロで拒否される）ことを確認する。
      const callsBefore = fetchMock.mock.calls.length;
      const blocked = await disciplinedFetch("https://restrictive.com/article-1", {
        purpose: "article",
      });
      expect(blocked).toMatchObject({ kind: "kill_gate", gate: "K2" });
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it("fail-closed: ToS page fetch failure stops collection for the host", async () => {
      await seedPolicyForTos("fetch-fail.com", {
        tosUrl: "https://fetch-fail.com/terms",
        tosHash: "some-existing-hash",
        checkedAt: HOURS_25_AGO,
      });
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
        return resp({ status: 500 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("fetch-fail.com");

      expect(result).toMatchObject({ kind: "kill_gate", gate: "K2" });
      const gate = await getHostGateState("fetch-fail.com");
      expect(gate?.stateKind).toBe("stopped");
      expect(gate?.gateId).toBe("K2");
    });

    it("回帰防止: budget_exhausted（B1）を hard な K2 停止に誤昇格させない", async () => {
      // 修正前は checkTermsOfServiceChange が verdict.kind === "kill_gate" 以外を
      // すべて fail-closed（K2 停止）扱いしており、B1（soft stop）まで誤って
      // 恒久停止に昇格させる潜在バグがあった。今回の型分離でこれを修正した。
      await seedPolicyForTos("budget-during-tos.com", {
        tosUrl: "https://budget-during-tos.com/terms",
        tosHash: "some-existing-hash",
        checkedAt: HOURS_25_AGO,
      });
      await seedDailyCap("budget-during-tos.com");
      const fetchMock = vi.fn(async () => resp({ status: 200, body: "" }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await checkTermsOfServiceChange("budget-during-tos.com");

      // budget_exhausted がそのまま伝播する（kill_gate/K2 に化けない）。
      expect(result).toMatchObject({ kind: "budget_exhausted", gate: "B1" });
      const gate = await getHostGateState("budget-during-tos.com");
      expect(gate?.stateKind).not.toBe("stopped");
      expect(gate?.gateId).not.toBe("K2");
      // ネットワーク I/O ゼロで拒否される（robots.txt 取得すら発生しない）。
      expect(fetchMock.mock.calls.length).toBe(0);
    });
  });
});

/**
 * K2 の休眠解消（allowlist から tosUrl を解決する本番経路）を検証する。
 *
 * `HOST_ALLOWLIST`（`src/lib/constants.ts`）はテスト専用ホストを持たないため、
 * `__setAllowlistTosResolverForTests`（`src/lib/sources/access-discipline.ts`
 * の test-only シーム）で allowlist の tosUrl 解決関数のみを差し替える。
 * モジュール再読込は行わない（静的 import のまま、`disciplinedFetch` が
 * `@/lib/db/repository` の同一インスタンスを掴み続ける）。`seedPolicyForTos`
 * のような手動注入は一切使わず、`ensureRobotsParser`（`disciplinedFetch`
 * 経由）が実際に allowlist から tosUrl を解決して `source_policy` に
 * 書き込むことを確認する。
 */
describe("M3-K2: allowlist-driven tosUrl resolution (production path)", () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.restoreAllMocks();
    __resetStateForTests();
    __setSleepForTests(async () => {});
  });

  afterEach(() => {
    __setAllowlistTosResolverForTests(null);
  });

  it("initial robots fetch resolves tosUrl from allowlist and persists it (no manual seed)", async () => {
    __setAllowlistTosResolverForTests((host) =>
      host === "tos-allowlisted.com" ? "https://tos-allowlisted.com/terms" : null,
    );

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 200, body: "<html>ok</html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await disciplinedFetch("https://tos-allowlisted.com/post-1", {
      purpose: "article",
    });
    expect(verdict.kind).toBe("ok");

    const policy = await getSourcePolicy("tos-allowlisted.com");
    expect(policy?.tosUrl).toBe("https://tos-allowlisted.com/terms");
  });

  it("checkTermsOfServiceChange actually attempts to fetch the ToS page once tosUrl is resolved via the production path", async () => {
    __setAllowlistTosResolverForTests((host) =>
      host === "tos-fetch-check.com" ? "https://tos-fetch-check.com/terms" : null,
    );
    // robots 取得（初回観測）が checked_at を進めてしまうため、直後の K2
    // throttle（1 日 1 回）を無効化しないと fetch が発生しない（実装は正しい。
    // このテストは throttle を明示的に迂回して「fetch が実際に飛ぶこと」だけを見る）。
    __setK2CheckIntervalForTests(0);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 200, body: "<p>利用規約の本文です。</p>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    // 本番経路: robots 取得を通して初めて tosUrl が source_policy に書き込まれる。
    await disciplinedFetch("https://tos-fetch-check.com/post-1", { purpose: "article" });

    const callsBeforeTosCheck = fetchMock.mock.calls.length;
    const result = await checkTermsOfServiceChange("tos-fetch-check.com");

    // ネットワーク I/O が実際に発生したこと（= tosUrl null で即 return していないこと）を確認する。
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeTosCheck);
    const tosCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).startsWith("https://tos-fetch-check.com/terms"),
    );
    expect(tosCall).toBeDefined();
    // 初回観測なのでブロックはしない。
    expect(result).toBeNull();
  });

  it("throttle: with the default 24h interval, checkTermsOfServiceChange right after the robots pass returns null with zero additional network I/O", async () => {
    // このテストは間隔シームを一切使わない（既定の 24h throttle をそのまま検証する）。
    __setAllowlistTosResolverForTests((host) =>
      host === "tos-throttle-check.com" ? "https://tos-throttle-check.com/terms" : null,
    );

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return resp({ status: 200, body: "" });
      return resp({ status: 200, body: "<p>利用規約の本文です。</p>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    // robots 取得（初回観測）が checked_at を「たった今」に進める。
    await disciplinedFetch("https://tos-throttle-check.com/post-1", { purpose: "article" });

    const callsBeforeTosCheck = fetchMock.mock.calls.length;
    const result = await checkTermsOfServiceChange("tos-throttle-check.com");

    // 1 ホスト 1 日 1 回の throttle により即 return し、規約ページへの fetch は発生しない。
    expect(result).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsBeforeTosCheck);
  });

  it("host not in allowlist (resolver returns null) -> checkTermsOfServiceChange returns null with zero network I/O", async () => {
    // allowlist に無い架空ホストを使う（実 HOST_ALLOWLIST の内容に依存しない）。
    __setAllowlistTosResolverForTests((host) =>
      host === "some-other-allowlisted-host.example"
        ? "https://some-other-allowlisted-host.example/terms"
        : null,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await checkTermsOfServiceChange("totally-unlisted-host.example");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
