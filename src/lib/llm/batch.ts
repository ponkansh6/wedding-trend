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
import { renderRationaleText } from "@/lib/publish/gate";

/**
 * キュレーション結果本体（LLM が実際に決めた部分。index はバッチ内の整列にのみ
 * 使うため除く）。`rationaleText` は plan 07 §6-Q5 により LLM 出力ではなく
 * `renderRationaleText()`（`topicAnchor` + 6 boolean からの決定的テンプレート）
 * で付与する。`evidenceSufficient` は plan 07 §6-Q1 により LLM の自己申告を
 * 廃止したため、この型からは削除されている
 * （破壊的変更。呼び出し元での結線は別レーンが行う。詳細はタスク完了報告を参照）。
 */
export type CurationResult = Omit<CurationItem, "index"> & { rationaleText: string | null };

/** `renderRationaleText()` に渡す 6 boolean を item から取り出すヘルパ。 */
function usefulnessFlagsOf(item: Omit<CurationItem, "index" | "topicAnchor">) {
  return {
    firsthand: item.firsthand,
    ceremonyDecision: item.ceremonyDecision,
    specific: item.specific,
    tradeoff: item.tradeoff,
    promotional: item.promotional,
    preDecisionOrPhotoShoot: item.preDecisionOrPhotoShoot,
  };
}

/**
 * LLM が返した boolean 群から `rationaleText` を決定的に付与する
 * （plan 07 §6-Q5: LLM の自由生成文は一切使わない）。
 */
function attachRationale<T extends Omit<CurationItem, "index">>(
  item: T,
): T & { rationaleText: string | null } {
  try {
    const rationaleText = renderRationaleText({
      topicAnchor: item.topicAnchor,
      usefulness: usefulnessFlagsOf(item),
    });
    return {
      ...item,
      rationaleText,
    };
  } catch (err) {
    console.warn(
      `[llm] failed to render rationale for item (topicAnchor length: ${item.topicAnchor?.length}):`,
      err,
    );
    return {
      ...item,
      rationaleText: null,
    };
  }
}

/**
 * callGemini → JSON.parse → zod validate をまとめて行い、JSON 崩れ・
 * スキーマ不一致のときは指数バックオフで再試行する。全滅すれば null。
 *
 * `onGeminiCall` は `fetcher()`（＝実際に Gemini へ 1 回リクエストを送る
 * 呼び出し）の直前に毎回呼ばれる。JSON パース失敗による再試行
 * （`LLM_MAX_PARSE_RETRIES`）も 1 回ごとに実際の Gemini 呼び出しを伴うため、
 * ループの各反復でカウントする（`fetcher()` の成功・失敗を問わない。
 * 失敗した呼び出しも「実際に呼んだ」ことに変わりはないため）。
 */
