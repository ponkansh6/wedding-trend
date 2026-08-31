/**
 * マイグレーションが「所有権を守っているか」を **作った時点で** 検出するゲート。
 *
 * `src/lib/db/migrations/*.sql` を静的に検査し、news-watch（denylist）の
 * テーブルに触れる文、schema.ts に存在しないテーブルへの CREATE/ALTER、
 * および所有テーブルへの安全でない ALTER TABLE 形が 1 つでもあれば
 * 非ゼロ終了する。
 *
 * 判定ロジックは `scripts/migrations-additive.mjs` を
 * `scripts/apply-migrations-remote.mjs` と共有している（詳細はそちらのコメント参照）。
 *
 * ネットワーク・DB には一切アクセスしない純粋な静的検査であるため、
 * pre-push のブロックチェックおよび CI ゲートに組み込んでよい
 * （schema.ts の読み取りのみ行う）。
 *
 * 使い方:
 *   node scripts/check-migrations-additive.mjs
 */
import { loadMigrationStatements, findNonAdditiveStatements } from "./migrations-additive.mjs";

const entries = loadMigrationStatements();
const violations = findNonAdditiveStatements(entries);

if (violations.length > 0) {
  console.error(
    `\n❌ 所有権を守らない文を検出しました（${violations.length} 件）。` +
      "リモート適用時にこれ以降のマイグレーションが恒久的に適用不能になります。\n",
  );
  for (const { file, statement, verdict } of violations) {
    console.error(
      `   ファイル: ${file}\n   理由: ${verdict.reason}\n   文: ${statement.slice(0, 200)}\n`,
    );
  }
  console.error(
    "   → 許可される文は CREATE TABLE / CREATE INDEX / CREATE UNIQUE INDEX（自プロジェクト所有テーブルのみ）\n" +
      "     と、所有テーブルへの単純な ALTER TABLE ... ADD COLUMN のみです。\n" +
      "   本番 Turso DB は他プロジェクト（news-watch）と共有されているため、\n" +
      "   drizzle-kit push や news-watch テーブルへの変更は使えません。\n",
  );
  process.exit(1);
}

console.log(`[check-migrations-additive] OK（${entries.length} 文、すべて所有権を満たす）`);
