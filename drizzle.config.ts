import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit は `.env.local` を自動で読み込まないため、ここで明示的に読む。
 * Node 20.12+ 組み込みの loadEnvFile を使い、依存を増やさない。
 */
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local が無い環境（CI 等）では環境変数がそのまま使われる。
}

const url = process.env.TURSO_DATABASE_URL ?? "file:./local.db";
const authToken = process.env.TURSO_AUTH_TOKEN;

/**
 * ローカル開発は単一ファイルの SQLite（`file:` スキーム）で完結させ、Turso の
 * 認証情報を不要にする。turso ダイアレクトは authToken を必須とするため、
 * リモート接続時のみそちらを使う。生成される SQL は同一。
 */
const isLocalFile = url.startsWith("file:");

export default defineConfig(
  isLocalFile
    ? {
        schema: "./src/lib/db/schema.ts",
        out: "./src/lib/db/migrations",
        dialect: "sqlite",
        dbCredentials: { url },
      }
    : {
        schema: "./src/lib/db/schema.ts",
        out: "./src/lib/db/migrations",
        dialect: "turso",
        dbCredentials: { url, authToken: authToken! },
      },
);
