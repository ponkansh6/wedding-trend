export default {
  "*.{ts,tsx}": ["oxfmt --write", "vitest related --passWithNoTests"],
  "*.{js,jsx,mjs,cjs,mts,cts,json,md,css,yaml,yml}": ["oxfmt --write"],
  "*": ["secretlint"],
};
