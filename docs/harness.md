# The workspace harness

How this workspace makes coding agents (Claude Code, Codex, the DeepSeek harness) work the same
way: start from the same rules, resume where the last session stopped, keep checking their own
work, and get an independent review before a coding task is closed.

The rules agents follow are in `AGENTS.md`. This document explains how the pieces fit together.

## Design goals

- **One source of truth for every harness.** Rules live in `AGENTS.md`, task state in
  `tasks/<task>/state.json`, and both are reached through plain `pnpm` commands, so a weaker model
  in any harness can follow the same procedure. Claude-only hooks add convenience on top; they are
  never the only way to do something.
- **Machines decide "done", not the agent's opinion.** Verify commands, lint, types, and a
  recorded review gate the work.
- **Independent review.** The agent that wrote the code never reviews it. A fresh agent reviews,
  another fresh agent tries to refute each finding, and only confirmed serious findings are fixed.
- **Bounded loops.** Every loop has an iteration cap, a no-progress rule, and a wall-clock cap.
  Reminders fire once, so nothing blocks forever.

## The big picture

```text
                    AGENTS.md (rules)  ·  .agents/skills/ (skills)  ·  .claude/agents/ (roles)
                                              │
         ┌────────────────────────────────────┼────────────────────────────────────┐
         ▼                                    ▼                                    ▼
   Claude Code session                 Codex / DSH session                Unattended runs
   hooks: SessionStart brief,          reads AGENTS.md,                   pnpm loop  (one worktree)
   Stop = inner loop + review          runs pnpm task …                   pnpm swarm (worktree per step)
   reminders, PreCompact note                                             pnpm agent ask (one turn)
         │                                    │                                    │
         └────────────────────────────────────┼────────────────────────────────────┘
                                              ▼
                              pnpm task  (utils/task/ CLI)
                 tasks/<task>-<yymmdd>/ : plan.md · state.json · NOTES.md · reviews/
                                              │
                                              ▼
                 gates: pnpm task check · verify commands · review rounds · pnpm check
```

## Building blocks

### 1. Instructions

| File                       | Read by                 | Holds                                                    |
| -------------------------- | ----------------------- | -------------------------------------------------------- |
| `AGENTS.md`                | every harness           | prohibitions, start-here steps, commands, task procedure |
| `CLAUDE.md`                | Claude Code             | `@AGENTS.md` + hooks, subagents, workflows               |
| `.claude/rules/*.md`       | Claude (path-scoped)    | script and testing rules; AGENTS.md points others there  |
| `.agents/skills/<name>/`   | every harness           | skills (`.claude/skills/` are links to these)            |
| `.claude/agents/<role>.md` | Claude (subagents), all | role prompts: planner, reviewer, verifier, …             |

### 2. Tasks: the shared state

Anything that takes more than one session or produces files is a task:

```text
tasks/<name>-<yymmdd>/          # git-ignored: tasks are personal to the machine
├── plan.md        # human doc: goal, acceptance, decisions; Steps block generated from state.json
├── state.json     # machine state: steps, verify commands, loop, kind, quality — only via pnpm task
├── NOTES.md       # append-only log: Done / State / Next / Open per session
├── reviews/       # BRIEF_ and REVIEW_ files of review rounds
├── loop/ swarm/   # logs of unattended runs
└── tmp/ scripts/ docs/ studies/ translated/
```

`tasks/.active` names the active task. Every command takes `--task <name>`, `--agent <name>`, and
`--json`. Several agents can share one plan: `pnpm task claim` hands each a different ready step
(dependencies done) under a lock file.

### 3. Resume

`pnpm task status` prints a brief: goal, progress, next step, last verify, git state, and the last
note. Claude's `SessionStart` hook injects it on startup, resume, `/clear`, and compaction, plus a
`Tools:` line. The `PreCompact` hook appends a mechanical checkpoint to `NOTES.md`. A new session
compares the brief's `Git:` line with the last note's `State:` line, then continues from `Next`.

### 4. Gates

