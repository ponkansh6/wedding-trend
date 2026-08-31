/**
 * マイグレーション SQL の「安全に適用してよい文か」を判定するロジックを
 * 一箇所に集約する共有モジュール。
 *
 * `scripts/apply-migrations-remote.mjs`（適用時ガード）と
 * `scripts/check-migrations-additive.mjs`（作成時ゲート・pre-push）の両方から
 * import される。判定基準が 2 箇所に複製されると、いずれ乖離して
 * 「安全装置が通っているのに実は非適合な文を通す」状態になりうるため、
 * ロジックの実体はここ 1 箇所だけに置く。
 *
 * 背景: 本番 Turso DB は他プロジェクト（news-watch）と共有されている。
 * 守るべき不変条件は「文の種類」ではなく「所有権」である —
 * news-watch のテーブルを一切変更・作成・衝突させないこと。
 * 「CREATE 系だけを許可する」という以前のルールは、この不変条件を
 * 「文の種類」という代理変数で近似していたに過ぎず、以下 2 点で
 * 同時に広すぎ、かつ狭すぎた:
 *
 *   - 広すぎた: `CREATE TABLE`/`CREATE INDEX` は文の種類さえ合っていれば
 *     news-watch のテーブル名と衝突していても通ってしまっていた
 *     （所有権を一切見ていなかったため）。
 *   - 狭すぎた: 自プロジェクトが所有するテーブルへの
 *     `ALTER TABLE ... ADD COLUMN` まで一律禁止していたため、
 *     1 列足すだけの変更が副テーブルの新設を強いていた。
 *
 * このモジュールは「所有テーブルへの ADD COLUMN」を安全な形に限定して
 * 解禁し、その代わりに全ての CREATE/ALTER 文で所有権を検査する。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** マイグレーション SQL ディレクトリのデフォルト位置。 */
export const MIGRATIONS_DIR = "src/lib/db/migrations";

/** スキーマ定義ファイルのデフォルト位置（所有テーブル集合の導出元）。 */
export const SCHEMA_FILE = "src/lib/db/schema.ts";

/**
 * news-watch（本番 DB を共有する他プロジェクト）が所有することが実測で
 * 判明しているテーブルの denylist。
 *
 * 「自分のスキーマに書けば所有していることになる」という循環を断つために
 * 必要。`schema.ts` から導出した所有集合とこの denylist が交差した場合は、
 * schema.ts の書き方が誤っているかスキーマ導出が壊れているかのどちらかで
 * あり、安全側に倒して即座に失敗させる（`assertNoDenylistOverlap` 参照）。
 *
 * 短く増えない想定のリストなので手書きで保守可能（動的テーブルの他プロジェクト
 * 側は対象外 — その場合は接続先 DB の共有自体を見直すべき事態）。
 */
export const EXTERNAL_DENYLIST = new Set([
  "answer_logs",
  "articles",
  "favorites",
  "hatena_feeds",
  "knowledge",
  "not_for_me",
  "preference_profiles",
  "questions",
]);

/** drizzle 自身が管理するテーブル。所有権検査の対象外として扱う。 */
const DRIZZLE_MANAGED_TABLES = new Set(["__drizzle_migrations"]);

/**
 * schema.ts からはもう導出できない、自プロジェクトが過去に作成した孤児テーブル。
 * `post_usefulness` は `post_usefulness_criteria` に置き換えられ、schema.ts の
 * 参照をやめた時点で孤児化した（共有 DB のため DROP せず放置する方針。
 * `src/lib/db/schema.ts` の `postUsefulnessCriteria` コメント参照）。
 *
 * これは「新しく増える」リストではなく、過去の既知の 1 件を記録するための
 * ものであり、新規テーブルの所有権主張には使わない（新規は必ず schema.ts に
 * 定義してから作る）。既存 11 本のマイグレーションの回帰を通すためだけに存在する。
 */
const LEGACY_ORPHANED_OWNED_TABLES = new Set(["post_usefulness"]);

/**
 * `src/lib/db/schema.ts` を静的に読み、`sqliteTable("...", ...)` /
 * `sqliteTable('...', ...)` の第 1 引数（テーブル名）を抽出して
 * 所有テーブル集合を返す。手書きの所有リストを持たないことで、
 * スキーマとガードの乖離（新テーブル追加時にガード側の更新を忘れる等）
 * を構造的に防ぐ。
 *
 * `src/` は読み取りのみ。このモジュールはスキーマファイルを一切変更しない。
 */
export function loadOwnedTables(schemaFile = SCHEMA_FILE) {
  const source = readFileSync(schemaFile, "utf-8");
  const owned = new Set();
  const re = /sqliteTable\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    owned.add(match[1]);
  }
  for (const legacy of LEGACY_ORPHANED_OWNED_TABLES) owned.add(legacy);
  assertNoDenylistOverlap(owned);
  return owned;
}

