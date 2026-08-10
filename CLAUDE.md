# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a personal workspace for Claude Code to assist with various daily tasks including programming, documentation, research, consultation, translation, and generative-AI development.

**Package Manager**: This workspace uses `pnpm` as the package manager. Always use `pnpm` commands instead of `npm`.

## Context Management

**Why Context Management Matters**: Claude Code has a 200K token context window, but quality degrades at 20-40% usage. Managing context prevents degraded outputs and keeps conversations focused.

**Best Practices:**

1. **Scope conversations per feature** - One conversation per task/feature prevents context bleeding. Don't build auth and refactor database in the same session.

2. **Use external memory** - Write plans and progress to `SCRATCHPAD.md` or `plan.md` at the root. These persist across sessions, allowing fresh context with preserved knowledge.

3. **The copy-paste reset** - When context gets bloated:
   - Copy important info from terminal
   - Run `/compact` to summarize
   - Run `/clear` to wipe context
   - Paste back only what matters

4. **Know when to clear** - If explaining the same thing 3+ times, `/clear` and reframe. Fresh context > fighting through degraded context.

5. **Use plan mode proactively** - Press `Shift+Tab` twice before complex tasks. Planning with fresh context produces dramatically better results than iterating through confusion.

**External Memory Files:**

- `SCRATCHPAD.md` - Temporary notes, findings, progress tracking
- `plan.md` - Architecture decisions, implementation plans
- `output/tasks/<YYYYMMDD_task_name>/NOTES.md` - Task-specific notes

**Model Selection: important! use inherit model from the main session**

## Output Organization

Conventions for creating outputs (task directories under `output/tasks/`, content subdirectories, file naming) live in the `workspace-outputs` skill.

## Available Systems

### Trilingual Translation System

Use `/translate` for professional English ↔ Japanese ↔ Traditional Chinese translation. See `docs/translation/README.md` for complete documentation.

## Additional Documentation

**External Memory Templates:**

- `SCRATCHPAD.md` - Temporary session notes and progress tracking
- `plan.md` - Architecture decisions and implementation plans

**Quick Reference:**

- Context degradation starts at 20-40%, not 100% - manage proactively
- Use plan mode (`Shift+Tab` twice) before complex implementations
- External memory (SCRATCHPAD.md, plan.md) persists across sessions
- `/clear` without hesitation - fresh context beats degraded context
