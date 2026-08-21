#!/bin/sh
# Check that the production Turso DB schema matches schema.ts.
# Read-only — does not modify the database.
# Usage: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... scripts/check-prod-schema.sh

set -e

if [ -z "$TURSO_DATABASE_URL" ] || [ -z "$TURSO_AUTH_TOKEN" ]; then
  echo "⏭️  Skipping production schema check: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set"
  exit 0
fi

echo "🔍 Checking production schema consistency..."

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
node -e "
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

async function main() {
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const schemaPath = path.join('$PROJECT_ROOT', 'src/lib/db/schema.ts');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');

  // ----- Step 1: Check all tables exist in production -----
  const tableRegex = /export const \w+ = sqliteTable\s*\(\s*\"(\w+)\"/g;
  const expectedTables = [];
  let t;
  while ((t = tableRegex.exec(schemaContent)) !== null) {
    expectedTables.push(t[1]);
  }

  const tablesResult = await client.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\");
  const actualTables = new Set(tablesResult.rows.map(r => r.name));

  const missingTables = expectedTables.filter(tt => !actualTables.has(tt));

  if (missingTables.length > 0) {
    console.log('');
    console.log('❌ Production schema drift detected!');
    console.log('   The following tables are defined in schema.ts but missing in Turso:');
    missingTables.forEach(tt => console.log('   - ' + tt));
    console.log('');
    console.log('   Run: pnpm exec drizzle-kit push');
    console.log('');
    process.exit(1);
  }

  // ----- Step 2: Check column drift for posts table -----
  const match = schemaContent.match(/export const posts = sqliteTable\(\s*\"posts\"\s*,\s*\{([\s\S]*?)\},\s*\(table\)/);
  if (match) {
    const colBlock = match[1];

    const colRegex = /\"(\w+)\"/g;
    const expectedCols = new Set();
    let c;
    while ((c = colRegex.exec(colBlock)) !== null) {
      expectedCols.add(c[1]);
    }

    const colResult = await client.execute('PRAGMA table_info(posts)');
    const actualCols = new Set(colResult.rows.map(r => r.name));

    const missingCols = [];
    for (const col of expectedCols) {
      if (!actualCols.has(col)) {
        missingCols.push(col);
      }
    }

    if (missingCols.length > 0) {
      console.log('');
      console.log('❌ Production schema drift detected!');
      console.log('   The following columns are in schema.ts but missing in Turso:');
      missingCols.forEach(cc => console.log('   - ' + cc));
      console.log('');
      console.log('   Run: pnpm exec drizzle-kit push');
      console.log('');
      process.exit(1);
    }
  }

  console.log('✅ Production schema is up to date');
  client.close();
}

main().catch(err => {
  console.error('Schema check failed:', err.message);
  process.exit(1);
});
" 2>&1
