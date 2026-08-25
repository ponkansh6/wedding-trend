/**
 * マイグレーション SQL の「追加専用性」判定ロジックを一箇所に集約する共有モジュール。
 *
 * `scripts/apply-migrations-remote.mjs`（適用時ガード）と
 * `scripts/check-migrations-additive.mjs`（作成時ゲート・pre-push）の両方から
 * import される。判定基準が 2 箇所に複製されると、いずれ乖離して
 * 「安全装置が通っているのに実は非適合な文を通す」状態になりうるため、
 * ロジックの実体はここ 1 箇所だけに置く。
 *
 * 背景: 本番 Turso DB は他プロジェクト（news-watch）と共有されている。
 * CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX 以外の文（ALTER / DROP /
 * DELETE / UPDATE 等）が紛れ込むと、適用時に安全装置が発火して以後の
 * マイグレーション適用が「恒久的に」不可能になる（1 ファイルでも非適合だと
 * apply-migrations-remote.mjs は計画全体を中止する）。この穴は「作った時点」
 * でしか安く塞げない。デプロイしようとするまで気づけないのでは遅すぎる。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** 追加専用として許可する文の形。これ以外は一切実行しない。 */
export const ALLOWED = /^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)\b/i;

/** マイグレーション SQL ディレクトリのデフォルト位置。 */
export const MIGRATIONS_DIR = "src/lib/db/migrations";

/**
 * ディレクトリ内の *.sql を名前順に読み、`--> statement-breakpoint` で分割した
 * 個々の文を { file, statement, label } の配列として返す。
 * ネットワーク・DB アクセスは一切行わない（純粋なファイル読み取りのみ）。
 */
export function loadMigrationStatements(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const entries = [];
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      const label = statement.split("\n")[0].slice(0, 90);
      entries.push({ file, statement, label });
    }
  }
  return entries;
}

/**
 * 追加専用でない文（ALLOWED に一致しない文）だけを抽出する。
 * 違反がなければ空配列を返す。
 */
export function findNonAdditiveStatements(entries) {
  return entries.filter(({ statement }) => !ALLOWED.test(statement));
}

/**
 * CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX 文から、作成しようとしている
 * オブジェクト名を抽出する。バッククォート・ダブルクォート・角括弧・無囲みの
 * いずれの識別子表記にも対応する。抽出できない場合は null を返す。
 *
 * 用途: 適用前に、本番 DB（他プロジェクトと共有）に既に同名のテーブル/インデックスが
 * 存在しないかを突き合わせるための入力。
 */
export function extractCreatedName(statement) {
  const match = statement.match(
    /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\S+))/i,
  );
  if (!match) return null;
  const type = match[1].toUpperCase() === "TABLE" ? "table" : "index";
  const name = match[3] ?? match[4] ?? match[5] ?? match[6];
  return name ? { type, name } : null;
}
