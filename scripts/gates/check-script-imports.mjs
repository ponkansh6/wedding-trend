/**
 * `scripts/` 配下の .mjs ファイルが持つ相対 import が、実際に存在するファイルへ
 * 解決できるかを静的に検査するゲート。
 *
 * `scripts/` 直下から `scripts/ops/` 等の1階層深いディレクトリへスクリプトを
 * 移した際に相対 import の深さを直し忘れると、実行時まで気づかず
 * `ERR_MODULE_NOT_FOUND` で落ちる。これを作った時点で検出する。
 *
 * static import 文（`import ... from "./x"` / `import "./x"`）と
 * dynamic import（`await import("./x")` 等）の両方を正規表現で抽出し、
 * 各指定子をそのファイルの所在ディレクトリ基準で解決してファイルの
 * 存在を確認する。TypeScript の `.ts` 拡張子省略・`.js`→`.ts` 解決
 * （tsx のモジュール解決に合わせたもの）にも対応する。
 *
 * ネットワーク・DB には一切アクセスしない純粋な静的検査であるため、
 * pre-push のブロックチェックおよび CI ゲートに組み込んでよい。
 *
 * 使い方:
 *   node scripts/gates/check-script-imports.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPTS_DIR = join(ROOT, "scripts");

function listMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listMjsFiles(full));
    } else if (entry.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

// static: import ... from "spec";  import "spec";
// dynamic: import("spec")  (with or without leading await)
const IMPORT_SPEC_RE =
  /(?:\bfrom\s+["']([^"']+)["'])|(?:\bimport\s*\(\s*["']([^"']+)["']\s*\))|(?:^\s*import\s+["']([^"']+)["'])/gm;

function extractRelativeSpecifiers(source) {
  const specs = [];
  let match;
  IMPORT_SPEC_RE.lastIndex = 0;
  while ((match = IMPORT_SPEC_RE.exec(source)) !== null) {
    const spec = match[1] || match[2] || match[3];
    if (spec && (spec.startsWith("./") || spec.startsWith("../"))) {
      specs.push(spec);
    }
  }
  return specs;
}

// 拡張子付きでそのまま存在するか、TS 拡張子省略・.js→.ts 解決の候補を試す。
function resolveSpecifier(baseDir, spec) {
  const raw = join(baseDir, spec);
  const candidates = [raw];
  if (raw.endsWith(".js")) {
    candidates.push(raw.slice(0, -3) + ".ts");
    candidates.push(raw.slice(0, -3) + ".tsx");
  }
  if (!/\.[a-z]+$/i.test(raw)) {
    candidates.push(raw + ".ts", raw + ".mjs", raw + ".js", raw + "/index.ts");
  }
  return candidates.some((c) => existsSync(c));
}

/**
 * コメントを除去する。doc コメント中の記述例（`import "./x"` など）や
 * コメントアウトされた import 文を誤検出しないため、抽出前に必ず通す。
 * 文字列リテラル中の `//` を誤って削らないよう、行コメントは行頭から
 * 空白を挟んで始まるものだけを対象にする。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const files = listMjsFiles(SCRIPTS_DIR);
const violations = [];

for (const file of files) {
  const source = stripComments(readFileSync(file, "utf8"));
  const specs = extractRelativeSpecifiers(source);
  const baseDir = dirname(file);
  for (const spec of specs) {
    if (!resolveSpecifier(baseDir, spec)) {
      violations.push({
        file: file.slice(ROOT.length + 1),
        spec,
        resolved: join(baseDir, spec).slice(ROOT.length + 1),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n❌ 解決できない相対 import を検出しました（${violations.length} 件）。\n`);
  for (const { file, spec, resolved } of violations) {
    console.error(`   ファイル: ${file}\n   指定子: ${spec}\n   解決先: ${resolved}\n`);
  }
  console.error(
    "   → scripts/ 配下のファイルを移動した際は、相対 import の深さも合わせて直してください。\n",
  );
  process.exit(1);
}

console.log(
  `[check-script-imports] OK（${files.length} ファイル、すべての相対 import が解決可能）`,
);
