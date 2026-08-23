#!/usr/bin/env tsx
/**
 * 手動エバーグリーン URL 投入スクリプト。
 *
 * 使い方:
 *   pnpm exec tsx scripts/submit-evergreen.mjs [--file <path>] [url...]
 */
import { existsSync, readFileSync } from "node:fs";

// .env.local の簡易パーサ
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const args = process.argv.slice(2);
const urls = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--file" && args[i + 1]) {
    const filePath = args[i + 1];
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        urls.push(trimmed);
      }
    } else {
      console.error(`指定されたファイルが見つかりません: ${filePath}`);
      process.exit(1);
    }
    i++;
  } else if (!arg.startsWith("--")) {
    urls.push(arg);
  }
}

if (urls.length === 0) {
  console.log("使い方: pnpm exec tsx scripts/submit-evergreen.mjs [--file <path>] [url...]");
  process.exit(1);
}

const { curateEvergreenUrl } = await import("../src/lib/pipeline/evergreen.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let hasError = false;
console.log(`エバーグリーン記事の処理を開始します: ${urls.length} 件`);

for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  process.stdout.write(`[${i + 1}/${urls.length}] ${url} ... `);
  try {
    const outcome = await curateEvergreenUrl(url);
    if (outcome.ok) {
      console.log(`OK (reason: ${outcome.reason ?? "none"}, title: ${outcome.card?.aiTitle})`);
    } else {
      console.log(`FAILED (reason: ${outcome.reason})`);
      hasError = true;
    }
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    hasError = true;
  }

  if (i < urls.length - 1) {
    await sleep(4000);
  }
}

if (hasError) {
  process.exit(1);
}
