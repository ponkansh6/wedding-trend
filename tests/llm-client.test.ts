import { describe, expect, it, vi, beforeEach } from "vitest";
import { backoffMs, callGemini } from "@/lib/llm/client";

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel = vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      });
    },
  };
});

describe("LLM Client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("backoffMs", () => {
    it("computes exponential backoff with jitter", () => {
      const b0 = backoffMs(0, 1000);
      expect(b0).toBeGreaterThanOrEqual(1000);
      expect(b0).toBeLessThan(2000);

      const b1 = backoffMs(1, 1000);
      expect(b1).toBeGreaterThanOrEqual(2000);
      expect(b1).toBeLessThan(3000);
    });
  });

  describe("callGemini", () => {
    it("throws an error if GOOGLE_API_KEY is not set", async () => {
      const originalKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;
      try {
        await expect(callGemini("prompt", 100, 1000)).rejects.toThrow(
          "GOOGLE_API_KEY environment variable is not set",
        );
      } finally {
        process.env.GOOGLE_API_KEY = originalKey;
      }
    });

    it("returns response text on success", async () => {
      process.env.GOOGLE_API_KEY = "test-key";
      mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => '{"result": "ok"}' },
      });

      const res = await callGemini("prompt", 100, 1000);
      expect(res).toBe('{"result": "ok"}');
    });

    it("retries on 429 rate limit error and eventually succeeds", async () => {
      process.env.GOOGLE_API_KEY = "test-key";
      const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429 });
      mockGenerateContent
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ response: { text: () => "success after retry" } });

      vi.stubGlobal(
        "setTimeout",
        vi.fn((cb: () => void) => {
          cb();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }),
      );

      const res = await callGemini("prompt", 100, 1000, 2);
      expect(res).toBe("success after retry");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it("retries on 5xx transient error and eventually succeeds", async () => {
      process.env.GOOGLE_API_KEY = "test-key";
      const transientError = new Error("Model is overloaded");
      mockGenerateContent
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ response: { text: () => "success after 5xx" } });

      vi.stubGlobal(
        "setTimeout",
        vi.fn((cb: () => void) => {
          cb();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }),
      );

      const res = await callGemini("prompt", 100, 1000, 2);
      expect(res).toBe("success after 5xx");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it("throws error immediately on non-retryable error", async () => {
      process.env.GOOGLE_API_KEY = "test-key";
      const fatalError = Object.assign(new Error("Invalid Argument"), { status: 400 });
      mockGenerateContent.mockRejectedValueOnce(fatalError);

      await expect(callGemini("prompt", 100, 1000, 2)).rejects.toThrow("Gemini API error");
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it("throws error after max retries are exhausted", async () => {
      process.env.GOOGLE_API_KEY = "test-key";
      const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429 });
      mockGenerateContent.mockRejectedValue(rateLimitError);

      vi.stubGlobal(
        "setTimeout",
        vi.fn((cb: () => void) => {
          cb();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }),
      );

      await expect(callGemini("prompt", 100, 1000, 1)).rejects.toThrow("Gemini API error");
    });
  });
});
