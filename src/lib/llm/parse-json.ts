export function stripCodeFence(text: string): string {
  let jsonStr = text.trim();
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return jsonStr.trim();
}

export function parseLlmJson<T>(text: string): T {
  const stripped = stripCodeFence(text);
  try {
    return JSON.parse(stripped) as T;
  } catch (err) {
    const preview = stripped.length > 80 ? stripped.slice(0, 80) + "..." : stripped;
    throw new SyntaxError(
      `Failed to parse LLM JSON: ${err instanceof Error ? err.message : String(err)}. Preview: "${preview}"`,
    );
  }
}
