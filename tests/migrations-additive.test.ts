import { describe, expect, it } from "vitest";
import {
  classifyStatement,
  EXTERNAL_DENYLIST,
  findNonAdditiveStatements,
  loadMigrationStatements,
  loadOwnedTables,
  splitStatements,
} from "../scripts/migrations-additive.mjs";

/**
 * `scripts/migrations-additive.mjs` の破壊フィクスチャによる検証テスト。
 *
 * AGENTS.md 「安全に関するルール」/検証ルール:
 * 「新しく検証機構を追加した場合は、意図的に壊して落ちることを確認する
 *  まで完了と見なさない」を満たすためのテスト。
 *
 * ここで拒否されることを固定しているケースが将来また通るようになったら、
 * それは安全装置の後退であり、意味のない検証機構に戻ったということ。
 */

const ownedTables = loadOwnedTables();

function isOk(sql: string) {
  return splitStatements(sql).every((s) => classifyStatement(s, ownedTables).ok);
}

describe("loadOwnedTables", () => {
  it("schema.ts から所有テーブル集合を導出し、denylist と交差しない", () => {
    expect(ownedTables.size).toBeGreaterThan(5);
    expect(ownedTables.has("posts")).toBe(true);
    expect(ownedTables.has("config")).toBe(true);
    for (const external of EXTERNAL_DENYLIST) {
      expect(ownedTables.has(external)).toBe(false);
    }
  });
});

describe("splitStatements", () => {
  it("statement-breakpoint マーカーで分割する（従来動作の回帰防止）", () => {
    const sql =
      "CREATE TABLE a (id integer);--> statement-breakpoint\nCREATE TABLE b (id integer);";
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it("マーカーが無い複数文ファイルも正しく分割する（穴 B の再現・修正確認）", () => {
    const sql = "CREATE TABLE x (id integer); DROP TABLE articles;";
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE x/);
    expect(statements[1]).toMatch(/^DROP TABLE articles/);
  });

  it("文字列リテラル内のセミコロンで誤分割しない", () => {
    const sql = "CREATE TABLE t (name text DEFAULT 'a;b;c');";
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("'a;b;c'");
  });

  it("''エスケープを含む文字列リテラルでも正しく終端を検出する", () => {
    const sql = "CREATE TABLE t (name text DEFAULT 'it''s; fine');";
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(1);
  });

  it("CREATE TRIGGER の BEGIN...END 内のセミコロンで誤分割しない", () => {
    const sql =
      "CREATE TRIGGER trg AFTER INSERT ON posts BEGIN UPDATE posts SET x = 1; UPDATE posts SET y = 2; END; CREATE TABLE t (id integer);";
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TRIGGER/);
    expect(statements[1]).toMatch(/^CREATE TABLE t/);
  });
});

describe("既存マイグレーションの回帰防止", () => {
  it("既存 11 本のマイグレーションはすべて通過する", () => {
    const entries = loadMigrationStatements();
    expect(entries.length).toBeGreaterThan(0);
    const violations = findNonAdditiveStatements(entries, ownedTables);
    if (violations.length > 0) {
      const detail = violations
        .map((v) => `${v.file}: ${v.verdict.reason}\n  ${v.statement.slice(0, 200)}`)
        .join("\n");
      throw new Error(`既存マイグレーションが拒否されました（破壊的変更）:\n${detail}`);
    }
  });
});

describe("拒否されるべきケース（破壊フィクスチャ）", () => {
  it("穴 B: マーカー無し複数文で外部テーブルへの DROP が混入する", () => {
    expect(isOk("CREATE TABLE probe_x (id integer); DROP TABLE articles;")).toBe(false);
  });

  it("外部テーブルへの ALTER TABLE ADD COLUMN", () => {
    expect(isOk("ALTER TABLE articles ADD COLUMN foo text;")).toBe(false);
  });

  it("外部テーブル名との CREATE TABLE", () => {
    expect(isOk("CREATE TABLE articles (id integer);")).toBe(false);
  });

  it("外部テーブルへの CREATE INDEX", () => {
    expect(isOk("CREATE INDEX idx_articles_id ON articles (id);")).toBe(false);
  });

  it("ADD COLUMN ... UNIQUE は拒否", () => {
    expect(isOk("ALTER TABLE posts ADD COLUMN foo text UNIQUE;")).toBe(false);
  });

  it("ADD COLUMN ... PRIMARY KEY は拒否", () => {
    expect(isOk("ALTER TABLE posts ADD COLUMN foo text PRIMARY KEY;")).toBe(false);
  });

  it("非定数デフォルト（関数呼び出し）を伴う ADD COLUMN は拒否", () => {
    expect(isOk("ALTER TABLE posts ADD COLUMN foo text DEFAULT (datetime('now'));")).toBe(false);
  });

  it("DROP COLUMN は拒否", () => {
    expect(isOk("ALTER TABLE posts DROP COLUMN url;")).toBe(false);
  });

  it("RENAME TO は拒否", () => {
    expect(isOk("ALTER TABLE posts RENAME TO posts_old;")).toBe(false);
  });

  it("drizzle のテーブル再構築 4 文列は拒否される", () => {
    const sql = [
      "CREATE TABLE `__new_posts` (`id` integer PRIMARY KEY);",
      "INSERT INTO `__new_posts` SELECT `id` FROM `posts`;",
      "DROP TABLE `posts`;",
      "ALTER TABLE `__new_posts` RENAME TO `posts`;",
    ].join(" ");
    expect(isOk(sql)).toBe(false);
  });

  it("スキーマに存在しない未知のテーブルへの CREATE TABLE は拒否される", () => {
    expect(isOk("CREATE TABLE totally_unknown_table (id integer);")).toBe(false);
  });

  it("文字列リテラル内にセミコロンを含む CREATE TABLE でも分割器が壊れず、外部テーブルへの DROP を検出する", () => {
    const sql = "CREATE TABLE t (name text DEFAULT 'a;b'); DROP TABLE articles;";
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(isOk(sql)).toBe(false);
  });
});

describe("許可されるべきケース", () => {
  it("ALTER TABLE posts ADD COLUMN hash_kind text; は許可される", () => {
    expect(isOk("ALTER TABLE posts ADD COLUMN hash_kind text;")).toBe(true);
  });

  it("ALTER TABLE posts ADD COLUMN foo text DEFAULT 'bar'; は許可される", () => {
    expect(isOk("ALTER TABLE posts ADD COLUMN foo text DEFAULT 'bar';")).toBe(true);
  });

  it("NOT NULL DEFAULT <定数> を伴う ADD COLUMN は許可される", () => {
    expect(isOk("ALTER TABLE posts ADD COLUMN foo integer NOT NULL DEFAULT 0;")).toBe(true);
  });

  it("REFERENCES を伴う ADD COLUMN は許可される", () => {
    expect(
      isOk("ALTER TABLE post_removals ADD COLUMN post_id_2 integer REFERENCES posts(id);"),
    ).toBe(true);
  });

  it("所有テーブルへの CREATE INDEX は許可される", () => {
    expect(isOk("CREATE INDEX idx_posts_status ON posts (status);")).toBe(true);
  });
});
