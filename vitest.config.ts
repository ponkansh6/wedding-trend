import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    // メモリ制約: 本マシンは RAM 7.4GiB と非余裕のため、テストは直列実行する。
    // 並列ワーカー複数起動 (デフォルト = CPU 数) で OOM killer が発動し、
    // エディタ/エージェントプロセスごと kill される事故を防ぐ。
    // 一時的に並列化したい場合のみ VITEST_MAX_WORKERS を設定すること。
    fileParallelism: false,
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? "1"),
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
