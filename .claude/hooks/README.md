# Claude Code Hooks

This directory contains hook scripts that automatically execute during various events. They run in
Claude Code, Codex, DSH, and Antigravity CLI (`agy`). `utils/harness/hooks.js` lists each hook
once, with its event and matcher per harness; `pnpm harness sync` writes `.codex/hooks.json`,
`.dsh/hooks.json`, and `.agents/hooks.json` from it, and `pnpm harness check` fails when they or
`.claude/settings.json` differ from it. Every script takes `--harness claude|codex|dsh|agy`
(default `claude`). Details: `docs/harness.md`, "Four harnesses".

| Hook                   | Claude Code | Codex                                            | DSH (partly tested)    | Antigravity CLI (`agy`)                           |
| ---------------------- | ----------- | ------------------------------------------------ | ---------------------- | ------------------------------------------------- |
| `audit_logger.js`      | yes         | yes (edits from PreToolUse)                      | yes                    | yes (`PostToolUse *`)                             |
| `auto_format.js`       | yes         | yes, queued; formatted at the next tool or Stop  | yes                    | yes (`PostToolUse` on edit tools)                 |
| `context_monitor.js`   | yes         | yes (from the rollout)                           | no (no transcript)     | yes (`PreInvocation` turn 0, from transcript)     |
| `session_start.js`     | yes         | yes                                              | yes                    | yes (`SessionStart` via `injectSteps`)            |
| `pre_compact.js`       | yes         | yes                                              | no (no event)          | no (no PreCompact event)                          |
| `task_loop.js`         | yes         | yes                                              | yes                    | yes (`Stop` `continue`, `--reset` on turn 0)      |
| `guard.js`             | no (native) | patches only (shell commands use the rules file) | commands, reads, edits | commands, reads, edits (`allow`/`ask`/`deny`)     |
| `utils/memory/hook.js` | yes         | yes, with extraction                             | recall only            | core block, prompt & failure recall, idle extract |

## Installed Hooks

### 1. Audit Logger (`audit_logger.js`)

**Event:** PostToolUse (all tools)
**Purpose:** Records Claude Code's working history for audit and review purposes.

**What it does:**

- Appends one JSON line per tool call to `<project>/logs/<YYYYMMDD>/logging.jsonl`. The project
  root is `$CLAUDE_PROJECT_DIR`, else the hook input's `cwd`, else the process cwd
- Append-only JSONL is safe when hooks run concurrently (parallel tool calls, subagents); a
  read-modify-write JSON array would lose entries
- Records timestamps, tool names, inputs, outputs, and session information
- Redacts secrets in every string before logging: AWS keys, GitHub tokens, `sk-…` API keys,
  Slack tokens, JWTs, `Bearer` tokens, PEM private keys, `*_TOKEN=` / `*_PASSWORD=` / `*API_KEY=`
  style assignments, and string values under secret-named keys. An assignment whose value is
  only a reference (`$GITHUB_TOKEN`, `${X}`, `$(gh auth token)`, `<placeholder>`) is kept
- Truncates large `content` / `new_source` fields (>500 chars) after redaction

The rules live in `utils/redact.js`, shared with the memory store (which refuses a note that
matches) and memory export (which stops on a match). Redaction is pattern-based and
best-effort; treat `logs/` as sensitive and keep it git-ignored.

**Log Structure:**

```
logs/
└── 20260110/
    └── logging.jsonl
```

**Log Entry Format** (one object per line):

```json
{
  "timestamp": "2026-01-10T10:30:45.123Z",
  "session_id": "abc123...",
  "hook_event": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "GH_TOKEN=[REDACTED] gh pr list" },
  "tool_response": { "stdout": "..." },
  "cwd": "/path/to/project",
  "permission_mode": "default"
}
```

Read a day's log with `jq . logs/<YYYYMMDD>/logging.jsonl`.

### 2. Auto Formatter (`auto_format.js`)

**Event:** PostToolUse (Edit|Write tools)
**Purpose:** Automatically formats files using prettier after editing or writing.

**What it does:**

- Runs prettier on formattable files after Edit or Write operations: Prettier's own CLI script
  through `node` (no pnpm, no shell), so it works the same on Windows and a file path never
  reaches a shell
- Supports common file types: .js, .jsx, .ts, .tsx, .json, .css, .scss, .html, .md, .yaml, etc.
- Skips files that aren't formattable or don't exist

**Prerequisites:**
Prettier must be installed in the workspace. To install:

```bash
pnpm add -D prettier
```

**Optional:** Create a `.prettierrc` file to customize formatting:

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

### 3. Context Monitor (`context_monitor.js`)

**Event:** UserPromptSubmit
**Purpose:** Warns when the session is using too much context, based on actual token usage.

**What it does:**

