// scripts/gates/verify.mjs
// Unified verification suite called by pre-push and CI, encompassing all mandatory quality gates.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

function run(cmd, options = {}) {
  console.log(`\n▶ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...options });
  } catch (err) {
    console.error(`\n❌ Failed: ${cmd}`);
    process.exit(err.status || 1);
  }
}

function getChangedFiles() {
  try {
    const base = execSync("git merge-base HEAD origin/main 2>/dev/null", {
      encoding: "utf8",
    }).trim();
    if (base) {
      return execSync(`git diff --name-only ${base} HEAD`, { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    }
  } catch {
    // fallback
  }
  try {
    return execSync("git ls-tree -r --name-only HEAD", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const changed = getChangedFiles();
const hasChanged = (pattern) => changed.some((f) => pattern.test(f));

const needTest = hasChanged(
  /^(src\/|tests\/|scripts\/gates\/check-coverage-tiers\.mjs$|vitest\.config\.ts$|tsconfig\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|drizzle\.config\.ts$)/,
);
const needSmoke = hasChanged(
  /^(src\/|public\/|next\.config\.ts$|postcss\.config\.|tsconfig\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/gates\/smoke-test\.sh$)/,
);

console.log(`[verify] Changed files count: ${changed.length}`);
console.log(`[verify] needTest: ${needTest}, needSmoke: ${needSmoke}`);

// 1. Mandatory static/security/sync gates
run("bash scripts/gates/check-lockfile-sync.sh");
run("pnpm exec eslint src/");
run("bash scripts/gates/check-spec-refs.sh");
run("oxfmt --check .");
run("bash scripts/gates/check-security.sh");
run("node scripts/gates/check-migrations-additive.mjs");
run("pnpm run type-check");

// 2. Conditional or full tests & smoke
if (needSmoke) {
  run("bash scripts/gates/smoke-test.sh");
} else {
  console.log("[verify] Skipping smoke-test (no relevant files changed)");
}

if (needTest) {
  run("pnpm exec vitest run --coverage");
  run("node scripts/gates/check-coverage-tiers.mjs");
} else {
  console.log("[verify] Skipping vitest & coverage-tiers (no relevant files changed)");
}

// 3. Advisory prod schema drift if local .env.local exists
if (existsSync(".env.local")) {
  try {
    const envContent = readFileSync(".env.local", "utf8");
    const urlMatch = envContent.match(/^TURSO_DATABASE_URL=(.+)$/m);
    const tokenMatch = envContent.match(/^TURSO_AUTH_TOKEN=(.+)$/m);
    if (urlMatch && tokenMatch) {
      console.log("\n▶ Running advisory prod schema check");
      execSync("bash scripts/gates/check-prod-schema.sh", {
        stdio: "inherit",
        env: {
          ...process.env,
          TURSO_DATABASE_URL: urlMatch[1].trim(),
          TURSO_AUTH_TOKEN: tokenMatch[1].trim(),
        },
      });
    }
  } catch (e) {
    console.log("[verify] Advisory prod schema check skipped/failed gracefully:", e.message);
  }
}

console.log("\n✅ All verification gates passed successfully!");
