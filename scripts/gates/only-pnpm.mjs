/**
 * pnpm 以外のパッケージマネージャによる install をブロックする。
 *
 * NOTE: 定番の `pnpm dlx only-allow pnpm` は使えない。`pnpm dlx` は子プロセスの
 * `npm_config_user_agent` を `pnpm/...` に上書きするため、npm から呼ばれても
 * only-allow は常に "pnpm" を検出し、一度もブロックしない（検証済み）。
 * ここでは preinstall から node を直接起動し、呼び出し元の環境変数をそのまま読む。
 */
const userAgent = process.env.npm_config_user_agent ?? "";
const detected = userAgent.split("/")[0];

// 環境変数が無い場合（CI の直接実行など）は素通しする。
if (detected && detected !== "pnpm") {
  console.error(`
╔════════════════════════════════════════════════════════════════╗
║  このリポジトリは pnpm 専用です                                ║
╚════════════════════════════════════════════════════════════════╝

  検出したパッケージマネージャ: ${detected}
  user agent: ${userAgent}

  "${detected} install" は package-lock.json / yarn.lock を生成し、
  pnpm-lock.yaml と二重管理になります。その結果 CI の
  --frozen-lockfile と scripts/gates/check-lockfile-sync.sh が無意味になります。

  代わりに以下を実行してください:

      pnpm install
`);
  process.exit(1);
}
