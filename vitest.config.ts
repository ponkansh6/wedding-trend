import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 2026-08-31（shared_plan/17 S8）に実測して "node" へ変更した。
    // happy-dom を必要とするテストは1つも無い。DOM グローバルを参照している
    // ように見えた2箇所は、HTML フィクスチャ文字列の中身
    // （article-text.test.ts の `document.write`）と XSS 検証用の入力文字列
    // （actions.test.ts の `javascript:alert(document.cookie)`）であり、
    // 実装側も linkedom の `parseHTML` が返すローカルの document しか使わない。
    // happy-dom の構築だけで 1 回あたり約 20 秒かかっていた（environment 20.81s → 9ms）。
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup-env.ts"],
    // UI コンポーネントテストのみ happy-dom で走らせる projects 構成。
    // 注意: vite の mergeConfig は配列を上書きではなく連結（concat）する
    // （node_modules/.pnpm/vite@*/node_modules/vite/dist/node/index.js の
    // mergeConfig を実測して確認済み: include:['a'] と include:['b'] を
    // extends: true でマージすると include:['a','b'] になり、片方を消せない）。
    // そのためルート（この test ブロック）には include を置かない。
    // include をルートに置くと、各 project 側の include が「上書き」ではなく
    // 「ルートの include に追加」される形でマージされ、ui project が
    // 既存の tests/**/*.test.ts まで拾って happy-dom で二重実行してしまう
    // （実測: node 37ファイル/530テストに対し ui も 39ファイル/545 = 37+2 を実行）。
    // include の指定は各 project 側だけに持たせ、ルートは environment 等の
    // 共通設定のみを残す。
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "happy-dom",
          include: ["tests/ui/**/*.test.tsx"],
        },
      },
    ],
    // 直列実行は 2026-08-31 に撤回した。「RAM 7.4GiB のため OOM する」という
    // 前提を実測で検証したところ、568 テストのピーク RSS は約 415MB であり
    // 2 桁の乖離があった。4 ワーカー並列でもピークは変わらず（413MB）、
    // 実時間は 30.07s → 15.79s になる。node 環境化と併せて 11.05s。
    // 台数を絞りたい場合は VITEST_MAX_WORKERS で上書きする。
    fileParallelism: true,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? "4"),
    // ワーカーのヒープ上限。暴走時はシステム OOM ではなく
    // V8 のヒープ不足エラーとして検知可能にする。
    execArgv: ["--max-old-space-size=1536"],
    server: {
      deps: {
        inline: ["@google/generative-ai"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*"],
      exclude: [
        "src/**/*.d.ts",
        "src/lib/db/migrations/**",
        "src/lib/db/index.ts",
        "src/components/ui/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