| Gate               | Checks                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm task check`  | ESLint, Prettier, `tsc` on the task's own code (workspace configs skip `tasks/`); globals per runtime: Node, browser, web extension |
| `pnpm task verify` | `task check` (once the task has code), then the task's verify commands                                                              |
| review rounds      | a clean-context review, triaged; must-fix/high must be fixed                                                                        |
| `pnpm task done`   | last verify passed; code tasks: the review gate below                                                                               |
| git hooks          | Prettier + ESLint on staged files, Conventional Commit messages                                                                     |
| `pnpm check`       | the workspace gate: typecheck, lint, format, tests with 100% coverage                                                               |

### 5. Loops

| Loop                   | Where                              | Runs until                                                       |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Inner (`task_loop.js`) | inside a Claude session            | fast verify passes; cap `--loop-max` (5); same failure 3× → halt |
| Outer (`pnpm loop`)    | headless, one git worktree         | verify passes; `--max` 5, `--stall` 2, 60 min                    |
| Swarm (`pnpm swarm`)   | headless, worktree per step        | every step merged into `swarm/<task>` and final verify passes    |
| Quality (see below)    | inner hook or `pnpm loop --review` | review round limit (2), or nothing changed since the last review |

The inner loop's count resets only on a pass, `pnpm task set --loop on`, or a prompt you type —
never on a Stop event. Unattended runs never touch the main checkout: from it, `pnpm loop` creates
`../<repo>-wt/<task>` on branch `loop/<task>` and copies the task folder there. You review the
result and copy or merge it back yourself.

### 6. Tools and other agents

`pnpm tools scan` records what this machine has in `tools/local.json` (git-ignored), checked
against `tools/catalog.json`. `pnpm agent ask --agent codex "…"` runs one read-only turn of another
agent and saves the exchange in the task's `tmp/`. `pnpm loop`, `pnpm swarm`, and the review loop
use the same adapters (`utils/loop/adapters.js`): fixed argument arrays, prompt on stdin, no shell.

| Agent  | Write mode (fixers)                 | Read mode (reviewers, `agent ask`) |
| ------ | ----------------------------------- | ---------------------------------- |
| claude | `-p --permission-mode acceptEdits`  | `-p --permission-mode plan`        |
| codex  | `exec --sandbox workspace-write`    | `exec --sandbox read-only`         |
| dsh    | `--permission-mode workspace-write` | `--permission-mode read-only`      |

## The quality loop (code tasks)

A **code task** (`pnpm task new … --verify "<tests>"`, or `--kind code`) starts with the inner loop
on and goes through this cycle:

```text
plan ─▶ build test-first ─▶ e2e (if required) ─▶ review round N ─▶ triage ─▶ record
                                                      ▲                         │
                                                      │   CONFIRMED must-fix/high → fix: steps
                                                      └──── fix test-first ◀────┘
                                   stop after round 2's fixes, or when a round confirms nothing to fix
```

1. **`pnpm task review`** opens round N (only when every step is done and verify is green;
   `--force` for an early review). It writes `reviews/BRIEF_<task>-rN.md`, which has the goal,
   plan, standards files, the files in scope, the severity rubric, and earlier refuted or fixed
   findings. It also writes an empty
   findings table in `reviews/REVIEW_<task>-rN.md`. The scope is the task's code, or the git
   changes since `--base` (default `main`) for a task that edits the workspace.
2. **Reviewer** (`.claude/agents/reviewer.md`): a fresh agent that works from the brief only. Each
   finding needs a concrete failure scenario: inputs or state → wrong result.
3. **Triage** (the "Triage mode" of `.claude/agents/verifier.md`): another fresh agent tries to
   refute each row. CONFIRMED only when the scenario really happens; unsure means REFUTED. It may
   lower an inflated severity.
4. **`pnpm task review record`** validates the table and turns each CONFIRMED must-fix or high
   finding into a step `fix: <claim> (<file:line>; <id>)`. Medium and low are recorded only.
5. The fixes are made test-first and the steps marked done; then round N+1 if the code changed.

| Severity | Meaning                                                                      | Fixed? |
| -------- | ---------------------------------------------------------------------------- | ------ |
| must-fix | Wrong behavior, data loss, a security hole, or an acceptance criterion unmet | yes    |
| high     | A design or architecture problem that will cause bugs or blocks the goal     | yes    |
| medium   | A real but local problem                                                     | no     |
| low      | Cleanup, naming, style                                                       | no     |

**Who drives it:**

- **Claude Code, interactive.** After verify passes, the Stop hook works out the next action:
  finish the open round, fix the confirmed findings, or run `pnpm task review`. It blocks the stop
  once with that instruction, and each reminder fires only once per situation. Claude runs the
  reviewer as a `reviewer` subagent and the triage as a `verifier` subagent, each given only the
  brief path. When everything is done it writes a NOTES entry listing the recorded medium/low items.
- **Any harness, unattended.** `pnpm loop <task> --agent <a> --review [--reviewer <b>]` runs the
  build loop to green, then each round. The reviewer and triage run as read-only agents that print
  their rows between `BEGIN FINDINGS` / `END FINDINGS`. The loop validates the rows and writes them
  into the findings file, so a reviewer never edits anything. Then the fixer `<a>` runs until verify
  is green and every `fix:` step is marked done.
- **Manual / other harnesses.** The same commands by hand, with
  `pnpm agent ask --agent <other> "…"` as the clean-context reviewer.

**The `done` gate.** `pnpm task done` refuses a code task until:

- at least one review round has been recorded;
- no round is still open;
- every CONFIRMED must-fix/high finding is fixed;
- with `e2e: required`, a verify command mentions `e2e` or `playwright` (a name match only).

`--force` overrides it (only with the user's agreement), and the NOTES entry lists what was skipped.

## Example: a coding task, start to finish

Goal: a small CLI that converts CSV to JSON, kept in the task folder.

**1. Create the task.**

```bash
pnpm task new csv-cli --goal "CLI that converts CSV to JSON" \
  --step "Parser with quoted fields" --step "CLI flags and errors" \
  --verify "pnpm exec vitest run --root tasks/csv-cli-261118"
