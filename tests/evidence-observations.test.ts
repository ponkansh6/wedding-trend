import { describe, it, expect } from "vitest";
import { setupTestDb } from "./helpers/test-db";
import { db } from "@/lib/db";
import { evidenceSignalObservations } from "@/lib/db/schema";
import { recordEvidenceObservation } from "@/lib/db/repository";
import { eq } from "drizzle-orm";

describe("evidence signal observations (shadow recording)", () => {
  it("records and retrieves evidence signal observations correctly", async () => {
    await setupTestDb();

    await recordEvidenceObservation({
      urlHash: "abc123hash",
      host: "example.com",
      textLength: 1500,
      linkDensity: 0.05,
      paragraphCount: 5,
      passedGate: true,
      failedConditions: null,
      observedAt: new Date().toISOString(),
    });

    const rows = await db
      .select()
      .from(evidenceSignalObservations)
      .where(eq(evidenceSignalObservations.urlHash, "abc123hash"));

    expect(rows).toHaveLength(1);
    expect(rows[0].host).toBe("example.com");
    expect(rows[0].textLength).toBe(1500);
    expect(rows[0].linkDensity).toBe(0.05);
    expect(rows[0].paragraphCount).toBe(5);
    expect(rows[0].passedGate).toBe(true);
    expect(rows[0].failedConditions).toBeNull();
  });
});
