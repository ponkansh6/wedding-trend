/**
 * リモート DB（Turso）のテーブル構成を読み取り専用で確認する調査用スクリプト。
 *
 * 用途: wedding-trend と news-watch が同一の Turso DB を共有する方針のため、
 * テーブル名の衝突（特に `posts`）が無いかを、書き込みを一切行わずに確認する。
 *
 * 認証情報は引数で渡した .env ファイルから読む。値は出力しない。
 *   node scripts/inspect-remote-db.mjs <path-to-env-file>
 */
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const envPath = process.argv[2];
if (!envPath) {
  console.error("使い方: node scripts/inspect-remote-db.mjs <path-to-env-file>");
  process.exit(1);
}

const env = {};
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  env[trimmed.slice(0, eq).trim()] = value;
}

const url = env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL が見つかりません");
  process.exit(1);
}
console.log("接続先スキーム:", url.split(":")[0]);

const client = createClient({ url, authToken: env.TURSO_AUTH_TOKEN });

const tables = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
);
const names = tables.rows.map((r) => String(r.name));
console.log("テーブル一覧:", names.length ? names.join(", ") : "(なし)");

for (const name of names) {
  const info = await client.execute(`PRAGMA table_info("${name}")`);
  const cols = info.rows.map((r) => `${r.name}:${r.type}`);
  const count = await client.execute(`SELECT COUNT(*) AS n FROM "${name}"`);
  console.log(`\n[${name}] 行数=${count.rows[0].n}`);
  console.log("  列:", cols.join(", "));
}
