import { sql } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { setupTestDb } from "./helpers/test-db";

/**
 * `tests/actions.test.ts` は `@/lib/pipeline/cooldown` をまるごとモックしている
 * ため、lease（排他ロック）が cooldown.ts / repository.ts / 実 DB を通じて
 * 実際に同時実行を防いでいることまでは検証できない。
 *
 * このファイルは cooldown.ts と db/repository.ts を**モックせず**、実際の
 * （インメモリ）DB を使って `triggerIngest()`（公開ボタン経路）と
 * `acquireIngestLease()`（Cron 経路が保持する想定のリース）の間で本物の排他が
 * 機能することを検証する。回帰対象は「Cron 実行中に公開ボタンが押されると
 * runIngest() が二重に走る」という今回の脆弱性そのもの。
 */

const { runIngestMock, runSubmitUrlMock } = vi.hoisted(() => ({
  runIngestMock: vi.fn(),
  runSubmitUrlMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/pipeline/ingest", () => ({
  runIngest: runIngestMock,
}));

// triggerIngest 自体は呼ばないが actions.ts が静的 import しているため、
// 実モジュール（Gemini/oEmbed クライアントを持つ）が読み込まれないようにする。
vi.mock("@/lib/pipeline/submit-url", () => ({
  runSubmitUrl: runSubmitUrlMock,
}));

import { getIngestCooldown, triggerIngest } from "@/app/actions";
import { acquireIngestLease, getCooldownUntil, releaseIngestLease } from "@/lib/pipeline/cooldown";
import { getLastIngestAt } from "@/lib/db/repository";

describe("triggerIngest × real lease/cooldown (integration, in-memory DB)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestDb();
  });

  it("returns busy:true and never calls runIngest while another execution (e.g. cron) already holds the lease", async () => {
    const now = new Date("2026-08-22T09:00:00.000Z");
    // Cron 経路が実行中であることを、実際の lease 取得で再現する。
    const cronHoldsLease = await acquireIngestLease(now);
    expect(cronHoldsLease).toBe(true);

    const result = await triggerIngest();

    expect(result.busy).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.errors).toEqual([]);
    expect(runIngestMock).not.toHaveBeenCalled();

    // cron が保持したままの lease を公開ボタン経路が奪って解放してしまって
    // いないこと（busy 分岐は自分が取得していない lease に触れない）。
    const stillBlocked = await acquireIngestLease(new Date(now.getTime() + 1000));
    expect(stillBlocked).toBe(false);

    await releaseIngestLease(now);
  });

  it("succeeds once the lease is free, and the cron-held lease's release does not race with it", async () => {
    runIngestMock.mockResolvedValue({
      fetched: 2,
      inserted: 2,
      curated: 2,
      skipped: 0,
      errors: [],
    });

    const result = await triggerIngest();

    expect(result.busy).toBe(false);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(runIngestMock).toHaveBeenCalledTimes(1);

    // last_ingest_at が更新され、次の呼び出しはクールダウン中になる。
    expect(await getLastIngestAt()).not.toBeNull();
    expect(await getCooldownUntil(new Date())).not.toBeNull();
  });

  it("lets the button path proceed immediately after the cron-held lease is released", async () => {
    const now = new Date("2026-08-22T09:00:00.000Z");
    await acquireIngestLease(now);
    await releaseIngestLease(now);

    runIngestMock.mockResolvedValue({
      fetched: 1,
      inserted: 1,
      curated: 1,
      skipped: 0,
      errors: [],
    });

    const result = await triggerIngest();

    expect(result.busy).toBe(false);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(runIngestMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * smoke test（`scripts/smoke-test.sh`）が検証する「DB にテーブルが無い初回
 * 起動でもトップページが描画できるか」を直接再現する回帰テスト群。
 * `src/app/page.tsx` はビルド時に `getIngestCooldown()` を呼ぶため、
 * それが例外を投げるとページ全体が 500 になる（実際に検出されたバグ）。
 * ここでは `config` テーブルだけを落とし、cooldown.ts / repository.ts を
 * モックせず、ページの呼び出し経路（`getIngestCooldown`）と、ボタン操作の
 * 呼び出し経路（`triggerIngest`）の両方を実際の（インメモリ）DB で検証する。
 */
describe("page render / triggerIngest × missing config table (pre-migration prod, smoke test)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTestDb();
    await db.run(sql.raw("DROP TABLE IF EXISTS config;"));
  });

  it("getIngestCooldown() (called by src/app/page.tsx on render) resolves to cooldownUntil:null instead of throwing — smoke-test crash regression guard", async () => {
    await expect(getIngestCooldown()).resolves.toEqual({ cooldownUntil: null });
  });

  it("triggerIngest() resolves to a safe IngestResult (never throws) and never calls runIngest when the config table is missing", async () => {
    const result = await triggerIngest();

    expect(result.ok).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.busy).toBe(false);
    expect(result.errors).toEqual(["収集処理でエラーが発生しました。時間をおいてお試しください。"]);
    expect(result.cooldownUntil).toBeNull();
    expect(runIngestMock).not.toHaveBeenCalled();
  });
});
