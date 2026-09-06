// scripts/gates/verify.mjs
// Unified verification suite called by pre-push and CI, encompassing all mandatory quality gates.
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STALE_TIER_PATTERNS_FILE = "coverage/stale-tier-patterns.json";

function run(cmd, options = {}) {
  console.log(`\n▶ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...options });
  } catch (err) {
    console.error(`\n❌ Failed: ${cmd}`);
    process.exit(err.status || 1);
  }
}

function git(args, { cwd = process.cwd() } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Return the changed paths together with whether Git could inspect every
 * relevant source. Callers must run the full verification set when reliable is
 * false: an unavailable Git command must never make checks disappear.
 */
export function getChangedFiles({ cwd = process.cwd(), gitRunner = git } = {}) {
  const files = new Set();
  let reliable = true;
  try {
    const base = gitRunner(["merge-base", "HEAD", "origin/main"], { cwd }).trim();
    if (base) {
      const committed = gitRunner(["diff", "--name-only", base, "HEAD"], { cwd })
        .split("\n")
        .filter(Boolean);
      for (const f of committed) files.add(f);
    } else {
      const lsTree = gitRunner(["ls-tree", "-r", "--name-only", "HEAD"], { cwd })
        .split("\n")
        .filter(Boolean);
      for (const f of lsTree) files.add(f);
    }
  } catch {
    try {
      const lsTree = gitRunner(["ls-tree", "-r", "--name-only", "HEAD"], { cwd })
        .split("\n")
        .filter(Boolean);
      for (const f of lsTree) files.add(f);
    } catch {
      reliable = false;
    }
  }

  try {
    const porcelain = gitRunner(["status", "--porcelain=v1", "-z"], { cwd }).split("\0");
    for (let index = 0; index < porcelain.length; index += 1) {
      const line = porcelain[index];
      if (!line) continue;
      const status = line.substring(0, 2);
      const payload = line.substring(3);
      if (!payload) continue;
      files.add(payload);
      // With -z, renames/copies are encoded as destination NUL source. The
      // destination is what downstream path matching needs, but consume the
      // source record so it is not parsed as a separate status line.
      if (status[0] === "R" || status[0] === "C") {
        index += 1;
      }
    }
  } catch {
    reliable = false;
  }

  return { files: Array.from(files), reliable };
}

export function getVerificationScope(options) {
  const { files: changed, reliable } = getChangedFiles(options);
  const hasChanged = (pattern) => changed.some((f) => pattern.test(f));

  const needTest =
    !reliable ||
    hasChanged(
      /^(src\/|tests\/|scripts\/gates\/check-coverage-tiers\.mjs$|vitest\.config\.ts$|tsconfig\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|drizzle\.config\.ts$)/,
    );
  const needSmoke =
    !reliable ||
    hasChanged(
      /^(src\/|public\/|next\.config\.ts$|postcss\.config\.|tsconfig\.json$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts\/gates\/smoke-test(?:-http)?\.sh$|tests\/ui\/smoke-contract\.test\.tsx$)/,
    );

  return { changed, reliable, needTest, needSmoke };
}

function main() {
  const { changed, reliable, needTest, needSmoke } = getVerificationScope();

  console.log(`[verify] Changed files count: ${changed.length}`);
  console.log(`[verify] Changed-file detection reliable: ${reliable}`);
  console.log(`[verify] needTest: ${needTest}, needSmoke: ${needSmoke}`);

  // 1. Mandatory static/security/sync gates
  run("bash scripts/gates/check-lockfile-sync.sh");
  run("pnpm exec oxlint --nextjs-plugin --react-plugin --react-perf-plugin src/");
  run("bash scripts/gates/check-spec-refs.sh");
  run("oxfmt --check . '!shared_plan/**'");
  run("bash scripts/gates/check-security.sh");
  run("node scripts/gates/check-script-imports.mjs");
  run("node scripts/gates/check-migrations-additive.mjs");
  run("pnpm run type-check");

  // 2. Conditional or full tests & smoke
  if (needSmoke) {
    run("bash scripts/gates/smoke-test.sh");
  } else {
    console.log("[verify] Skipping smoke-test (no relevant files changed)");
  }

  let coverageTiersRan = false;
  if (needTest) {
    try {
      rmSync(STALE_TIER_PATTERNS_FILE, { force: true });
    } catch {
      // ignore
    }
    run("pnpm exec vitest run --coverage", {
      env: {
        ...process.env,
      },
    });
    run("node scripts/gates/check-coverage-tiers.mjs");
    coverageTiersRan = true;
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

  // shared_plan/20 P3: 未一致 tier パターンのサマリ（warn 化の必須付帯条件）。
  // coverage-tiers が走った場合は必ず件数を表示する（0 件でも明示）。
  if (coverageTiersRan) {
    let stale = { count: 0, patterns: [] };
    try {
      if (existsSync(STALE_TIER_PATTERNS_FILE)) {
        stale = JSON.parse(readFileSync(STALE_TIER_PATTERNS_FILE, "utf8"));
      }
    } catch {
      // ignore parse errors — treat as unknown
    }
    console.log(`\n未一致 tier パターン ${stale.count}件`);
    for (const { tier, pattern } of stale.patterns ?? []) {
      console.log(`  - ${tier}: ${pattern}`);
    }
    if (stale.count > 0) {
      console.log(
        "  （warn: CI はブロックしません。ファイルの削除・改名時は scripts/gates/check-coverage-tiers.mjs の tier 定義を追随させること）",
      );
    }
  }

  console.log("\n✅ All verification gates passed successfully!");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