- Reads the newest assistant `usage` entry from the session transcript
- Injects `[Context Monitor]` at 20%, `[WARNING]` at 40%, and `[URGENT]` at 60%
- Also sets `systemMessage` for warning/urgent levels so the warning is visible in the UI
- At warning/urgent levels, names the task this session works on and tells the model to run
  `pnpm task note`
- Fails open (stays silent) if the transcript is missing or unparsable

**Configuration:** The window defaults to 1M tokens. Set `CLAUDE_CONTEXT_WINDOW` to the model's
actual window if it differs.

### 4. Session Start (`session_start.js`)

**Event:** SessionStart (matcher `startup|resume|clear|compact`)
**Purpose:** Hands every new or reset session the task it was working on.

**What it does:**

- Binds a new session (its `session_id`) to the default task (`tasks/.active`), dormant: the
  session's hooks act on it only after a `pnpm task` command changes it (`tasks/.sessions/`,
  see `utils/task/store.js`). A resumed or compacted session keeps its binding; bindings older
  than 14 days are pruned
- Injects the session's task's `pnpm task status` brief as `additionalContext`: goal, progress,
  next step, waiting steps, last verify, repo and git state, last NOTES entry
- With no task, lists up to five open tasks to pick from
- Ends with a `Tools:` line from `tools/local.json` (`pnpm tools`): the agents, CLIs, runtimes,
  and source checkouts this machine has, so the session knows what it can call (or a nudge to run
  `pnpm tools scan`). With no tasks and an unreadable registry it stays silent
- Fails open: an unreadable task becomes a one-line notice, never a blocked session

### 5. Pre-Compact (`pre_compact.js`)

**Event:** PreCompact
**Purpose:** Leaves a checkpoint on disk before the conversation is summarized.

**What it does:**

- Appends a mechanical entry to the session's task's `NOTES.md`: time, trigger (manual/auto),
  branch, uncommitted files, last verify result, and `git diff --shortstat` (of the task's repo)
- Does nothing when the session has not worked on a task; never blocks compaction

### 6. Task Loop (`task_loop.js`)

**Event:** Stop (plus `UserPromptSubmit` with `--reset`)
**Purpose:** The inner loop: keep working until the task's fast verify passes; for code tasks, then
walk through the quality loop (review round → triage → fixes; AGENTS.md §4.5).

**What it does:**

- Does nothing unless the session's task (one it worked on; never another session's) has the
  loop on (the default for code tasks; `pnpm task set --loop on [--loop-max N]`); with the loop
  off it exits without running anything
- Otherwise runs `pnpm task check` (when the task folder has code) and the task's `verifyFast`
  commands (else `verify`) with a 240 s timeout, and records `lastVerify` in `state.json`. A
  verify that already passed on the same work (`workPrint` in `utils/task/loop.js`) is not run
  again: the stop goes through quietly
- Decides from the state on disk under the task lock, so changes another agent made while verify
  ran are kept
- On failure, blocks the stop with the failure summary (`decision: "block"`) and counts the
  iteration; lets the stop through at `loop.max`, or when the same failure repeats three times in a
  row (no progress), writes a NOTES entry, and marks the loop `halted`: later stops skip verify
- The count never resets on a Stop event. Claude Code's own guards (`stop_hook_active`, the
  consecutive-continuation cap) do not reliably catch this loop, because a continuation that makes
  tool calls can look like a fresh stop. It resets only on a pass, `pnpm task set --loop on`, or a
  prompt the user types: the same script runs with `--reset` on `UserPromptSubmit` and ignores
  `<task-notification>` prompts and missing prompts (fail closed)
- The block message tells the agent not to retry failures that code cannot fix (git, install, or
  environment errors), and to tell the user and turn the loop off instead
- Code tasks, once verify passes (`decideQuality` in `utils/task/quality.js`): an open review round
  or open confirmed `fix:` steps block the stop with what to finish; when every step is done, fewer
  than 2 rounds ran, and the reviewed code changed since the last round, it blocks with "run
  `pnpm task review`". Each reminder fires once per situation (`quality.nudged`), so an agent that
  cannot run reviewers is never blocked forever. Otherwise it marks the loop complete and writes a
  NOTES entry listing the recorded medium/low findings
- Skips when `TASK_INNER_LOOP=off` (the `pnpm loop` outer loop sets this for its child sessions);
  fails open on any error

The task logic lives in `utils/task/` (the `pnpm task` CLI), so other harnesses get the same brief
by running `pnpm task status`.

### 7. Guard (`guard.js`)

**Event:** PreToolUse (Codex: `Bash|apply_patch`; DSH: `bash|pwsh|read|edit|write|apply_patch|str_replace_editor`; Antigravity: `run_command|read_file|view_file|edit_file|write_file|...`)
**Purpose:** Enforces the `permissions` of `.claude/settings.json` where the harness does not.

