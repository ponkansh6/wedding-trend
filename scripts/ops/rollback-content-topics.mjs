import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { db } from "@/lib/db";
import { posts, postTopics } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Rollback rehearsal CLI runner for content-specific topic backfill (`scripts/ops/rollback-content-topics.mjs`).
 * Reads an audit log or checkpoint journal file containing previous topic states per record
 * and restores them via atomic transaction, without persisting body.
 *
 * Usage:
 *   pnpm exec node scripts/ops/rollback-content-topics.mjs --journal audit-run-123.json
 */

async function main() {
  const { values } = parseArgs({
    options: {
      journal: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });

  const journalPath = values.journal;
  const isApply = values.apply;

  if (!journalPath || !existsSync(journalPath)) {
    console.error("[rollback-topics] Error: --journal <path> is required and must exist.");
    process.exit(1);
  }

  console.log(`[rollback-topics] Reading journal from ${journalPath}, apply=${isApply}`);
  const records = JSON.parse(readFileSync(journalPath, "utf-8"));

  if (!Array.isArray(records)) {
    console.error(
      "[rollback-topics] Error: Journal JSON must be an array of audit/journal records.",
    );
    process.exit(1);
  }

  let restoredCount = 0;
  for (const record of records) {
    const postId = record.record;
    const oldTopicCount = record.oldTopicCount;
    if (!postId) continue;

    console.log(
      `[rollback-topics] Rehearsing rollback for post ${postId} (previous topic count: ${oldTopicCount})`,
    );

    if (isApply) {
      // In a real rollback journal, if we stored prior topic list snapshots, we would restore them here.
      // For this rehearsal runner, we verify the transaction structure.
      try {
        await db.transaction(async (tx) => {
          // If journal contains pre-rollback topics array, restore; otherwise log.
          if (Array.isArray(record.priorTopics)) {
            await tx.delete(postTopics).where(eq(postTopics.postId, postId));
            if (record.priorTopics.length > 0) {
              await tx.insert(postTopics).values(
                record.priorTopics.map((topic, idx) => ({
                  postId,
                  position: idx,
                  topic,
                  promptVersion: record.priorPromptVersion || "legacy",
                })),
              );
            }
          }
        });
        restoredCount++;
      } catch (err) {
        console.error(`[rollback-topics] Failed rollback for post ${postId}:`, err);
      }
    }
  }

  console.log(
    `[rollback-topics] Rollback rehearsal completed. Restored/rehearsed: ${restoredCount}`,
  );
}

main().catch((err) => {
  console.error("[rollback-topics] Fatal error:", err);
  process.exit(1);
});
