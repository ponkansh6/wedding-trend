import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  HTTP_STATUS_TOO_MANY_REQUESTS,
  LLM_BACKOFF_BASE_MS,
  LLM_GEN_TEMPERATURE,
  LLM_MAX_RETRIES,
  LLM_MODEL,
} from "@/lib/constants";

export { LLM_MODEL };

/** 指数バックオフ + ジッター。base * 2^attempt + [0, base) のランダム値。 */
export function backoffMs(attempt: number, baseMs = LLM_BACKOFF_BASE_MS): number {
  return baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
}

/**
 * Gemini を呼び出し、応答テキスト（JSON 文字列想定）を返す。
 * 429 / 5xx 系の一時的なエラーには指数バックオフで自動リトライする。
 * それ以外のエラーは呼び出し側に投げる。
 */
export async function callGemini(
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
  retries = LLM_MAX_RETRIES,
): Promise<string | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY environment variable is not set");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: LLM_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: maxTokens,
      temperature: LLM_GEN_TEMPERATURE,
    },
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt, { timeout: timeoutMs });
      const response = await result.response;
      return response.text();
    } catch (err: unknown) {
      const apiError = err as { status?: number; message?: string };
      const isRateLimit = apiError.status === HTTP_STATUS_TOO_MANY_REQUESTS;
      const isTransient = /5\d\d|overloaded|unavailable|timeout/i.test(apiError.message ?? "");

      if ((isRateLimit || isTransient) && attempt < retries) {
        const waitMs = backoffMs(attempt);
        console.warn(
          `[llm] Gemini ${isRateLimit ? "rate limit" : "transient error"}: ${apiError.message} (retry ${attempt + 1}/${retries}), waiting ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      const error = new Error(
        `Gemini API error: ${apiError.message} (status: ${apiError.status ?? "unknown"})`,
      );
      error.cause = apiError;
      throw error;
    }
  }
  throw new Error("Gemini API call failed after retries");
}
