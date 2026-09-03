import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { db } from "@/lib/db";
import { posts, postTopics } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  selectCandidates,
  regulatedFetchAndSlice,
  computeTopicBackfillSignature,
  assertNoSliceLeak,
  ALLOWED_AUDIT_KEYS,
} from "../lib/content-topic-backfill.mjs";
import { curateTopicsBatch } from "@/lib/llm/topics-batch";
import { LLM_MODEL, CURATION_PROMPT_VERSION } from "@/lib/constants";

/**
 * CLI runner for content-specific topic backfill (`scripts/ops/backfill-content-topics.mjs`).
 * Supports --dry-run (default, write=0), --apply, --limit, --host, --chunk (25), --run-id, --resume.
 */

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: true },
      apply: { type: "boolean", default: false },
      limit: { type: "string", default: "50" },
      host: { type: "string" },
      chunk: { type: "string", default: "25" },
      "run-id": { type: "string" },
      resume: { type: "string" },
    },
    strict: true,
  });

  const isDryRun = values["apply"] ? false : true;
  const limit = parseInt(values.limit, 10);
  const chunkSize = parseInt(values.chunk, 10);
  const runId = values["run-id"] || `run-${Date.now()}`;
  const resumeFile = values.resume;

  console.log(`[backfill-topics] Starting runId=${runId}, dryRun=${isDryRun}, limit=${limit}`);

  // Load checkpoint if resume specified
  let processedIds = new Set();
  if (resumeFile && existsSync(resumeFile)) {
    try {
      const data = JSON.parse(readFileSync(resumeFile, "utf-8"));
      if (data.processedIds && Array.isArray(data.processedIds)) {
        processedIds = new Set(data.processedIds);
        console.log(
          `[backfill-topics] Resumed from checkpoint: ${processedIds.size} items already processed.`,
        );
      }
    } catch (err) {
      console.warn("[backfill-topics] Failed to load resume checkpoint:", err);
    }
  }

  const candidates = await selectCandidates(db, { limit, host: values.host });
  console.log(`[backfill-topics] Selected ${candidates.length} candidates.`);

  const auditLog = [];
  let updatedCount = 0;
  const chunkBatch = [];

  for (const candidate of candidates) {
    if (processedIds.has(candidate.id)) continue;

    const sourceHost = new URL(candidate.url).host;
    const fetchResult = await regulatedFetchAndSlice(candidate.url);

    if (!fetchResult.success) {
      const auditRecord = {
        run: runId,
        record: candidate.id,
        sourceHost,
        sourceId: candidate.sourceId,
        httpStatus: 200,
        redirectClassification: "none",
        gateReason: fetchResult.verdict,
        bytes: fetchResult.bytes || 0,
        timingMs: fetchResult.timingMs || 0,
        attempt: 1,
        digest: null,
        signature: null,
        version: String(CURATION_PROMPT_VERSION),
        oldTopicCount: candidate.topics.length,
        newTopicCount: candidate.topics.length,
        outcome: "no_op",
      };
      assertNoSliceLeak(auditRecord);
      auditLog.push(auditRecord);
      processedIds.add(candidate.id);
      continue;
    }

    chunkBatch.push({
      id: String(candidate.id),
      title: fetchResult.title,
      slice: fetchResult.slice,
      candidate,
      fetchResult,
      sourceHost,
    });

    if (chunkBatch.length >= chunkSize || candidates.indexOf(candidate) === candidates.length - 1) {
      // Execute batch curation
      const llmInputs = chunkBatch.map((b) => ({ id: b.id, title: b.title, slice: b.slice }));
      let batchResults = new Map();
      try {
        batchResults = await curateTopicsBatch(llmInputs);
      } catch (err) {
        console.error("[backfill-topics] Batch curation failed:", err);
      }

      for (const item of chunkBatch) {
        const newTopics = batchResults.get(item.id) || [];
        const signature = computeTopicBackfillSignature({
          recordId: item.candidate.id,
          normalizedUrl: item.candidate.url,
          sourceContentDigest: item.fetchResult.sourceContentDigest,
          extractionVersion: "v1",
          topicPromptVersion: String(CURATION_PROMPT_VERSION),
          schemaVersion: "v1",
          modelId: LLM_MODEL,
        });

        const auditRecord = {
          run: runId,
          record: item.candidate.id,
          sourceHost: item.sourceHost,
          sourceId: item.candidate.sourceId,
          httpStatus: 200,
          redirectClassification: "none",
          gateReason: "success",
          bytes: item.fetchResult.bytes,
          timingMs: item.fetchResult.timingMs,
          attempt: 1,
          digest: item.fetchResult.sourceContentDigest,
          signature,
          version: String(CURATION_PROMPT_VERSION),
          oldTopicCount: item.candidate.topics.length,
          newTopicCount: newTopics.length,
          outcome: isDryRun ? "dry_run_success" : "success",
        };
        assertNoSliceLeak(auditRecord);
        auditLog.push(auditRecord);
        processedIds.add(item.candidate.id);

        if (!isDryRun && newTopics.length > 0) {
          // Atomic topics-only replacement transaction
          try {
            await db.transaction(async (tx) => {
              await tx.delete(postTopics).where(eq(postTopics.postId, item.candidate.id));
              const rowsToInsert = newTopics.map((topic, idx) => ({
                postId: item.candidate.id,
                position: idx,
                topic,
                promptVersion: String(CURATION_PROMPT_VERSION),
              }));
              await tx.insert(postTopics).values(rowsToInsert);
            });
            updatedCount++;
          } catch (txErr) {
            console.error(
              `[backfill-topics] Failed to write topics for post ${item.candidate.id}:`,
              txErr,
            );
          }
        }
      }
      chunkBatch.length = 0;
    }
  }

  console.log(
    `[backfill-topics] Finished. DryRun: ${isDryRun}, Updated: ${updatedCount}, Audited: ${auditLog.length}`,
  );
}

main().catch((err) => {
  console.error("[backfill-topics] Fatal error:", err);
  process.exit(1);
});
