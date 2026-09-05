import { describe, it, expect } from "vitest";
import { stripCodeFence, parseLlmJson } from "@/lib/llm/parse-json";

describe("parse-json", () => {
  it("strips ```json code fence", () => {
    const raw = '```json\n{"foo": "bar"}\n```';
    expect(stripCodeFence(raw)).toBe('{"foo": "bar"}');
  });

  it("strips generic ``` code fence", () => {
    const raw = "```\n[1, 2, 3]\n```";
    expect(stripCodeFence(raw)).toBe("[1, 2, 3]");
  });

  it("handles unfenced JSON", () => {
    const raw = '  {"hello": true}  ';
    expect(stripCodeFence(raw)).toBe('{"hello": true}');
  });

  it("parses valid fenced JSON correctly", () => {
    const raw = '```json\n{"result": 42}\n```';
    const parsed = parseLlmJson<{ result: number }>(raw);
    expect(parsed).toEqual({ result: 42 });
  });

  it("throws SyntaxError with preview on broken JSON", () => {
    const raw = "```json\n{ broken json \n```";
    expect(() => parseLlmJson(raw)).toThrow(SyntaxError);
    expect(() => parseLlmJson(raw)).toThrow(/Failed to parse LLM JSON/);
  });

  it("throws SyntaxError on empty string", () => {
    expect(() => parseLlmJson("")).toThrow(SyntaxError);
  });
});