/**
 * 導出した所有集合が外部 denylist と交差していないことを確認する。
 * 交差はスキーマ導出ロジックの誤り（またはこのファイル自身の denylist の
 * 誤り）を意味するため、判定を続行せず即座に例外を投げる。
 */
function assertNoDenylistOverlap(owned) {
  const overlap = [...owned].filter((name) => EXTERNAL_DENYLIST.has(name));
  if (overlap.length > 0) {
    throw new Error(
      `所有テーブル導出と外部 denylist が交差しています（${overlap.join(", ")}）。` +
        "schema.ts の書き方かこのファイルの EXTERNAL_DENYLIST を確認してください。",
    );
  }
}

/** バッククォート・ダブルクォート・角括弧・無囲みの識別子いずれにもマッチする断片。 */
const IDENT = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_]*)';

function unquoteIdent(raw) {
  if (!raw) return raw;
  if (raw.startsWith("`") && raw.endsWith("`")) return raw.slice(1, -1);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
}

/**
 * SQL 文字列を、文字列リテラル（`'...'`、`''` エスケープ対応）・
 * 引用識別子（`` `...` ``/`"..."`/`[...]`）・`BEGIN ... END`（トリガー本体）
 * の中身を壊さずにトップレベルの `;` で分割する。
 *
 * `--> statement-breakpoint` マーカーはあってもなくても結果に影響しない
 * （マーカー自体は単に読み飛ばす）。これにより「マーカーが無い複数文
 * ファイルが 1 文として扱われ、前方一致で通過する」という穴を構造的に塞ぐ:
 * 分割そのものが正しくなるので、後段の判定は常に「本当に 1 つの文」を
 * 受け取る。
 *
 * 素朴な `String.split(";")` を使わない理由: 文字列リテラル内のセミコロン
 * （例: `CREATE TABLE t (name text DEFAULT 'a;b')`）や、
 * `CREATE TRIGGER ... BEGIN ... END;` のようにトリガー本体の中に複数の
 * `;` を含む構文で誤分割してしまうため。
 */
export function splitStatements(sql) {
  const withoutMarkers = sql.replace(/-->\s*statement-breakpoint/gi, "\n");
  const statements = [];
  let buf = "";
  let beginDepth = 0;
  const n = withoutMarkers.length;
  let i = 0;

  while (i < n) {
    const c = withoutMarkers[i];

    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (withoutMarkers[j] === "'") {
          if (withoutMarkers[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      buf += withoutMarkers.slice(i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n && withoutMarkers[j] !== quote) j += 1;
      j = Math.min(j + 1, n);
      buf += withoutMarkers.slice(i, j);
      i = j;
      continue;
    }

    if (c === "[") {
      let j = withoutMarkers.indexOf("]", i);
      j = j === -1 ? n : j + 1;
      buf += withoutMarkers.slice(i, j);
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(withoutMarkers[j])) j += 1;
      const word = withoutMarkers.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === "BEGIN") beginDepth += 1;
      else if (upper === "END") beginDepth = Math.max(0, beginDepth - 1);
      buf += word;
      i = j;
      continue;
    }

    if (c === ";" && beginDepth === 0) {
      statements.push(buf);
      buf = "";
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }
  if (buf.trim()) statements.push(buf);

  return statements.map((s) => s.trim()).filter(Boolean);
}

/**
 * ディレクトリ内の *.sql を名前順に読み、`splitStatements` で分割した
 * 個々の文を { file, statement, label } の配列として返す。
 * ネットワーク・DB アクセスは一切行わない（純粋なファイル読み取りのみ）。
 *
 * @param {string} [dir]
 * @returns {MigrationEntry[]}
 */
export function loadMigrationStatements(dir = MIGRATIONS_DIR) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const entries = [];
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf-8");
    for (const statement of splitStatements(sql)) {
      const label = statement.split("\n")[0].slice(0, 90);
      entries.push({ file, statement, label });
    }
  }
  return entries;
}

const CREATE_TABLE_RE = new RegExp(
  `^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s*\\([\\s\\S]*\\)\\s*;?$`,
  "i",
);

const CREATE_INDEX_RE = new RegExp(
  `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}\\s+ON\\s+(${IDENT})\\s*\\([\\s\\S]*\\)\\s*;?$`,
  "i",
);

/** リテラル値: 文字列 / 数値（負可）/ NULL / TRUE / FALSE。関数呼び出し等の非定数は含まない。 */
const LITERAL = "(?:'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?|NULL|TRUE|FALSE)";

