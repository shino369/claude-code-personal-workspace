# CLAUDE.md

@AGENTS.md

## Claude Code specifics

Everything above (AGENTS.md) applies. These notes cover only what is specific to Claude Code.

- **Subagents:** always inherit the main session's model (do not pick a cheaper one).
- **Context:** quality degrades at 20–40% usage, long before the window is full. The
  `UserPromptSubmit` hook `.claude/hooks/context_monitor.js` injects `[Context Monitor]` warnings
  at 20/40/60% of the window (1M by default; set `CLAUDE_CONTEXT_WINDOW` to override), naming the
  task this session works on. Act on them: run `pnpm task note --done "…" --next "…"` (AGENTS.md §4.2), delegate
  independent work to subagents, and suggest `/compact` or `/clear` at the URGENT level.
- **Resume:** the `SessionStart` hook (`session_start.js`, on startup/resume/clear/compact)
  binds the session to the default task (dormant until a `pnpm task` command changes it; a
  resumed or compacted session keeps its task) and injects that task's brief plus a `Tools:` line
  (AGENTS.md §12: other agents you can call with `pnpm agent ask`). The `PreCompact` hook
  (`pre_compact.js`) appends a mechanical checkpoint to the session's task's `NOTES.md`. When a
  `[Task]` brief is in context, do not rediscover the task — continue from its `Next step`, after
  comparing its `Git:` line (a `!` means the branch differs from the last note's).
- **Inner loop:** with the loop on (the default for code tasks; `pnpm task set --loop on`), the
  `Stop` hook (`task_loop.js`) re-runs `pnpm task check` (once the task has code) and the task's
  fast verify at every stop and sends failures back, up to `--loop-max` (default 5), stopping early
  on no progress. It runs only for a task this session worked on, never for another session's,
  and skips a verify that already passed on the same work (nothing changed since). Stop events
  never reset the count; only a pass or a prompt you type does. Turn it off with
  `pnpm task set --loop off`.
- **Quality loop (code tasks, AGENTS.md §4.5):** once verify is green, the same hook moves you
  through the review: it blocks once per situation with the next action (run `pnpm task review`,
  finish the open round, fix the confirmed findings). Run the reviewer as an Agent subagent of type
  `reviewer` and the triage as a `verifier` subagent in triage mode, each given only the brief
  path, never your own summary of the change. If subagents are not available, say so and stop; the
  reminder is not repeated.
- **Memory** (AGENTS.md §13): `CLAUDE.local.md` imports `AGENTS.local.md`, so the core block is
  already loaded; there is nothing to read at start. `utils/memory/hook.js` recalls notes on
  UserPromptSubmit, PreToolUse (triggers), and PostToolUseFailure, announces background saves at
  SessionStart, and queues the session at SessionEnd for extraction (a detached `claude -p`, no
  tools). It stays silent for the `reviewer` and `verifier` subagents. Save notes yourself with
  `pnpm memory add` as §13 says; the extraction only catches what you missed.
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
