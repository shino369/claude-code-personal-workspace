# CLAUDE.md

@AGENTS.md

## Claude Code specifics

Everything above (AGENTS.md) applies. These notes cover only what is specific to Claude Code.

- **Subagents:** always inherit the main session's model (do not pick a cheaper one).
- **Context:** quality degrades at 20–40% usage, long before the window is full. The
  `UserPromptSubmit` hook `.claude/hooks/context_monitor.js` injects `[Context Monitor]` warnings
  at 20/40/60% of the window (1M by default; set `CLAUDE_CONTEXT_WINDOW` to override), naming the
  active task. Act on them: run `pnpm task note --done "…" --next "…"` (AGENTS.md §4.2), delegate
  independent work to subagents, and suggest `/compact` or `/clear` at the URGENT level.
- **Resume:** the `SessionStart` hook (`session_start.js`, on startup/resume/clear/compact)
  injects the `pnpm task status` brief, and the `PreCompact` hook (`pre_compact.js`) appends a
  mechanical checkpoint to the active task's `NOTES.md`. When a `[Task]` brief is in context, do
  not rediscover the task — continue from its `Next step`, after comparing its `Git:` line.
- **Inner loop:** `pnpm task set --loop on` makes the `Stop` hook (`task_loop.js`) re-run the
  task's fast verify at every stop and send failures back, up to `--loop-max` (default 5), stopping
  early on no progress. Stop events never reset the count; only a pass or a prompt you type does.
  Off by default; turn it off with `pnpm task set --loop off`.
- **Hooks** (`.claude/settings.json`): `audit_logger.js` appends redacted tool calls to
  `logs/<YYYYMMDD>/logging.jsonl`, and `auto_format.js` runs Prettier after Edit/Write. These run
  only in Claude Code; the git hooks from `pnpm workspace:setup` cover every harness.
- **Skills:** Claude Code discovers skills through the `.claude/skills/<name>` links into
  `.agents/skills/`. If a skill is missing, run `pnpm skills:link` and restart the session.
- **Rules:** `.claude/rules/testing.md` and `.claude/rules/working-with-script.md` load
  automatically when you work with matching files.
- **Settings:** shared permissions are in `.claude/settings.json`; personal overrides go in the
  git-ignored `.claude/settings.local.json`.
