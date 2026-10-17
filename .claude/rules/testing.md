---
paths:
  - '**/*.test.{js,mjs,ts}'
  - '**/*.spec.{js,mjs,ts}'
  - '**/__tests__/**/*'
---

# Testing Rules

## Framework

Use **Vitest** (not Jest). Globals (`describe`, `test`, `expect`, `vi`, hooks) are enabled; import only `vi` when mocking.

Playwright is reserved for e2e tests (`e2e/*.e2e.*`, `pnpm test:e2e`). Install browsers with `pnpm exec playwright install chromium`. Do not use it for normal browsing or text extraction.

## Coverage Requirement

- **100%** statements, branches, functions, and lines for `.claude/hooks/`, `.claude/skills/`, and `utils/`
- Business logic, data processing, and API interaction scripts
- Tests are optional for one-off automation and throwaway scripts in `output/tasks/`

Check with `pnpm test:coverage`. CI enforces the same threshold.

## Writing Tests

- **Arrange–Act–Assert** in each test.
- Use **`test`**, not `it`, for consistency.
- One focus per test; split assertions that describe different behaviors.
- Descriptive names: `should throw ValidationError when the email is invalid`.
- Test all branches and error paths, not just the happy path.
- Prefer observable behavior over implementation details.
- Use real dependencies where practical (internal modules, a DOM implementation if the project has one); mock external APIs, slow/destructive I/O, timers, and `process.exit`.

## Testability

- Separate I/O from business logic: export a pure function, then wrap it in a thin CLI/hook entry point.
- Export functions so tests can import them.
- Guard CLI entry points with `runIfMain(import.meta.url, main)`.
- Keep `main` small; test the logic it calls.

## Coverage Ignores

Use ignores sparingly. Acceptable cases:

- CLI entry points that call `process.exit`
- Browser automation for browsing (`agent-browser` / `browser-use`); Playwright e2e tests run outside the Vitest coverage suite
- Code that only runs in a different runtime

When ignoring, keep the block minimal and add an integration test that exercises it. Use `/* c8 ignore ... */` or `/* istanbul ignore ... */` with a comment explaining why.

## Deep Guides

- `docs/testing/mocking-guide.md` — module/function/fs/timer/fetch mocking
- `docs/testing/coverage-strategies.md` — reaching 100% coverage, refactoring for testability
