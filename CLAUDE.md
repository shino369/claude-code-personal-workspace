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

Use `WebFetch` for simple pages and the `agent-browser` / `browser-use` skills for interactive or JS-heavy pages. Playwright is installed for **e2e tests only** (`e2e/*.e2e.*`, `pnpm test:e2e`); don't use it for normal browsing or text extraction.

## Additional Documentation

**Task Memory:**

- `tasks/<task-name-yymmdd>/plan.md` - Implementation plan and design decisions
- `tasks/<task-name-yymmdd>/NOTES.md` - Progress, findings, and handoff notes

**Quick Reference:**

- Context degradation starts at 20-40%, not 100% - manage proactively
- Record complex plans in the task's `plan.md` so they survive context resets
- Task files under `tasks/` persist across sessions
- `/clear` without hesitation - fresh context beats degraded context