/**
 * `ALTER TABLE <table> ADD COLUMN <name> <type>` に、任意で
 *   - `DEFAULT <literal>`
 *   - `NOT NULL DEFAULT <literal>`
 *   - `REFERENCES <table>(<column>)`
 * のいずれか 1 つが付く形にのみマッチする。
 *
 * 意図的に許可しないもの（マッチさせない）:
 *   - `UNIQUE` / `PRIMARY KEY` を伴う列追加（SQLite でテーブル再構築を要する）
 *   - 非定数デフォルト（関数呼び出し等）
 *   - `DROP COLUMN` / `RENAME` / その他すべての `ALTER` 形
 *
 * 方針: SQLite では新規列は原則 nullable で追加し、NOT NULL 相当の
 * 不変条件はアプリ層（Zod / リポジトリ）で担保する。テーブル再構築が
 * 必要な変更は、このゲートで自動化せず人手の out-of-band 手順に落とす
 * （詳細は docs/git-hooks.md）。
 */
const ALTER_ADD_COLUMN_RE = new RegExp(
  `^ALTER\\s+TABLE\\s+(${IDENT})\\s+ADD\\s+COLUMN\\s+${IDENT}\\s+[A-Za-z]+(?:\\(\\d+\\))?` +
    `(?:\\s+(?:NOT\\s+NULL\\s+DEFAULT\\s+${LITERAL}|DEFAULT\\s+${LITERAL}|REFERENCES\\s+${IDENT}\\s*\\(\\s*${IDENT}\\s*\\)))?` +
    `\\s*;?$`,
  "i",
);

/**
 * @typedef {{
 *   ok: boolean,
 *   reason?: string,
 *   table?: string,
 *   kind?: "create-table" | "create-index" | "alter-add-column",
 * }} Verdict
 */

/**
 * 1 つの文を判定する。
 *
 * ok: false の場合、reason に人間向けの理由文字列を入れる。
 *
 * @param {string} statement
 * @param {Set<string>} ownedTables
 * @returns {Verdict}
 */
export function classifyStatement(statement, ownedTables) {
  const createTable = statement.match(CREATE_TABLE_RE);
  if (createTable) {
    const table = unquoteIdent(createTable[1]);
    if (EXTERNAL_DENYLIST.has(table)) {
      return {
        ok: false,
        reason: `外部プロジェクト所有のテーブル "${table}" への CREATE TABLE は禁止です`,
      };
    }
    if (!ownedTables.has(table) && !DRIZZLE_MANAGED_TABLES.has(table)) {
      return {
        ok: false,
        reason: `テーブル "${table}" は schema.ts に存在しません（所有権が確認できません）`,
      };
    }
    return { ok: true, table, kind: "create-table" };
  }

  const createIndex = statement.match(CREATE_INDEX_RE);
  if (createIndex) {
    const table = unquoteIdent(createIndex[1]);
    if (EXTERNAL_DENYLIST.has(table)) {
      return {
        ok: false,
        reason: `外部プロジェクト所有のテーブル "${table}" への CREATE INDEX は禁止です`,
      };
    }
    if (!ownedTables.has(table) && !DRIZZLE_MANAGED_TABLES.has(table)) {
      return {
        ok: false,
        reason: `テーブル "${table}" は schema.ts に存在しません（所有権が確認できません）`,
      };
    }
    return { ok: true, table, kind: "create-index" };
  }

  const alterAddColumn = statement.match(ALTER_ADD_COLUMN_RE);
  if (alterAddColumn) {
    const table = unquoteIdent(alterAddColumn[1]);
    if (EXTERNAL_DENYLIST.has(table)) {
      return {
        ok: false,
        reason: `外部プロジェクト所有のテーブル "${table}" への ALTER TABLE は禁止です`,
      };
    }
    if (!ownedTables.has(table)) {
      return {
        ok: false,
        reason: `テーブル "${table}" は schema.ts に存在しません（所有テーブルへの ADD COLUMN のみ許可されます）`,
      };
    }
    return { ok: true, table, kind: "alter-add-column" };
  }

  if (/^ALTER\s+TABLE\b/i.test(statement)) {
    return {
      ok: false,
      reason:
        "許可される ALTER TABLE は所有テーブルへの単純な ADD COLUMN のみです（UNIQUE/PRIMARY KEY/DROP/RENAME 等は不可）",
    };
  }

  return {
    ok: false,
    reason:
      "許可される文は CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX / 所有テーブルへの ALTER TABLE ... ADD COLUMN のみです",
  };
}

/**
 * @typedef {{ file: string, statement: string, label: string }} MigrationEntry
 * @typedef {MigrationEntry & { verdict: Verdict }} NonAdditiveEntry
 */

/**
 * 安全に適用してよい文でない（`classifyStatement` が ok:false を返す）
 * ものだけを抽出する。違反がなければ空配列を返す。
 *
 * @param {MigrationEntry[]} entries
 * @param {Set<string>} [ownedTables]
 * @returns {NonAdditiveEntry[]}
 */
export function findNonAdditiveStatements(entries, ownedTables = loadOwnedTables()) {
  return entries
    .map((entry) => ({ ...entry, verdict: classifyStatement(entry.statement, ownedTables) }))
    .filter((entry) => !entry.verdict.ok);
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
