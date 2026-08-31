#!/usr/bin/env tsx
/**
 * 環境変数の設定確認スクリプト。
 * 必須項目が欠けていれば exit 1、任意項目は未設定でも警告のみ。
 *
 * Usage: pnpm check-env
 */

/* eslint-disable no-console */

const REQUIRED = {
  TURSO_DATABASE_URL: "Turso DB 接続文字列",
  TURSO_AUTH_TOKEN: "Turso DB 認証トークン",
  GOOGLE_API_KEY: "Gemini API キー（AI タイトル/要約生成に使用）",
  // fail-closed のため未設定だと /api/ingest・/api/submit-url が常に 401 を返す。
  // ローカル開発でも設定が必要なので、任意項目ではなく必須項目として扱う。
  CRON_SECRET: "ingest / submit-url API の Bearer 認証トークン（未設定だと常に 401）",
} as const;

const OPTIONAL = {
  ADMIN_BASIC_AUTH_USER: "/admin/* の Basic 認証ユーザー名",
  ADMIN_BASIC_AUTH_PASSWORD: "/admin/* の Basic 認証パスワード",
  INSTAGRAM_OEMBED_TOKEN: "Instagram oEmbed の access_token（無くても公開投稿は取得可）",
  NEXT_PUBLIC_SITE_URL: "公開サイトの絶対 URL（OGP 等に使用）",
} as const;

let hasError = false;

console.log("=== Environment Validation ===\n");

for (const [key, desc] of Object.entries(REQUIRED)) {
  const val = process.env[key];
  if (val) {
    const masked = val.length > 8 ? `${val.slice(0, 4)}...${val.slice(-4)}` : "***";
    console.log(`  OK  ${key} = ${masked}  (${desc})`);
  } else {
    console.log(`  MISSING  ${key}  (${desc})`);
    hasError = true;
  }
}

for (const [key, desc] of Object.entries(OPTIONAL)) {
  const val = process.env[key];
  if (val) {
    const masked = val.length > 8 ? `${val.slice(0, 4)}...${val.slice(-4)}` : "***";
    console.log(`  opt  ${key} = ${masked}  (${desc})`);
  } else {
    console.log(`  opt  ${key} not set  (${desc})`);
  }
}

console.log(
  `\n${hasError ? "Some required env vars are missing" : "All required env vars present"}`,
);

if (hasError) {
  process.exit(1);
}