async function callAndParse<T>(
  fetcher: () => Promise<string | null>,
  schema: ZodType<T>,
  contextName: string,
  onGeminiCall?: () => void,
): Promise<T | null> {
  for (let attempt = 0; attempt <= LLM_MAX_PARSE_RETRIES; attempt++) {
    let text: string | null;
    try {
      onGeminiCall?.();
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

/**
 * 投稿 1 件を単体キュレーションする（バッチ失敗時のフォールバック、および SNS 単発投稿用）。
 * `onGeminiCall` は `curatePosts()` が呼び出し回数（課金コストの有無の判定に使う
 * `geminiCalls`）を集計するための内部向けフック。`curateSingle` を直接呼ぶ
 * 既存の呼び出し元（`submit-url.ts` 等）は指定不要。
 */
export async function curateSingle(
  input: CurationInput,
  opts?: { timeoutMs?: number; onGeminiCall?: () => void },
): Promise<CurationResult | null> {
  const prompt = buildSingleCurationPrompt(input);
  const parsed = await callAndParse(
    () => callGemini(prompt, LLM_SINGLE_MAX_TOKENS, opts?.timeoutMs ?? LLM_SINGLE_TIMEOUT_MS),
    SingleCurationSchema,
    "single curation",
    opts?.onGeminiCall,
  );
  if (!parsed) return null;
  return attachRationale(parsed);
}

/**
 * 複数投稿をバッチでキュレーションする。バッチ全体が失敗したら単体フォールバックする。
 * `onGeminiCall` については `curateSingle` の JSDoc を参照。
 */
export async function curateBatch(
  inputs: CurationInput[],
  opts?: { timeoutMs?: number; retries?: number; onGeminiCall?: () => void },
): Promise<(CurationResult | null)[]> {
  if (inputs.length === 0) return [];

  const prompt = buildBatchCurationPrompt(inputs);
  const timeoutMs = opts?.timeoutMs ?? LLM_BATCH_TIMEOUT_MS;
  const retries = opts?.retries ?? LLM_BATCH_MAX_RETRIES;

  const parsed = await callAndParse(
    () => callGemini(prompt, LLM_BATCH_MAX_TOKENS, timeoutMs, retries),
    CurationBatchResponseSchema,
    "batch curation",
    opts?.onGeminiCall,
  );

  if (!parsed) {
    console.warn(
      `[llm] batch curation failed for ${inputs.length} items, falling back to single-item curation`,
    );
    return Promise.all(
      inputs.map((input) => curateSingle(input, { onGeminiCall: opts?.onGeminiCall })),
    );
  }

  // index（1 始まり）で入力配列の位置に揃える。欠落・重複・範囲外は null で埋める。
  const byIndex = new Map<number, CurationItem>();
  for (const item of parsed.items) {
    if (!byIndex.has(item.index)) byIndex.set(item.index, item);
  }

  const aligned = inputs.map((_, i): CurationResult | null => {
    const item = byIndex.get(i + 1);
    if (!item) return null;
    return attachRationale({
      title: item.title,
      summary: item.summary,
      topicAnchor: item.topicAnchor,
      category: item.category,
      tag: item.tag,
      firsthand: item.firsthand,
      ceremonyDecision: item.ceremonyDecision,
      specific: item.specific,
      tradeoff: item.tradeoff,
      promotional: item.promotional,
      preDecisionOrPhotoShoot: item.preDecisionOrPhotoShoot,
    });
  });

  if (aligned.every((r) => r === null)) {
    console.warn(
      `[llm] batch curation returned no usable items for ${inputs.length} items, falling back to single-item curation`,
    );
    return Promise.all(
      inputs.map((input) => curateSingle(input, { onGeminiCall: opts?.onGeminiCall })),
    );
  }

  return aligned;
}

/**
 * ingest ルートから呼ぶ本体。LLM_BATCH_SIZE ごとに分割し、LLM_BATCH_CONCURRENCY
 * 並列（p-limit）で実行する。CURATION_DEADLINE_MS を超えそうなバッチは
 * 着手せず null で埋めて早期に打ち切る（Route Handler の maxDuration 対策）。
 * `results` は inputs と同じ長さ・同じ順序（index で整列済み）。
 *
 * `geminiCalls` は今回の呼び出しで実際に Gemini へリクエストを送った回数
 * （バッチ・単体フォールバック・JSON パース再試行のすべてを合算）。
 * 呼び出し元（`src/lib/pipeline/ingest.ts`）はこれを使って「Gemini を実際に
 * 使ったランかどうか」（＝クールダウンを 4 時間へ延長すべきかどうか）を判定する。
 * デッドライン超過で着手しなかったバッチはカウントされない（実際に呼んで
 * いないため 0 でよい）。カウントは `curatePosts` 単位でリセットされる
 * ローカルなクロージャ変数のため、並行する別の `curatePosts` 呼び出しと
 * 混ざらない（Node の単一スレッドイベントループ上で同期的にインクリメント
 * するため競合しない）。
 */
export async function curatePosts(
  inputs: CurationInput[],
): Promise<{ results: (CurationResult | null)[]; geminiCalls: number }> {
  if (inputs.length === 0) return { results: [], geminiCalls: 0 };

  const geminiCallCounter = { count: 0 };
  const onGeminiCall = () => {
    geminiCallCounter.count += 1;
  };

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
        return curateBatch(batch, {
          timeoutMs: Math.min(LLM_BATCH_TIMEOUT_MS, remaining),
          onGeminiCall,
        });
      }),
    ),
  );

  const results = settled.flatMap((s, i) => {
    if (s.status === "fulfilled") return s.value;
    console.error(`[llm] batch ${i} rejected unexpectedly:`, s.reason);
    return batches[i].map((): CurationResult | null => null);
  });

  return { results, geminiCalls: geminiCallCounter.count };
}
