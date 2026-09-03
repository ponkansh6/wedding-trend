import { LLM_BATCH_MAX_RETRIES, LLM_BATCH_MAX_TOKENS, LLM_BATCH_TIMEOUT_MS } from "@/lib/constants";
import { backoffMs, callGemini } from "./client";
import { buildTopicsBatchPrompt, type TopicCurationInput } from "./topics-prompts";
import { TopicExtractionBatchResponseSchema, type TopicExtractionItem } from "./topics-schemas";
import { validateTopics } from "@/lib/publish/gate";

export interface TopicBatchResult {
  id: string;
  topics: string[];
}

/**
 * Curate topics for a batch of records reusing client.ts Gemini base.
 * Enforces batch limit 25, opaque id mapping, strict id-complete check.
 * Keeps slice in memory only, null originalExcerpt, discard after LLM.
 */
export async function curateTopicsBatch(
  inputs: TopicCurationInput[],
): Promise<Map<string, string[]>> {
  if (inputs.length === 0) return new Map();

  // Batch limit 25 per plan requirements
  const BATCH_LIMIT = 25;
  const results = new Map<string, string[]>();

  for (let i = 0; i < inputs.length; i += BATCH_LIMIT) {
    const chunk = inputs.slice(i, i + BATCH_LIMIT);
    const prompt = buildTopicsBatchPrompt(chunk);

    let parsedItems: TopicExtractionItem[] = [];
    let attempt = 0;
    let success = false;

    while (attempt <= LLM_BATCH_MAX_RETRIES && !success) {
      attempt++;
      try {
        const rawText = await callGemini(
          prompt,
          LLM_BATCH_MAX_TOKENS,
          LLM_BATCH_TIMEOUT_MS,
          LLM_BATCH_MAX_RETRIES,
        );
        if (!rawText) throw new Error("Empty response from Gemini");

        // JSON extraction
        let jsonStr = rawText.trim();
        if (jsonStr.startsWith("```json")) {
          jsonStr = jsonStr.replace(/^```json\s*/, "").replace(/\s*```$/, "");
        } else if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/^```\s*/, "").replace(/\s*```$/, "");
        }

        const parsedJson = JSON.parse(jsonStr);
        const validated = TopicExtractionBatchResponseSchema.parse(parsedJson);
        parsedItems = validated.items;
        success = true;
      } catch {
        if (attempt > LLM_BATCH_MAX_RETRIES) {
          break;
        }
        const wait = backoffMs(attempt);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    // Map by id and validate via validateTopics() downstream, trim to 4, allow []
    const parsedMap = new Map<string, string[]>();
    for (const item of parsedItems) {
      const gateResult = validateTopics(item.topics, "");
      const validatedTopics = gateResult.ok ? gateResult.topics : [];
      parsedMap.set(item.id, validatedTopics);
    }

    // Strict id-complete check: every input id must have output (fallback to [] if missing)
    for (const input of chunk) {
      const topics = parsedMap.get(input.id) || [];
      results.set(input.id, topics);
    }
  }

  return results;
}

/**
 * Shadow evaluation hook: offline compare current vs candidate on same regulated input, no prod write.
 */
export async function shadowEvaluateTopics(
  inputs: TopicCurationInput[],
  currentTopicsMap: Map<string, string[]>,
): Promise<{
  matchRate: number;
  details: Array<{ id: string; current: string[]; candidate: string[] }>;
}> {
  const candidateMap = await curateTopicsBatch(inputs);
  let matches = 0;
  const details: Array<{ id: string; current: string[]; candidate: string[] }> = [];

  for (const input of inputs) {
    const current = currentTopicsMap.get(input.id) || [];
    const candidate = candidateMap.get(input.id) || [];
    const isSame = JSON.stringify(current) === JSON.stringify(candidate);
    if (isSame) matches++;
    details.push({ id: input.id, current, candidate });
  }

  const matchRate = inputs.length > 0 ? matches / inputs.length : 1;
  return { matchRate, details };
}
