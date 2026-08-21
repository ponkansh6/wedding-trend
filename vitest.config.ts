import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
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
        "src/app/**",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
