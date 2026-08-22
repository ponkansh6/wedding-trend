import { sql } from "drizzle-orm";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { db } from "@/lib/db";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/lib/db/migrations");

/**
 * `setupTestDb()` が DROP する対象テーブル。新しいテーブルを追加した場合は
 * ここにも追記すること（マイグレーション SQL のファイル名は決め打ちしない
 * ため、テーブル一覧だけは手動で保守する）。
 */
const KNOWN_TABLES = ["posts", "config"];

/**
 * `src/lib/db/migrations/*.sql` を採番順（ファイル名の辞書順 = drizzle-kit の
 * 生成順）に読み込み、`--> statement-breakpoint` で分割した実行可能な SQL 文
 * の配列にする。
 */
function loadMigrationStatements(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return files.flatMap((file) =>
    readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean),
  );
}

/**
 * テスト用 DB（`:memory:` SQLite）をクリーンなマイグレーション済み状態にする。
 * 既知のテーブルを DROP してから、`src/lib/db/migrations/` 配下の全 SQL を
 * 順番に流し直す。マイグレーションファイルが増えてもこの関数の変更は不要。
 */
export async function setupTestDb(): Promise<void> {
  for (const table of KNOWN_TABLES) {
    try {
      await db.run(sql.raw(`DROP TABLE IF EXISTS ${table};`));
    } catch {
      // テーブルが元々存在しない場合は無視する。
    }
  }
  for (const statement of loadMigrationStatements()) {
    await db.run(sql.raw(statement));
  }
}