**What it does:**

- Not wired in Claude Code, which enforces its own permissions
- Codex: denies a patch that edits a protected path (secrets). Shell commands are covered by
  `.codex/rules/workspace.rules`, which `pnpm harness sync` generates from the same permissions
- DSH & Antigravity: also deny reads of protected paths, and deny or ask (`permissionDecision: ask`
  / `decision: "ask"`) for shell commands, since neither has a project-level command rules file.
  For Antigravity, allowed calls emit an explicit `{"decision":"allow"}` (an empty `{}` denies)
- Handles only `Bash`, `Read`, and `Edit` rules; other kinds (web fetch, MCP) stay Claude-only
- A guardrail, not a sandbox; fails open on any error

### 8. Memory (`utils/memory/hook.js`)

**Events:** SessionStart, UserPromptSubmit, PreToolUse (`Bash`), PostToolUseFailure (`Bash`),
SessionEnd (Antigravity: `SessionStart`, `PreInvocation`, `PostInvocation`)
**Purpose:** Personal memory (`pnpm memory`): recall notes from earlier sessions when they are
relevant, and learn new ones after a session. The same script serves Codex through
`.codex/hooks.json` (`--harness codex`; trust it once with `/hooks`; extraction reads the Codex
rollout through `condenseCodex`), DSH through `.dsh/hooks.json` (`--harness dsh`; recall only, no
SessionEnd), and Antigravity through `.agents/hooks.json` (`--harness agy`; injects the core block
at `SessionStart`, recalls prompts on `PreInvocation` turn 0 and failed commands on
`PostInvocation`, and extracts idle transcripts via `condenseAgy`).

**What it does:**

- UserPromptSubmit: recalls notes for the prompt plus the task's goal (BM25F with a gate: often
  nothing) and injects at most 4, within 1,200 characters, framed as facts, not instructions.
  Skips slash commands and background-task notifications
- PreToolUse: injects notes whose `triggers` match the command, before it runs
- PostToolUseFailure: recalls notes for the failed command and its error output (Codex: a
  PostToolUse with a non-zero exit)
- SessionStart: says when saving is off; injects the core block when `CLAUDE.local.md` does not
  load it (always for Codex); `/clear` and compaction reset what the session was shown
- Extraction (Claude Code): SessionStart records the session as open; SessionEnd queues it
  (`memory/extract/queue/`) and starts a detached worker (`utils/memory/extract.js`), so the
  session never waits. The worker reads what the transcript gained since its last offset,
  condenses it (your messages, final replies, failed commands; secrets left out), and makes one
  read-only, tool-less `claude -p` call on the session's model that returns ADD/UPDATE/DELETE ops
  against the related notes. Notes with secrets are refused; ops that read like instructions go to
  `memory/inbox.jsonl` (`pnpm memory inbox`). A session that ended without SessionEnd is queued
  by a later SessionStart once its transcript is idle for an hour. The next SessionStart announces
  what was saved (to the agent, and to you as a system message). `pnpm memory extract` runs it
  by hand (`--dry-run` shows the prompt). The same worker runs the weekly consolidation when
  SessionStart finds it due (merge duplicates, retire superseded notes, rewrite
  `memory/profile.md`); every job takes a snapshot first, and `pnpm memory undo` reverts the last one
- Injects a note once per session (`memory/cache/sessions/`), counts recalls (`usage.json`),
  skips the `reviewer` and `verifier` roles and the extraction agent (`MEMORY_EXTRACT=1`), stays
  silent before `pnpm memory init`, and fails open on any error. About 40 ms per call, most of it
  Node startup

## Hook Configuration

Claude Code hooks are configured in `.claude/settings.json`. Edit the manifest
`utils/harness/hooks.js` together with it, then run `pnpm harness sync`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session_start.js",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/pre_compact.js",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/task_loop.js",
            "timeout": 300
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/context_monitor.js",
            "timeout": 5
          },
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/task_loop.js --reset",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/audit_logger.js",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/auto_format.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Viewing Hooks

To view and manage hooks interactively:

```
/hooks
```

## Debugging Hooks

To see detailed hook execution information:

```bash
claude --debug
```

## Security Notes

- Hooks run with your user permissions
- The audit logger creates files in the `logs/` directory (already in .gitignore)
- Hook scripts exit with code 0 on errors to avoid blocking operations
- Large content is truncated in audit logs to prevent excessive file sizes

## Disabling Hooks

To temporarily disable hooks, you can:

1. Run `/hooks` and remove the hooks from the UI
2. Edit `.claude/settings.json` and remove or comment out the hooks section
3. Restart Claude Code for changes to take effect

## References

- [Claude Code Hooks Documentation](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
