# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a personal workspace for Claude Code to assist with various daily tasks including programming, documentation, research, consultation, translation, and generative-AI development.

**Package Manager**: This workspace uses **pnpm 12.14.0**, pinned in `package.json` via `packageManager` (Corepack). Always use `pnpm` commands instead of `npm`; run `corepack enable` or prefix commands with `corepack pnpm` if `pnpm` is not on your PATH.

## Context Management

**Why Context Management Matters**: Quality degrades at 20-40% usage, long before a window is full. The actual window depends on the model (1M tokens by default; set `CLAUDE_CONTEXT_WINDOW` to override). A `UserPromptSubmit` hook (`.claude/hooks/context_monitor.js`) measures real usage from the transcript and injects `[Context Monitor]` warnings at 20/40/60%, so act on those warnings rather than estimating from message counts.

**Best Practices:**

1. **Scope conversations per feature** - One conversation per task/feature prevents context bleeding. Don't build auth and refactor database in the same session.

2. **Use external memory** - Write plans and progress into the task directory: `tasks/<task-name-yymmdd>/plan.md` and `NOTES.md`. These persist across sessions, allowing fresh context with preserved knowledge.

3. **The copy-paste reset** - When context gets bloated:
   - Copy important info from terminal
   - Run `/compact` to summarize
   - Run `/clear` to wipe context
   - Paste back only what matters

4. **Know when to clear** - If explaining the same thing 3+ times, `/clear` and reframe. Fresh context > fighting through degraded context.

5. **Write plans to a file** - For complex tasks, outline the approach in `tasks/<task-name-yymmdd>/plan.md`. It survives context resets and keeps the implementation focused.

**External Memory Files:**

- `tasks/<task-name-yymmdd>/plan.md` - Implementation plan and design decisions
- `tasks/<task-name-yymmdd>/NOTES.md` - Progress, findings, and handoff notes

**Model Selection: important! use inherit model from the main session**

## Task Organization

Conventions for creating outputs (task directories under `tasks/`, content subdirectories, file naming) live in `.claude/rules/task-organization.md`.

## Quality Checks

Run these before finishing a change:

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm format:check
```

## Available Systems

### Translation

Ask for a translation, or invoke the `trilingual-translator` agent directly. The `translation-expertise` skill supplies the methodology; `engineering-terminology` and `document-writing` add domain and style guidance.

### Web Content

Use `WebFetch` for simple pages. For browser work, use the `web-browsing` skill and `.claude/rules/browser-tools.md`: `pnpm exec agent-browser ...` is the default for ad-hoc interaction, `browser-use` is for the user's real Chrome or autonomous/cloud work, and Playwright is **e2e-only** (`e2e/*.e2e.*`, `pnpm test:e2e`).

### Skill Runtimes

Verify a third-party skill's runtime before invoking it. Full install notes are in `README.md`
under "Skill runtime prerequisites".

- `agent-browser` — devDependency; always invoke as `pnpm exec agent-browser ...` (no global shim is installed)
- `browser-use` — `browser-use` CLI from the `browser-use` package (`uv tool install --python 3.12 browser-use`); it depends on `browser-harness` for troubleshooting
- `playwright-cli` — local Playwright (`pnpm exec playwright cli ...`)
- `skill-creator` — Python scripts via `uv run --with pyyaml --python 3.12 python ...`
- `gh` — GitHub CLI for Dependabot PR review and PR attachments; not installed here (https://cli.github.com/)

Do not use `pnpm add -g`: its global bin directory is not on `PATH`, and global installs bypass the
workspace lockfile and supply-chain settings.

Third-party skills are not committed. Install them with `pnpm skills:install` (use
`--skip <name>` for optional skills); they land in the git-ignored `.claude/skills/`. After
installing or updating them, run `pnpm skills:check` to verify them against `skills-lock.json`.

If a runtime is missing, tell the user what to install rather than silently switching tools.

## Additional Documentation

**Task Memory:**

- `tasks/<task-name-yymmdd>/plan.md` - Implementation plan and design decisions
- `tasks/<task-name-yymmdd>/NOTES.md` - Progress, findings, and handoff notes

**Quick Reference:**

- Context degradation starts at 20-40%, not 100% - manage proactively
- Record complex plans in the task's `plan.md` so they survive context resets
- Task files under `tasks/` persist across sessions
- `/clear` without hesitation - fresh context beats degraded context
