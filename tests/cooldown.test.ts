import { sql } from "drizzle-orm";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { getLastIngestAt } from "@/lib/db/repository";
import { setupTestDb } from "./helpers/test-db";
import {
  INGEST_COOLDOWN_MS,
  INGEST_LEASE_TTL_MS,
  acquireIngestLease,
  claimIngestSlot,
  getCooldownUntil,
  markIngestStart,
  releaseIngestLease,
} from "@/lib/pipeline/cooldown";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: any) => fn,
  revalidateTag: vi.fn(),
}));

describe("cooldown (src/lib/pipeline/cooldown.ts)", () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  describe("claimIngestSlot (cooldown / rate-limit)", () => {
    it("claims the slot on the very first call (no row exists yet) and returns its own cooldownUntil", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const result = await claimIngestSlot(now);
      expect(result).toEqual({
        claimed: true,
        cooldownUntil: new Date(now.getTime() + INGEST_COOLDOWN_MS).toISOString(),
      });
    });

    it("refuses an immediately-following call and returns the correct cooldownUntil", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const first = await claimIngestSlot(now);
      expect(first.claimed).toBe(true);

      const secondNow = new Date(now.getTime() + 1000); // 1秒後
      const second = await claimIngestSlot(secondNow);
      expect(second.claimed).toBe(false);
      expect(second.cooldownUntil).toBe(new Date(now.getTime() + INGEST_COOLDOWN_MS).toISOString());
    });

    it("claims again once INGEST_COOLDOWN_MS has fully elapsed", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const first = await claimIngestSlot(now);
      expect(first.claimed).toBe(true);

      const stillCoolingDown = new Date(now.getTime() + INGEST_COOLDOWN_MS - 1);
      const tooEarly = await claimIngestSlot(stillCoolingDown);
      expect(tooEarly.claimed).toBe(false);

      const afterCooldown = new Date(now.getTime() + INGEST_COOLDOWN_MS);
      const third = await claimIngestSlot(afterCooldown);
      expect(third.claimed).toBe(true);
    });

    it("allows only exactly one claim among many concurrent calls", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const results = await Promise.all(Array.from({ length: 10 }, () => claimIngestSlot(now)));

      const claimedCount = results.filter((r) => r.claimed).length;
      expect(claimedCount).toBe(1);

      // 奪取に失敗した残り 9 件はいずれも同じ cooldownUntil を返す。
      const failed = results.filter((r) => !r.claimed);
      expect(failed).toHaveLength(9);
      for (const f of failed) {
        expect(f.cooldownUntil).toBe(new Date(now.getTime() + INGEST_COOLDOWN_MS).toISOString());
      }
    });

    it("execution start time is the origin: claiming at t0 sets the deadline to t0 + INGEST_COOLDOWN_MS regardless of when it is read", async () => {
      const start = new Date("2026-08-22T00:00:00.000Z");
      await claimIngestSlot(start);

      const readLater = new Date(start.getTime() + 30 * 60 * 1000); // 30分後に読む
      expect(await getCooldownUntil(readLater)).toBe(
        new Date(start.getTime() + INGEST_COOLDOWN_MS).toISOString(),
      );
    });
  });

  describe("getCooldownUntil", () => {
    it("returns null when nothing has ever run", async () => {
      expect(await getCooldownUntil()).toBeNull();
    });

    it("returns null once the cooldown window has passed", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      await claimIngestSlot(now);

      const after = new Date(now.getTime() + INGEST_COOLDOWN_MS + 1);
      expect(await getCooldownUntil(after)).toBeNull();
    });

    it("returns the cooldown deadline while still within the window", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      await claimIngestSlot(now);

      const soon = new Date(now.getTime() + 1000);
      expect(await getCooldownUntil(soon)).toBe(
        new Date(now.getTime() + INGEST_COOLDOWN_MS).toISOString(),
      );
    });
  });

  describe("markIngestStart (cron path: writes the execution *start* time unconditionally)", () => {
    it("unconditionally overwrites last_ingest_at, bypassing the cooldown check", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      await claimIngestSlot(now); // クールダウン開始

      const soon = new Date(now.getTime() + 1000);
      // claimIngestSlot ならクールダウン中で失敗するはずの時刻でも、
      // markIngestStart は無条件に上書きする（Cron 経路の想定動作）。
      await markIngestStart(soon);

      expect(await getCooldownUntil(soon)).toBe(
        new Date(soon.getTime() + INGEST_COOLDOWN_MS).toISOString(),
      );
    });

    it("uses the timestamp it is called with as the cooldown origin (start time, not completion time)", async () => {
      // Cron 経路は runIngest() を呼ぶ「前」にこれを呼ぶ契約。実行に時間が
      // かかっても、クールダウンの起点は実行開始時刻のまま変わらないことを
      // 確認する（以前は完了時刻を起点にしており、公開ボタン経路と食い違っていた）。
      const executionStart = new Date("2026-08-22T00:00:00.000Z");
      await markIngestStart(executionStart);

      const rightAfterCompletion = new Date(executionStart.getTime() + 45 * 1000); // 45秒後に完了したと仮定
      expect(await getCooldownUntil(rightAfterCompletion)).toBe(
        new Date(executionStart.getTime() + INGEST_COOLDOWN_MS).toISOString(),
      );
    });
  });

  describe("acquireIngestLease / releaseIngestLease (exclusive execution lock, all paths)", () => {
    it("allows only exactly one acquisition among many concurrent calls", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const results = await Promise.all(Array.from({ length: 10 }, () => acquireIngestLease(now)));

      const acquiredCount = results.filter(Boolean).length;
      expect(acquiredCount).toBe(1);
    });

    it("refuses a second acquisition while the lease is still held", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      expect(await acquireIngestLease(now)).toBe(true);

      const soon = new Date(now.getTime() + 1000);
      expect(await acquireIngestLease(soon)).toBe(false);
    });

    it("allows re-acquisition once INGEST_LEASE_TTL_MS has fully elapsed (auto-recovery from a crash)", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      expect(await acquireIngestLease(now)).toBe(true);

      const stillLeased = new Date(now.getTime() + INGEST_LEASE_TTL_MS - 1);
      expect(await acquireIngestLease(stillLeased)).toBe(false);

      const afterTtl = new Date(now.getTime() + INGEST_LEASE_TTL_MS);
      expect(await acquireIngestLease(afterTtl)).toBe(true);
    });

    it("allows immediate re-acquisition right after releaseIngestLease", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      expect(await acquireIngestLease(now)).toBe(true);

      await releaseIngestLease(now);

      const rightAfterRelease = new Date(now.getTime() + 1); // TTL には遠く及ばない直後
      expect(await acquireIngestLease(rightAfterRelease)).toBe(true);
    });

    it("is independent from the cooldown mechanism: acquiring/releasing the lease does not touch last_ingest_at", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      expect(await getCooldownUntil(now)).toBeNull();

      expect(await acquireIngestLease(now)).toBe(true);
      expect(await getCooldownUntil(now)).toBeNull();

      await releaseIngestLease(now);
      expect(await getCooldownUntil(now)).toBeNull();
    });
  });

  describe("config テーブル未作成時の挙動（読み取り=フェイルソフト／書き込み=fail-closed）", () => {
    // smoke test（DB にテーブルが無い初回起動）やマイグレーション未適用の本番を
    // 再現する: setupTestDb() で全テーブルを作った直後に config だけを落とす。
    beforeEach(async () => {
      await db.run(sql.raw("DROP TABLE IF EXISTS config;"));
    });

    it("getLastIngestAt() は throw せず null を返す（getFeedCards と同じフェイルソフトのパターン）", async () => {
      await expect(getLastIngestAt()).resolves.toBeNull();
    });

    it("getCooldownUntil() は throw せず null を返す（トップページ初期描画のクラッシュ回帰防止の本体）", async () => {
      await expect(getCooldownUntil()).resolves.toBeNull();
    });

    /**
     * 書き込み経路が「テーブルが無いことを理由に」失敗したことを検証する。
     *
     * drizzle は元の `SQLITE_ERROR: no such table` を `cause` にラップし、
     * トップレベルの message は `Failed query: insert into ...` になる。
     * そのため message だけを見る `rejects.toThrow(/no such table/i)` では
     * 検出できない。cause チェーンを辿って原因まで確認する。
     */
    async function expectRejectsWithMissingTable(run: () => Promise<unknown>): Promise<void> {
      const err = await run().then(
        () => {
          throw new Error("throw されるべきところで解決してしまった（fail-closed が壊れている）");
        },
        (e: unknown) => e,
      );
      const chain: string[] = [];
      for (let cur: unknown = err; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
        chain.push(cur.message);
      }
      expect(chain.join(" | ")).toMatch(/no such table/i);
    }

    it("claimIngestSlot() は throw する（fail-closed の回帰防止: 握りつぶして『クールダウンなし』と誤認させない）", async () => {
      await expectRejectsWithMissingTable(() => claimIngestSlot());
    });

    it("acquireIngestLease() は throw する（fail-closed の回帰防止: 握りつぶして『lease 取得成功』と誤認させない）", async () => {
      await expectRejectsWithMissingTable(() => acquireIngestLease());
    });

    it("markIngestStart() / releaseIngestLease() も書き込み経路として throw する", async () => {
      await expectRejectsWithMissingTable(() => markIngestStart());
      await expectRejectsWithMissingTable(() => releaseIngestLease());
    });
  });
});
