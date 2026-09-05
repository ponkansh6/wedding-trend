import { describe, it, expect } from "vitest";
import { classifyLlmError } from "@/lib/llm/error-kind";

describe("classifyLlmError", () => {
  it("classifies rate limit / 429 / quota as rate_capped", () => {
    expect(classifyLlmError({ status: 429, message: "Too Many Requests" })).toBe("rate_capped");
    expect(classifyLlmError({ code: "429", message: "rate_limit_exceeded" })).toBe("rate_capped");
    expect(classifyLlmError(new Error("Resource has been exhausted (quota exceeded)"))).toBe(
      "rate_capped",
    );
    expect(classifyLlmError("Error: 429 rate limit reached")).toBe("rate_capped");
  });

  it("classifies 5xx / timeout / network issues as transient", () => {
    expect(classifyLlmError({ status: 503, message: "Service Unavailable" })).toBe("transient");
    expect(classifyLlmError({ status: 500, message: "Internal Server Error" })).toBe("transient");
    expect(classifyLlmError(new Error("Model is overloaded, please try again"))).toBe("transient");
    expect(classifyLlmError({ message: "Request timeout after 30000ms" })).toBe("transient");
    expect(classifyLlmError({ message: "connect ETIMEDOUT 142.250.190.46:443" })).toBe("transient");
  });

  it("classifies 4xx (non-429) / auth / invalid-arg as terminal", () => {
    expect(classifyLlmError({ status: 400, message: "Invalid argument provided" })).toBe(
      "terminal",
    );
    expect(classifyLlmError({ status: 401, message: "Unauthorized API key" })).toBe("terminal");
    expect(classifyLlmError({ status: 403, message: "Forbidden access" })).toBe("terminal");
    expect(classifyLlmError(new Error("API_KEY_INVALID"))).toBe("terminal");
  });

  it("classifies unrecognized errors as unknown", () => {
    expect(classifyLlmError(null)).toBe("unknown");
    expect(classifyLlmError(undefined)).toBe("unknown");
    expect(classifyLlmError({})).toBe("unknown");
    expect(classifyLlmError("some random error text")).toBe("unknown");
  });
});
