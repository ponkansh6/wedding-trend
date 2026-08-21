import pLimit from "p-limit";
import type { ZodType } from "zod";
import {
  CURATION_DEADLINE_MS,
  CURATION_MIN_SLICE_MS,
  DEBUG_LOG_TRUNCATE_LENGTH,
  LLM_BATCH_CONCURRENCY,
  LLM_BATCH_MAX_RETRIES,
  LLM_BATCH_MAX_TOKENS,
  LLM_BATCH_SIZE,
  LLM_BATCH_TIMEOUT_MS,
  LLM_MAX_PARSE_RETRIES,
  LLM_SINGLE_MAX_TOKENS,
  LLM_SINGLE_TIMEOUT_MS,
} from "@/lib/constants";
import { backoffMs, callGemini } from "./client";
import { buildBatchCurationPrompt, buildSingleCurationPrompt } from "./prompts";
import {
  CurationBatchResponseSchema,
  CurationItemSchema,
  type CurationInput,
  type CurationItem,
} from "./schemas";

/** キュレーション結果本体（LLM が実際に決めた部分。index はバッチ内の整列にのみ使うため除く）。 */
export type CurationResult = Omit<CurationItem, "index">;

/**
 * callGemini → JSON.parse → zod validate をまとめて行い、JSON 崩れ・
 * スキーマ不一致のときは指数バックオフで再試行する。全滅すれば null。
 */
async function callAndParse<T>(
  fetcher: () => Promise<string | null>,
  schema: ZodType<T>,
  contextName: string,
): Promise<T | null> {
  for (let attempt = 0; attempt <= LLM_MAX_PARSE_RETRIES; attempt++) {
    let text: string | null;
    try {
      text = await fetcher();
    } catch (err) {
      console.error(`[llm] ${contextName} call failed:`, err);
      return null;
    }
    if (!text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(
        `[llm] ${contextName} invalid JSON (attempt ${attempt + 1}/${LLM_MAX_PARSE_RETRIES + 1}):`,
        text.slice(0, DEBUG_LOG_TRUNCATE_LENGTH),
      );
      if (attempt < LLM_MAX_PARSE_RETRIES) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      return null;
    }

    const result = schema.safeParse(parsed);
    if (result.success) return result.data;

    console.warn(
      `[llm] ${contextName} schema validation failed (attempt ${attempt + 1}/${LLM_MAX_PARSE_RETRIES + 1}):`,
      result.error.issues,
    );
    if (attempt < LLM_MAX_PARSE_RETRIES) {
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      continue;
    }
    return null;
  }
  return null;
}

const SingleCurationSchema = CurationItemSchema.omit({ index: true });

/** 投稿 1 件を単体キュレーションする（バッチ失敗時のフォールバック、および SNS 単発投稿用）。 */
export async function curateSingle(
  input: CurationInput,
  opts?: { timeoutMs?: number },
): Promise<CurationResult | null> {
  const prompt = buildSingleCurationPrompt(input);
  return callAndParse(
    () => callGemini(prompt, LLM_SINGLE_MAX_TOKENS, opts?.timeoutMs ?? LLM_SINGLE_TIMEOUT_MS),
    SingleCurationSchema,
    "single curation",
  );
}

/** 複数投稿をバッチでキュレーションする。バッチ全体が失敗したら単体フォールバックする。 */
export async function curateBatch(
  inputs: CurationInput[],
  opts?: { timeoutMs?: number; retries?: number },
): Promise<(CurationResult | null)[]> {
  if (inputs.length === 0) return [];

  const prompt = buildBatchCurationPrompt(inputs);
  const timeoutMs = opts?.timeoutMs ?? LLM_BATCH_TIMEOUT_MS;
  const retries = opts?.retries ?? LLM_BATCH_MAX_RETRIES;

  const parsed = await callAndParse(
    () => callGemini(prompt, LLM_BATCH_MAX_TOKENS, timeoutMs, retries),
    CurationBatchResponseSchema,
    "batch curation",
  );

  if (!parsed) {
    console.warn(
      `[llm] batch curation failed for ${inputs.length} items, falling back to single-item curation`,
    );
    return Promise.all(inputs.map((input) => curateSingle(input)));
  }

  // index（1 始まり）で入力配列の位置に揃える。欠落・重複・範囲外は null で埋める。
  const byIndex = new Map<number, CurationItem>();
  for (const item of parsed.items) {
    if (!byIndex.has(item.index)) byIndex.set(item.index, item);
  }

  const aligned = inputs.map((_, i): CurationResult | null => {
    const item = byIndex.get(i + 1);
    if (!item) return null;
    return { title: item.title, summary: item.summary, category: item.category, tag: item.tag };
  });

  if (aligned.every((r) => r === null)) {
    console.warn(
      `[llm] batch curation returned no usable items for ${inputs.length} items, falling back to single-item curation`,
    );
    return Promise.all(inputs.map((input) => curateSingle(input)));
  }

  return aligned;
}

/**
 * ingest ルートから呼ぶ本体。LLM_BATCH_SIZE ごとに分割し、LLM_BATCH_CONCURRENCY
 * 並列（p-limit）で実行する。CURATION_DEADLINE_MS を超えそうなバッチは
 * 着手せず null で埋めて早期に打ち切る（Route Handler の maxDuration 対策）。
 * 戻り値は inputs と同じ長さ・同じ順序（index で整列済み）。
 */
export async function curatePosts(inputs: CurationInput[]): Promise<(CurationResult | null)[]> {
  if (inputs.length === 0) return [];

  const batches: CurationInput[][] = [];
  for (let start = 0; start < inputs.length; start += LLM_BATCH_SIZE) {
    batches.push(inputs.slice(start, start + LLM_BATCH_SIZE));
  }

  const deadline = Date.now() + CURATION_DEADLINE_MS;
  const limit = pLimit(LLM_BATCH_CONCURRENCY);

  const settled = await Promise.allSettled(
    batches.map((batch) =>
      limit((): Promise<(CurationResult | null)[]> => {
        const remaining = deadline - Date.now();
        if (remaining < CURATION_MIN_SLICE_MS) {
          console.warn(
            `[llm] curatePosts: deadline exceeded, skipping batch of ${batch.length} items`,
          );
          return Promise.resolve(batch.map((): CurationResult | null => null));
        }
        return curateBatch(batch, { timeoutMs: Math.min(LLM_BATCH_TIMEOUT_MS, remaining) });
      }),
    ),
  );

  return settled.flatMap((s, i) => {
    if (s.status === "fulfilled") return s.value;
    console.error(`[llm] batch ${i} rejected unexpectedly:`, s.reason);
    return batches[i].map((): CurationResult | null => null);
  });
}