```

`--verify` makes it a code task: loop on, `kind: code`, quality state `build — review round 0/2`.

**2. Build test-first.** `pnpm task step s1 start`, write `parser.test.js` (failing), then
`parser.js`. When Claude tries to stop with a failing test or an ESLint error, the Stop hook runs
`pnpm task check` + the tests and sends the failure back. Once green: `pnpm task step s1 done -m "…"`.
Same for s2.

**3. Review round 1.** All steps are done and verify is green, so the Stop hook blocks once:
"run review round 1/2". Claude runs `pnpm task review`, then a `reviewer` subagent on the brief.
The reviewer adds two rows:

| file:line            | severity | claim                                | failure scenario                   |
| -------------------- | -------- | ------------------------------------ | ---------------------------------- |
| tasks/…/parser.js:18 | high     | commas inside quotes split the field | `"a,b",c` → 3 columns instead of 2 |
| tasks/…/cli.js:5     | low      | `opts` is a vague name               | reading the code                   |

**4. Triage.** A `verifier` subagent runs the scenario and marks row 1 CONFIRMED ("ran
parse('\"a,b\",c'): 3 fields"). It marks row 2 REFUTED ("naming preference").

**5. Record and fix.** `pnpm task review record` creates
`s3. fix: commas inside quotes split the field (tasks/…/parser.js:18; r1-1)`. Claude adds a failing
test for `"a,b",c`, fixes the parser, verify goes green, and it runs `pnpm task step s3 done`.

**6. Round 2.** The code changed, so the hook asks for round 2. The new reviewer finds nothing
serious, or finds only a medium issue, which is recorded. The loop is complete, and the hook writes
a NOTES entry. If round 2 had confirmed a high finding, it would be fixed, and the loop would stop
there regardless: 2 rounds is the limit.

**7. Close.** `pnpm task note --done "…" --next "…" --open "<recorded medium/low>"`, then
`pnpm task done`.

**The same thing unattended:**

```bash
pnpm loop csv-cli --agent claude --review --reviewer codex --timeout-min 120
```

Claude fixes, Codex reviews and triages read-only, in `../<repo>-wt/csv-cli-261118`. The real run of
this command on `live-notifier-261117` (a Chrome extension) took 38 minutes:

- the build loop fixed the lint and type errors in 1 iteration;
- round 1 found 7 problems, and 6 must-fix/high fixes were made;
- round 2 found 5 problems, and 3 fixes were made;
- it then stopped at the limit, with 3 medium findings recorded.

## Example: a general task

A translation, a study, or docs: `pnpm task new translate-post --goal "…"` with no `--verify`, or
`--kind general`. It has the same plan, notes, and resume, but no check, no review gate, and the loop
stays off unless you turn it on. `pnpm task done` only needs the last verify to have passed, if the
task has verify commands.

## Limits and gotchas

- **`tasks/` is git-ignored.** Task-folder code is never committed. Unattended runs copy the task
  folder into their worktree, and you copy it back.
- **`pnpm swarm` and the `implement-plan` workflow refuse tasks with code in their folder.** The
  swarm moves work between workers only through git commits and merges, so that code would never
  reach other workers. Put product code that needs parallel workers in a git-tracked place, or use
  `pnpm loop`.
- **Only must-fix and high findings get fixed, in at most 2 rounds.** Everything else goes to
  NOTES "Open". That is deliberate: reviews always find something, and unbounded rounds burn time
  on style.
- **Reminders fire once.** If an agent cannot run subagents, it says so and stops. The loop never
  traps it.
- **The review starts only when every step is done.** `pnpm task review` refuses otherwise (unless
  `--force`), and `pnpm loop --review` stops with `steps-open`.
- **Severity only goes down in triage.** `pnpm loop --review` rejects a triage that raises one; when
  you triage by hand, it is the verifier role's rule, not a check.
- **Role limits are prompts.** The reviewer and verifier subagents have Edit (for the findings
  table only) by instruction, not by enforcement. The headless reviewers run read-only.
- **Claude hooks run only in Claude Code.** Other harnesses get the same state through
  `pnpm task status`, and the same enforcement through git hooks and the `done` gate. DSH can run
  Claude hooks through its opt-in bridge.

## Where the code lives

| Path                           | What                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `utils/task/`                  | `pnpm task`: state, store (locks, atomic writes), brief, check, review, quality, inner loop |
| `utils/loop/`                  | `pnpm loop`: adapters, worktree, driver (verify loop), review-loop                          |
| `utils/swarm/`                 | `pnpm swarm`: dispatcher, worker processes, git helpers                                     |
| `utils/agent/`, `utils/tools/` | `pnpm agent ask`, `pnpm tools`                                                              |
| `.claude/hooks/`               | session_start, pre_compact, task_loop, context_monitor, audit_logger, auto_format           |
| `.claude/agents/`              | role prompts (planner, reviewer, verifier, …)                                               |
| `.claude/workflows/`           | Claude workflows: review-changes, implement-plan, research                                  |
| `templates/task/`              | plan.md, NOTES.md, REVIEW.md, STUDIES.md templates                                          |
