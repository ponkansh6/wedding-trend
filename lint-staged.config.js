export default {
  "*.{ts,tsx}": [
    "oxfmt --write",
    "vitest run tests/article-text.test.ts tests/publish-gate.test.ts --passWithNoTests",
  ],
  "*.{js,jsx,mjs,cjs,mts,cts,json,md,css,yaml,yml}": ["oxfmt --write"],
  "*": ["secretlint"],
};
