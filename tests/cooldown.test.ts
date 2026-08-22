import { sql } from "drizzle-orm";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { extendIngestCooldown, getIngestCooldownValue } from "@/lib/db/repository";
import {
  INGEST_BASE_COOLDOWN_MS,
  INGEST_FULL_COOLDOWN_MS,
  INGEST_LEASE_TTL_MS,
} from "@/lib/constants";
import { setupTestDb } from "./helpers/test-db";
import {
  acquireIngestLease,
  claimIngestSlot,
  extendIngestCooldownAfterRun,
  getCooldownUntil,
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

  describe("claimIngestSlot (claim: establishes the INGEST_BASE_COOLDOWN_MS deadline)", () => {
    it("claims the slot on the very first call (no row exists yet) and returns the base (15分) deadline", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const result = await claimIngestSlot(now);
      expect(result).toEqual({
        claimed: true,
        cooldownUntil: new Date(now.getTime() + INGEST_BASE_COOLDOWN_MS).toISOString(),
      });
    });

    it("refuses a re-claim within the base cooldown window and returns the existing deadline", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const first = await claimIngestSlot(now);
      expect(first.claimed).toBe(true);

      const secondNow = new Date(now.getTime() + 1000); // 1秒後
      const second = await claimIngestSlot(secondNow);
      expect(second.claimed).toBe(false);
      expect(second.cooldownUntil).toBe(first.cooldownUntil);
    });

    it("claims again once INGEST_BASE_COOLDOWN_MS has fully elapsed", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const first = await claimIngestSlot(now);
      expect(first.claimed).toBe(true);

      const stillCoolingDown = new Date(now.getTime() + INGEST_BASE_COOLDOWN_MS - 1);
      const tooEarly = await claimIngestSlot(stillCoolingDown);
      expect(tooEarly.claimed).toBe(false);

      const afterCooldown = new Date(now.getTime() + INGEST_BASE_COOLDOWN_MS);
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
        expect(f.cooldownUntil).toBe(
          new Date(now.getTime() + INGEST_BASE_COOLDOWN_MS).toISOString(),
        );
      }
    });
  });

  describe("getCooldownUntil (raw comparison, no arithmetic)", () => {
    it("returns null when nothing has ever been claimed", async () => {
      expect(await getCooldownUntil()).toBeNull();
    });

    it("returns null once the claimed base window has passed", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      await claimIngestSlot(now);

      const after = new Date(now.getTime() + INGEST_BASE_COOLDOWN_MS + 1);
      expect(await getCooldownUntil(after)).toBeNull();
    });

    it("returns the stored deadline verbatim while still within the window", async () => {
      const now = new Date("2026-08-22T00:00:00.000Z");
      const claim = await claimIngestSlot(now);

      const soon = new Date(now.getTime() + 1000);
      expect(await getCooldownUntil(soon)).toBe(claim.cooldownUntil);
    });
  });

  describe("extendIngestCooldownAfterRun (extend: 4時間への延長。geminiCalls>0のときのみ)", () => {
    it("extends to INGEST_FULL_COOLDOWN_MS when geminiCalls > 0", async () => {
      const claimAt = new Date("2026-08-22T00:00:00.000Z");
      const claim = await claimIngestSlot(claimAt);

      const finishAt = new Date(claimAt.getTime() + 5000); // ランに5秒かかったと仮定
      await extendIngestCooldownAfterRun(claim.cooldownUntil, 3, finishAt);

      expect(await getIngestCooldownValue()).toBe(
        new Date(finishAt.getTime() + INGEST_FULL_COOLDOWN_MS).toISOString(),
      );
    });

    it("does NOT extend when geminiCalls === 0 (空振りはタダでやり直せる: base の15分のまま)", async () => {
      const claimAt = new Date("2026-08-22T00:00:00.000Z");
      const claim = await claimIngestSlot(claimAt);

      const finishAt = new Date(claimAt.getTime() + 5000);
      await extendIngestCooldownAfterRun(claim.cooldownUntil, 0, finishAt);

      expect(await getIngestCooldownValue()).toBe(claim.cooldownUntil);
    });

    it("CAS: does not overwrite a deadline claimed by someone else after this claim's own window already expired", async () => {
      const firstClaimAt = new Date("2026-08-22T00:00:00.000Z");
      const firstClaim = await claimIngestSlot(firstClaimAt);

      // 最初の確保が失効した後、別の呼び出しが新たに枠を確保する。
      const secondClaimAt = new Date(firstClaimAt.getTime() + INGEST_BASE_COOLDOWN_MS);
      const secondClaim = await claimIngestSlot(secondClaimAt);
      expect(secondClaim.claimed).toBe(true);
      expect(secondClaim.cooldownUntil).not.toBe(firstClaim.cooldownUntil);

      // 最初の claim を持っていた呼び出し元が、（本来ありえないタイミングだが）
      // 自分が確保した古い期限値で extend しようとしても、CAS が一致しないため
      // 新しい claim の期限を上書きしない。
      await extendIngestCooldownAfterRun(firstClaim.cooldownUntil, 5, secondClaimAt);

      expect(await getIngestCooldownValue()).toBe(secondClaim.cooldownUntil);
    });

    it("never shortens: extendIngestCooldown at the repository layer refuses to write a smaller value even when the CAS key matches", async () => {
      // extendIngestCooldownAfterRun() は常に now + INGEST_FULL_COOLDOWN_MS を
      // 書き込もうとするため、通常の呼び出し経路だけでは「CAS は一致するが
      // 新しい値の方が小さい」状況を作れない。この単調増加の保証を直接検証する
      // ため、repository 層の extendIngestCooldown() を直接呼ぶ。
      const claimAt = new Date("2026-08-22T00:00:00.000Z");
      const claim = await claimIngestSlot(claimAt);

      const largerDeadline = new Date(claimAt.getTime() + INGEST_FULL_COOLDOWN_MS).toISOString();
      const extended = await extendIngestCooldown(
        claimAt.toISOString(),
        claim.cooldownUntil,
        largerDeadline,
      );
      expect(extended).toBe(true);
      expect(await getIngestCooldownValue()).toBe(largerDeadline);

      // 同じ現在値（largerDeadline）に対して、それより小さい値への CAS を試みる
      // （expected は現在値と一致させている＝CAS 自体は通る条件）。
      const smallerDeadline = new Date(claimAt.getTime() + 1000).toISOString();
      const shortened = await extendIngestCooldown(
        claimAt.toISOString(),
        largerDeadline,
        smallerDeadline,
      );
      expect(shortened).toBe(false);
      expect(await getIngestCooldownValue()).toBe(largerDeadline); // 変化しない
    });

    it("is a true no-op when geminiCalls === 0: never touches the DB, so it does not throw even if the config table is missing", async () => {
      await db.run(sql.raw("DROP TABLE IF EXISTS config;"));
      await expect(
        extendIngestCooldownAfterRun("2026-08-22T00:15:00.000Z", 0, new Date()),
      ).resolves.toBeUndefined();
    });
  });

  describe("acquireIngestLease / releaseIngestLease (exclusive execution lock, TTL = INGEST_LEASE_TTL_MS = 2分, independent from cooldown)", () => {
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

    it("allows re-acquisition once INGEST_LEASE_TTL_MS (2分) has fully elapsed (auto-recovery from a crash)", async () => {
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

    it("is independent from the cooldown mechanism: acquiring/releasing the lease does not touch the cooldown key", async () => {
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

    it("getIngestCooldownValue() は throw せず null を返す（getFeedCards と同じフェイルソフトのパターン）", async () => {
      await expect(getIngestCooldownValue()).resolves.toBeNull();
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

    it("releaseIngestLease() も書き込み経路として throw する", async () => {
      await expectRejectsWithMissingTable(() => releaseIngestLease());
    });

    it("extendIngestCooldownAfterRun() は geminiCalls > 0 のとき書き込み経路として throw する", async () => {
      await expectRejectsWithMissingTable(() =>
        extendIngestCooldownAfterRun("2026-08-22T00:15:00.000Z", 1),
      );
    });
  });
});
