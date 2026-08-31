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
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
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
