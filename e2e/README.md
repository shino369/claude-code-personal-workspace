# E2E Tests

Playwright tests live here as `*.e2e.{js,ts}`.

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Playwright is for e2e tests only. For normal page browsing or text extraction, use `WebFetch` or the
`agent-browser` / `browser-use` skills instead.
