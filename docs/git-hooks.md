# Git Hooks & Troubleshooting

We use Husky to manage local Git hooks. These hooks provide rapid feedback before code reaches CI.

---

## 1. `.husky/pre-commit`

Runs `lint-staged` on staged files, followed by full repository checks:

- **Lint-staged actions**: `oxfmt` auto-formatting, related `vitest` unit tests, and `secretlint`.
- **Global checks**: `oxlint` and `pnpm run type-check` (`next typegen` + `tsc --noEmit`).

### Common Failures & Solutions

- **Lint Errors**: Run `pnpm run lint:fast` or fix issues reported by `oxlint`.
- **Type Errors**: Run `pnpm run type-check` and resolve TypeScript errors.
- **Secretlint Hits**: Remove accidental secrets (API keys, tokens) or use placeholder configuration / `.secretlintignore`.
- **Emergency Bypass**: `--no-verify` (`git commit --no-verify`) may be used in extreme emergencies, but **must** be immediately followed by a clean, compliant fix commit. Do not make bypassing a habit.

---

## 2. `.husky/commit-msg`

Enforces the Conventional Commits specification.

- **Format**: `type(scope): subject` or `type: subject`
- **Allowed Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Special Commits**: `merge`, `revert`, `fixup!`, and `squash!` commits are permitted.

---

## 3. `.husky/pre-push`

Guards pushes to remote repositories:

1. **Uncommitted/Untracked Guard**: Fails if there are uncommitted or untracked changes in `src/` or `tests/`. Commit your changes first.
2. **Lockfile Sync**: Ensures `pnpm-lock.yaml` is in sync.
3. **Quality Gates**: Runs `pnpm run lint`, `pnpm run spec-refs`, `pnpm run format:check`, and `pnpm run security-check`.
4. **Targeted Tests & Smoke**: If `src/` or `tests/` files have changed relative to the target branch, runs vitest coverage tiers and `bash scripts/smoke-test.sh`.

### How to Resolve Pre-Push Failures

- **Uncommitted Changes**: Stage and commit your work (`git add . && git commit -m "..."`).
- **Test/Lint/Format Failures**: Run the respective scripts (`pnpm test`, `pnpm run format:fast`, `pnpm run lint`) locally, fix the issues, and push again.

---

_Remember: Local git hooks are a developer convenience. CI is the ultimate enforcement gate._
