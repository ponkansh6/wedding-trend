/**
 * Purpose: Feed-related database operations (config-linked feed helpers and sorting/pagination).
 * When called: Used by feed presentation and public retrieval layers.
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { config } from "./schema";

const INGEST_COOLDOWN_KEY = "ingest_cooldown_until";

export async function getIngestCooldownValue(): Promise<string | null> {
  try {
    const rows = await db
      .select({ value: config.value })
      .from(config)
      .where(eq(config.key, INGEST_COOLDOWN_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch (err) {
    console.warn("[db] getIngestCooldownValue query error:", err);
    return null;
  }
}
