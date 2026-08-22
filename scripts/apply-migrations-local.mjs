/**
 * ローカル開発用 SQLite（file: スキーム）にマイグレーション SQL を順に適用する。
 *
 * `drizzle-kit push` を使わない理由: push はスキーマ定義に存在しないテーブル・
 * カラムを削除対象として扱うため、DB を他プロジェクトと共有している場合に
 * 相手のデータを破壊しうる。ここでは生成済みのマイグレーション SQL を
 * 追加適用するだけに留める（既存テーブルは "already exists" で読み飛ばす）。
 *
 * 安全装置として、リモート（libsql/https/wss）を指している場合は実行を中止する。
 */
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

// .env.local を最小限パースする（dotenv 依存を増やさない）
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

const url = process.env.TURSO_DATABASE_URL ?? "file:./local.db";
const scheme = url.split(":")[0];
if (["libsql", "https", "wss", "http", "ws"].includes(scheme)) {
  console.error(
    `[apply-migrations-local] リモート DB (${scheme}:) を指しています。` +
      "このスクリプトはローカル file: 専用です。中止しました。",
  );
  process.exit(1);
}
console.log("[apply-migrations-local] 接続先スキーム:", scheme);

const client = createClient({ url });
const dir = "src/lib/db/migrations";
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  const sql = readFileSync(path.join(dir, file), "utf-8");
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  let applied = 0;
  for (const statement of statements) {
    try {
      await client.execute(statement);
      applied += 1;
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/already exists/i.test(message)) continue;
      throw err;
    }
  }
  console.log(`[apply-migrations-local] ${file}: ${applied}/${statements.length} 文を適用`);
}

const tables = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
);
console.log("[apply-migrations-local] テーブル:", tables.rows.map((r) => r.name).join(", "));
