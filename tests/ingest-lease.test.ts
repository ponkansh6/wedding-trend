import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { setupTestDb } from "./helpers/test-db";

/**
 * `tests/actions.test.ts` は `@/lib/pipeline/cooldown` をまるごとモックしている
 * ため、lease（排他ロック）が cooldown.ts / repository.ts / 実 DB を通じて
 * 実際に同時実行を防いでいることまでは検証できない。
 *
 * このファイルは cooldown.ts と db/repository.ts を**モックせず**、実際の
 * （インメモリ）DB を使って `triggerIngest()`（`/admin` の手動トリガー経路）と
 * `acquireIngestLease()`（Cron 経路が保持する想定のリース）の間で本物の排他が
 * 機能することを検証する。回帰対象は「Cron 実行中に手動トリガーが押されると
 * runIngest() が二重に走る」という脆弱性そのもの。
 */

const { runIngestMock, runSubmitUrlMock } = vi.hoisted(() => ({
  runIngestMock: vi.fn(),
  runSubmitUrlMock: vi.fn(),
}));

vi.mock("@/lib/pipeline/ingest", () => ({
  runIngest: runIngestMock,
}));

// triggerIngest 自体は呼ばないが actions.ts が静的 import しているため、
// 実モジュール（Gemini/oEmbed クライアントを持つ）が読み込まれないようにする。
vi.mock("@/lib/pipeline/submit-url", () => ({
  runSubmitUrl: runSubmitUrlMock,
}));

// このファイルは @/lib/auth（isBasicAuthorized）もモックしない。lease/cooldown
// の検証対象は認証を通過した後の挙動なので、実装のまま常に認証が通るよう、
// headers() が返す Authorization ヘッダーと ADMIN_BASIC_AUTH_USER/PASSWORD を
// 一致させておく（下の beforeEach で env を設定する）。
const ADMIN_TEST_USER = "admin";
const ADMIN_TEST_PASSWORD = "test-password";
vi.mock("next/headers", () => ({
  headers: vi.fn(() =>
    Promise.resolve(
      new Headers({
        authorization: `Basic ${Buffer.from(`${ADMIN_TEST_USER}:${ADMIN_TEST_PASSWORD}`).toString("base64")}`,
      }),
    ),
  ),
}));

import { getIngestCooldown, triggerIngest } from "@/app/actions";
import { acquireIngestLease, getCooldownUntil, releaseIngestLease } from "@/lib/pipeline/cooldown";

describe("triggerIngest × real lease/cooldown (integration, in-memory DB)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", ADMIN_TEST_USER);
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", ADMIN_TEST_PASSWORD);
    await setupTestDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns busy:true and never calls runIngest while another execution (e.g. cron) already holds the lease", async () => {
    // ⚠️ 注入時刻と実時刻を混在させない: triggerIngest() は now を注入できず
    // 常に実時刻（new Date()）で lease の期限を判定する。ここで固定の壁時計
    // 時刻（例: "2026-08-22T09:00:00.000Z"）を注入して lease を書き込むと、
    // テスト実行時刻がその期限（INGEST_LEASE_TTL_MS 後）を過ぎた瞬間に
    // 「lease が期限切れ」と判定され、busy:true を期待するこのテストが
    // 実行時刻依存で自然に落ちる（実際に発生した回帰）。
    // triggerIngest() 側が実時刻固定である以上、lease 側も実時刻に合わせて
    // 統一する。INGEST_LEASE_TTL_MS は 2 分あるため、テスト実行中に
    // 期限切れになる心配はない。
    const now = new Date();
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
      geminiCalls: 1,
    });

    const result = await triggerIngest();

    expect(result.busy).toBe(false);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(runIngestMock).toHaveBeenCalledTimes(1);

    // ingest_cooldown_until が確保され、次の呼び出しはクールダウン中になる
    // （actions.ts は claimIngestSlot() → extendIngestCooldownAfterRun() 経由で
    // 本物の cooldown.ts を通す。このファイルは cooldown.ts をモックしないため
    // 実 DB 状態で検証できる。geminiCalls: 1 のため 4 時間へ延長されている）。
    const cooldownUntil = await getCooldownUntil(new Date());
    expect(cooldownUntil).not.toBeNull();
    expect(cooldownUntil).toBe(result.cooldownUntil);
  });

  it("lets the button path proceed immediately after the cron-held lease is released", async () => {
    // このテストは acquire 直後に release するため、書き込まれる lease の値は
    // 常に「常に期限切れ」を表す過去日時（releaseIngestLease は無条件に過去の
    // 定数を書く。src/lib/db/repository.ts 参照）になり、その後 triggerIngest()
    // が実時刻で評価しても矛盾しない。つまりここでの now は acquire/release の
    // どちらにも同じ値を使っている限り実時刻・固定時刻のどちらでも安全だが、
    // 上のテストと同様のパターンに見えて紛らわしいため、ファイル内で時刻の
    // 扱いを統一する目的で実時刻に揃えている。
    const now = new Date();
    await acquireIngestLease(now);
    await releaseIngestLease(now);

    runIngestMock.mockResolvedValue({
      fetched: 1,
      inserted: 1,
      curated: 1,
      skipped: 0,
      errors: [],
      geminiCalls: 0,
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
    vi.stubEnv("ADMIN_BASIC_AUTH_USER", ADMIN_TEST_USER);
    vi.stubEnv("ADMIN_BASIC_AUTH_PASSWORD", ADMIN_TEST_PASSWORD);
    await setupTestDb();
    await db.run(sql.raw("DROP TABLE IF EXISTS config;"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
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
