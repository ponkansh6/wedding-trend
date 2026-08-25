/**
 * マイグレーションの「追加専用性」を **作った時点で** 検出するゲート。
 *
 * `src/lib/db/migrations/*.sql` を静的に検査し、CREATE TABLE / CREATE INDEX /
 * CREATE UNIQUE INDEX 以外の文が 1 つでもあれば非ゼロ終了する。
 *
 * 判定ロジックは `scripts/migrations-additive.mjs` を
 * `scripts/apply-migrations-remote.mjs` と共有している（詳細はそちらのコメント参照）。
 *
 * ネットワーク・DB には一切アクセスしない純粋な静的検査であるため、
 * pre-push のブロックチェックおよび CI ゲートに組み込んでよい。
 *
 * 使い方:
 *   node scripts/check-migrations-additive.mjs
 */
import { loadMigrationStatements, findNonAdditiveStatements } from "./migrations-additive.mjs";

const entries = loadMigrationStatements();
const violations = findNonAdditiveStatements(entries);

if (violations.length > 0) {
  console.error(
    `\n❌ 追加専用ではない文を検出しました（${violations.length} 件）。` +
      "リモート適用時にこれ以降のマイグレーションが恒久的に適用不能になります。\n",
  );
  for (const { file, statement } of violations) {
    console.error(`   ファイル: ${file}\n   文: ${statement.slice(0, 200)}\n`);
  }
  console.error(
    "   → 許可される文は CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX のみです。\n" +
      "   本番 Turso DB は他プロジェクト（news-watch）と共有されているため、\n" +
      "   drizzle-kit push や ALTER/DROP 系の文は使えません。\n",
  );
  process.exit(1);
}

console.log(`[check-migrations-additive] OK（${entries.length} 文、すべて追加専用）`);
