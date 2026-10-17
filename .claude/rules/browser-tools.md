# Browser Tool Selection

The three browser tools overlap; choose by intent.

| Intent                                                                                   | Use                  |
| ---------------------------------------------------------------------------------------- | -------------------- |
| Static page, API, docs, simple text extraction                                           | `WebFetch` or `curl` |
| Ad-hoc interaction: click, fill, log in, JS-heavy pages, screenshots, exploratory QA     | `agent-browser`      |
| Autonomous multi-step browsing, Python API, parallel/isolated or cloud browsers, stealth | `browser-use`        |
| Repeatable e2e tests, assertions, CI, cross-browser, test generation, tracing            | Playwright (`e2e/`)  |

For step-by-step workflows, real-browser setup, and cleanup, use the `web-browsing` skill.

**Rules:**

- `agent-browser` is the default for browser interaction. Invoke it as `pnpm exec agent-browser ...`;
  no global shim is installed. Reuse named sessions and close them when done.
- `browser-use` is for tasks that need its agent framework, Python API, or cloud browsers. Do not
  use it as a second general-purpose browser driver.
- Playwright is e2e-only: tests live in `e2e/*.e2e.{js,ts}` and run with `pnpm test:e2e`. Install
  browsers with `pnpm exec playwright install chromium`.
- `playwright-cli` is for Playwright-specific workflows (test generation, debugging, tracing), not
  ad-hoc browsing.
- If the user names a browser tool, use it.
- Use one browser tool per task; do not repeat the same navigation in multiple tools.
- Stop cloud/remote browsers when the task ends; they bill until stopped.
