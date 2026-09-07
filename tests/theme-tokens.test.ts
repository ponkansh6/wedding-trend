import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

/** Extracts a simple selector block without allowing declarations from a later rule to leak in. */
function selectorDeclarations(source: string, selector: string): Map<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector} token block in globals.css`);

  const bodyStart = source.indexOf("{", start) + 1;
  let depth = 1;
  let bodyEnd = bodyStart;
  for (; bodyEnd < source.length && depth > 0; bodyEnd += 1) {
    if (source[bodyEnd] === "{") depth += 1;
    if (source[bodyEnd] === "}") depth -= 1;
  }
  if (depth !== 0) throw new Error(`Unclosed ${selector} token block in globals.css`);

  const declarations = new Map<string, string>();
  const body = source.slice(bodyStart, bodyEnd - 1).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const declaration of body.split(";")) {
    const match = declaration.match(/^\s*(--[\w-]+)\s*:\s*(.*?)\s*$/);
    if (match) declarations.set(match[1], match[2]);
  }
  return declarations;
}

function requiredToken(tokens: Map<string, string>, token: string): string {
  const value = tokens.get(token);
  if (!value) throw new Error(`Missing required token ${token}`);
  return value;
}

type ParsedColor = { hex: string; alpha: number };

/** Parses supported CSS color syntax before contrast and pure-black/white checks. */
function parseColor(value: string): ParsedColor {
  const color = value.trim().toLowerCase();
  const shortHex = color.match(/^#([0-9a-f]{3})$/);
  if (shortHex) {
    return { hex: `#${[...shortHex[1]].map((part) => part + part).join("")}`, alpha: 1 };
  }
  if (/^#[0-9a-f]{6}$/.test(color)) return { hex: color, alpha: 1 };

  const rgb = color.match(
    /^rgba?\(\s*(\d+)\s*(?:,|\s)\s*(\d+)\s*(?:,|\s)\s*(\d+)(?:\s*(?:,|\/)\s*(\d*\.?\d+%?))?\s*\)$/,
  );
  if (rgb) {
    const channels = rgb.slice(1, 4).map((part) => Number.parseInt(part, 10));
    const alphaValue = rgb[4];
    const alpha = alphaValue
      ? alphaValue.endsWith("%")
        ? Number.parseFloat(alphaValue) / 100
        : Number.parseFloat(alphaValue)
      : 1;
    if (channels.some((channel) => channel > 255) || alpha < 0 || alpha > 1) {
      throw new Error(`Invalid rgb color: ${value}`);
    }
    return {
      hex: `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
      alpha,
    };
  }
  throw new Error(`Expected a hex, rgb, or rgba color, received: ${value}`);
}

function normalizeColor(value: string): string {
  return parseColor(value).hex;
}

function relativeLuminance(color: string): number {
  const hex = normalizeColor(color).slice(1);
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

const light = selectorDeclarations(css, ":root");
const dark = selectorDeclarations(css, ".dark");

const lightContract = {
  "--background": "#faf6f0",
  "--surface": "#ffffff",
  "--surface-hover": "#f3ece2",
  "--foreground": "#221d19",
  "--muted-foreground": "#6b625a",
  "--muted-foreground-subtle": "#726960",
  "--border": "#e7dfd3",
  "--ring": "#b33a24",
  "--accent": "#b33a24",
  "--on-accent": "#fff7f2",
  "--skeleton": "#ece3d6",
  "--topic-chip": "#f4ede2",
  "--topic-border": "#ece2d3",
  "--classic": "#2c3b5c",
  "--ai-chip": "#ede8fb",
  "--on-ai-chip": "#4b3f80",
} as const;

const mildNightTarget = {
  "--background": "#2c2926",
  "--surface": "#393532",
  "--surface-hover": "#46403b",
  "--foreground": "#f7f0e8",
  "--muted-foreground": "#d4c9be",
  "--muted-foreground-subtle": "#c5b9ae",
  "--border": "#5b544e",
  "--ring": "#f0ad96",
  "--accent": "#e08a72",
  "--on-accent": "#2b211d",
  "--skeleton": "#4b4540",
  "--topic-chip": "#473a30",
  "--topic-border": "#665649",
  "--classic": "#b8c7ee",
  "--ai-chip": "#40354b",
  "--on-ai-chip": "#ead5ff",
} as const;

describe("Plan 27 mild night paper theme token contract (TDD target)", () => {
  it("keeps the established light paper-and-vermilion token values unchanged", () => {
    for (const [token, expected] of Object.entries(lightContract)) {
      expect(normalizeColor(requiredToken(light, token)), token).toBe(expected);
    }
  });

  it("sets every core dark token to the mild night paper TDD target", () => {
    for (const [token, expected] of Object.entries(mildNightTarget)) {
      expect(normalizeColor(requiredToken(dark, token)), token).toBe(expected);
    }
  });

  it("does not use pure black or white for dark color tokens", () => {
    for (const [token, value] of dark) {
      if (
        !token.includes("color") &&
        !/(background|surface|foreground|border|ring|accent|classic|chip|skeleton)/.test(token)
      )
        continue;
      const normalized = parseColor(value);
      expect(
        normalized.alpha > 0 && ["#000000", "#ffffff"].includes(normalized.hex),
        `${token} must not use pure black or white RGB, including a translucent shadow; use a warm-tinted dark shadow instead`,
      ).toBe(false);
    }
  });

  it("does not use pure black or high-opacity shadows for dark shadow tokens", () => {
    for (const token of ["--shadow-card", "--topic-chip-shadow"] as const) {
      const value = requiredToken(dark, token);
      expect(value).not.toMatch(/0,\s*0,\s*0|0,0,0|#000/);
      expect(value).not.toMatch(/rgba\([^)]*,\s*0\.(4|5|6|7|8|9)/);
    }
  });

  it("meets the Plan 27 contrast and surface-hierarchy targets", () => {
    const color = (token: keyof typeof mildNightTarget) => requiredToken(dark, token);

    for (const [label, first, second, minimum] of [
      ["foreground/background", color("--foreground"), color("--background"), 4.5],
      ["foreground/surface", color("--foreground"), color("--surface"), 4.5],
      ["muted/background", color("--muted-foreground"), color("--background"), 4.5],
      ["subtle/background", color("--muted-foreground-subtle"), color("--background"), 4.5],
      ["on-accent/accent", color("--on-accent"), color("--accent"), 4.5],
      ["accent/surface", color("--accent"), color("--surface"), 3],
      ["ring/background", color("--ring"), color("--background"), 3],
    ] as const) {
      expect(contrast(first, second), label).toBeGreaterThanOrEqual(minimum);
    }

    expect(relativeLuminance(color("--background"))).toBeLessThan(
      relativeLuminance(color("--surface")),
    );
    expect(relativeLuminance(color("--surface"))).toBeLessThan(
      relativeLuminance(color("--surface-hover")),
    );
    expect(normalizeColor(color("--background"))).not.toBe(
      normalizeColor(requiredToken(light, "--background")),
    );
  });
});
