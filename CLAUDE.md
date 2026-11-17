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
  injects the `pnpm task status` brief plus a `Tools:` line (AGENTS.md §12: other agents you can
  call with `pnpm agent ask`), and the `PreCompact` hook (`pre_compact.js`) appends a
  mechanical checkpoint to the active task's `NOTES.md`. When a `[Task]` brief is in context, do
  not rediscover the task — continue from its `Next step`, after comparing its `Git:` line.
- **Inner loop:** with the loop on (the default for code tasks; `pnpm task set --loop on`), the
  `Stop` hook (`task_loop.js`) re-runs `pnpm task check` (once the task has code) and the task's
  fast verify at every stop and sends failures back, up to `--loop-max` (default 5), stopping early
  on no progress. Stop events never reset the count; only a pass or a prompt you type does. Turn it
  off with `pnpm task set --loop off`.
- **Quality loop (code tasks, AGENTS.md §4.5):** once verify is green, the same hook moves you
  through the review: it blocks once per situation with the next action (run `pnpm task review`,
  finish the open round, fix the confirmed findings). Run the reviewer as an Agent subagent of type
  `reviewer` and the triage as a `verifier` subagent in triage mode, each given only the brief
  path, never your own summary of the change. If subagents are not available, say so and stop; the
  reminder is not repeated.
- **Hooks** (`.claude/settings.json`): `audit_logger.js` appends redacted tool calls to
  `logs/<YYYYMMDD>/logging.jsonl`, and `auto_format.js` runs Prettier after Edit/Write. These run
  only in Claude Code; the git hooks from `pnpm workspace:setup` cover every harness.
- **Skills:** Claude Code discovers skills through the `.claude/skills/<name>` links into
  `.agents/skills/`. If a skill is missing, run `pnpm skills:link` and restart the session.
- **Workflows** (`.claude/workflows/`, run only when the user asks for a workflow):
  `review-changes` (per-dimension review + adversarial verify), `implement-plan` (the task's todo
  steps in parallel worktrees in dependency order, merged into `wf/<task>`, then the `verifier`
  role; the Claude-subagent counterpart of `pnpm swarm`, and like it refuses task-folder code), and
  `research` (sub-questions, fact-checked, written as a study).
- **Rules:** `.claude/rules/testing.md` and `.claude/rules/working-with-script.md` load
  automatically when you work with matching files.
- **Settings:** shared permissions are in `.claude/settings.json`; personal overrides go in the
  git-ignored `.claude/settings.local.json`.
