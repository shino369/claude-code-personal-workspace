# AGENTS.md

Instructions for every coding agent in this workspace (Claude Code, Codex, DeepSeek harnesses,
and others). Read this whole file before acting. Claude-Code-only extras live in `CLAUDE.md`.

This is a personal workspace for programming, documentation, research, translation, and
generative-AI work. It has no app to build: the deliverables are scripts, skills, docs, and task
outputs.

## 1. Never

- Never use `npm` or `pnpm add -g`. Use `pnpm` (pinned to 12.14.0 via Corepack); if `pnpm` is
  missing, run `corepack enable`.
- Never read, print, or commit secrets: `.env*`, `secrets/`, `*.pem`, `*.key`, `credentials.json`,
  `~/.ssh/`, `~/.aws/`.
- Never force-push, `git reset --hard`, `git clean -fd`, delete branches or tags, or
  `pnpm publish`. Never push, merge, or rebase unless the user asks.
- Never `git commit --no-verify`. If a hook rejects a commit, fix the cause.
- Never commit `tasks/`, `logs/`, `tools/local.json`, third-party skills, `.claude/settings.local.json`, or `.mcp.json`.
- Never edit files under `.claude/skills/` — they are links. Edit `.agents/skills/` instead.
- Never add attribution lines (`Co-Authored-By`, "Generated with …") to commits or PRs.
- Never create summary or completion documents unless the user asks.

## 2. Start here (every session)

1. **New clone or machine?** Run `pnpm workspace:setup` and fix every `✗` line by running its
   `Fix:` command. Details: `.agents/skills/workspace-setup/SKILL.md`.
2. **Continuing earlier work?** Run `pnpm task status` and follow §4.3 before doing anything else.
3. **New multi-step task?** Run `pnpm task new <name> --goal "…"` (§4.1) before writing files.
4. **Before you say a change is done:** `pnpm check` (or the task's `pnpm task verify`) must pass.
   Report failures honestly, with their output.
5. **Before you stop working on a task:** `pnpm task note --done "…" --next "…"` (§4.2).
6. **Unsure what the user wants?** Ask. Do not guess on anything destructive or outward-facing.
7. **Need another agent, a CLI, or a tool an earlier task installed?** Run `pnpm tools list` (§12)
   before saying it is unavailable or installing anything.

## 3. Commands

| Goal                          | Command                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| Full quality gate (required)  | `pnpm check`                                                     |
| Tests / with 100% coverage    | `pnpm test` / `pnpm test:coverage`                               |
| Lint / auto-fix               | `pnpm lint` / `pnpm lint:fix`                                    |
| Format / check format         | `pnpm format` / `pnpm format:check`                              |
| Typecheck                     | `pnpm typecheck`                                                 |
| Task brief / log / help       | `pnpm task status` · `pnpm task note …` · `pnpm task help`       |
| Tools on this machine         | `pnpm tools list` · `pnpm tools show <name>` · `pnpm tools scan` |
| Ask another agent (read-only) | `pnpm agent ask --agent claude\|codex\|dsh "…"`                  |
| Fix until verify passes       | `pnpm loop <task> --agent claude\|codex\|dsh` (`--help`)         |
| Review round (code task)      | `pnpm task review` · `pnpm task review record` (§4.5)            |
| Run a plan with N workers     | `pnpm swarm <task> --agent claude\|codex\|dsh --workers 2`       |
| Set up / verify the workspace | `pnpm workspace:setup` / `pnpm workspace:check`                  |
| Third-party skills            | `pnpm skills:install` · `pnpm skills:check` · `pnpm skills:link` |
| Add a dev dependency          | `pnpm add -D <pkg> --save-catalog-name=dev`                      |
| E2E tests (Playwright)        | `pnpm test:e2e`                                                  |

Every workspace script prints a `Fix:` line when it fails — run that command.

## 4. Tasks — how to perform a task

`tasks/` is git-ignored: tasks are personal to each machine. Only this procedure and the
`pnpm task` CLI are shared. Every `pnpm task` command accepts `--json`, `--task <name>` (act on a
task other than the active one), and `--agent <name>` (who is acting; or set `TASK_AGENT`).

### 4.1 Create

For anything that takes more than one session or produces files:

```bash
pnpm task new <task-name> --goal "<one sentence>" --step "<first step>" --step "…" --verify "pnpm check"
```

This creates `tasks/<task-name>-<yymmdd>/` (kebab-case name + two-digit year, month, day, e.g.
`translate-x-post-260111`) and makes it the active task (`tasks/.active`):

```text
tasks/<task-name>-<yymmdd>/
├── plan.md        # goal, acceptance, steps, decisions
├── state.json     # machine state — change it only through pnpm task, never by hand
├── NOTES.md       # append-only progress log
├── reviews/       # REVIEW_<task-name>.md   (pnpm task template review)
├── studies/       # STUDIES_<task-name>.md  (pnpm task template study)
├── scripts/       # task-only scripts (tests optional)
├── docs/  translated/
└── tmp/           # scratch and intermediate files
```

In `plan.md`, edit the Goal, Acceptance, and Decisions by hand. The Steps block between the
`task:steps` markers is regenerated from `state.json` on every change — do not edit it.

### 4.2 Work and log progress

| When                                 | Run                                                         |
| ------------------------------------ | ----------------------------------------------------------- |
| Pick up the next step                | `pnpm task next`, then `pnpm task step <id> start`          |
| Another agent works on the same task | `pnpm task claim` (atomic: takes the next free ready step)  |
| A step is finished                   | `pnpm task step <id> done -m "what changed"`                |
| A step cannot continue               | `pnpm task step <id> blocked -m "why"`                      |
| New work appears                     | `pnpm task step add "title" [--deps s1,s2]`                 |
| Check the work                       | `pnpm task verify` (`--fast` for the quick subset)          |
| Change the goal or verify commands   | `pnpm task set --verify "pnpm check" [--verify-fast "…"]`   |
| Keep working until verify passes     | `pnpm task set --loop on [--loop-max N]` (Claude Stop hook) |
| End of every session (required)      | `pnpm task note --done "…" --next "…" [--open "…"]`         |
| Write a review or study              | `pnpm task template review` / `pnpm task template study`    |
| Everything is done and verify passes | `pnpm task done`                                            |

`pnpm task note` appends (never rewrites) this entry to `NOTES.md` and fills in `State:` for you.
Write the same shape by hand only when the CLI cannot run:

```markdown
## <yyyy-mm-dd hh:mm> — <agent/harness> (<model>)

Done: <what changed, file paths>
State: branch <name>; uncommitted <yes/no>; verify <pass/fail/not run>
Next: <the single next action, concrete enough to start without rereading everything>
Open: <blockers or decisions waiting on the user>
```

Unattended fix-until-green, any harness: `pnpm loop <task> --agent claude|codex|dsh [--max 5]`.
It runs the agent headless in a git worktree (`../<repo>-wt/<task>`, branch `loop/<task>`; from the
main checkout it creates it), re-runs the task's `verify` after each try, and stops on a pass, at
`--max`, after two tries in a row with no progress, or at the wall-clock cap. Uncommitted changes
are not in a new worktree. Logs: `tasks/<task>/loop/`. Review and commit the result yourself.

Several agents on one plan: `pnpm task claim` hands each agent a different ready step (its
dependencies done) under the task lock, so no step is claimed twice; `step <id> start` refuses a
step another agent owns (`--force` takes it over; `step <id> todo` gives it back). Unattended,
`pnpm swarm <task> --agent … --workers N` does this for you: each worker runs one step in its own
worktree (`../<repo>-wt/swarm-<task>--<step>`), the swarm commits the step there once the task's
`verify` passes and merges it into the integration branch `swarm/<task>`, so dependent steps start
from their dependencies' work. A failed step is marked `blocked` and its dependents wait. Steps must
leave `verify` green on their own. Logs: `tasks/<task>/swarm/`. Review and merge `swarm/<task>`
yourself.

### 4.3 Resume

1. Run `pnpm task status`. It prints the active task's goal, progress, next step, last verify,
   git state, and last note. No active task? `pnpm task list`, pick the task the user means (ask if
   unclear), then `pnpm task switch <name>`.
2. Compare the `Git:` line with the last note's `State:`. If they differ (branch, uncommitted
   files), report the difference to the user first.
3. Do the `Next step` (or `Next (last note)`).

Tasks written by hand (no `state.json`) still get a brief from `plan.md` checkboxes and `NOTES.md`;
run `pnpm task init <name>` to track their steps with the CLI.

### 4.4 Outputs

- Put every generated file in the task directory, never the repository root.
- Name files for their purpose: `REVIEW_<task-name>.md`, `STUDIES_<task-name>.md`, descriptive
  script names.

### 4.5 Coding tasks: the quality loop

A task that writes code is a **code task**: `pnpm task new <name> --verify "<tests>"` (or
`--kind code`; existing task: `pnpm task set --kind code`). Code tasks start with the inner loop on,
and once the task folder has code, `pnpm task verify` runs `pnpm task check` (ESLint, Prettier,
`tsc` for the task's own code, which the workspace configs skip) before the verify commands. Work in
this order:

1. **Plan.** Goal, acceptance, steps in `plan.md`; `--e2e required` when there is a UI, a browser,
   or an integration to test end to end.
2. **Build test-first.** For each step: a failing test, then the code, then `pnpm task verify`
   green, then `pnpm task step <id> done`.
3. **E2E** when the plan says so: add the e2e command to verify
   (`pnpm task set --verify "<unit>" --verify "<e2e>"`).
4. **Review in a clean context.** When every step is done and verify is green, run
   `pnpm task review`. It writes `reviews/BRIEF_<task>-r<N>.md` and an empty findings table
   `reviews/REVIEW_<task>-r<N>.md`. A **different, fresh** agent reviews from the brief only (role:
   `.claude/agents/reviewer.md`; in Claude Code the `reviewer` subagent, elsewhere
   `pnpm agent ask --agent <other> "…"`). Never review your own code yourself: you know why you
   wrote it, so you miss what is wrong with it.
5. **Triage.** Another fresh agent tries to refute each finding (the "Triage mode" of
   `.claude/agents/verifier.md`) and marks it CONFIRMED or REFUTED; unsure means REFUTED.
6. **Record and fix.** `pnpm task review record` turns each CONFIRMED must-fix or high finding into
   a `fix:` step. Fix each test-first, verify green, mark the step done. Medium and low findings are
   recorded only: list them under `--open` in your last note.
7. **At most 2 review rounds.** After the fixes, run the next round (step 4). After round 2's fixes,
   or when a round confirms nothing to fix, the loop is complete. `pnpm task done` refuses a code task
   until at least one round is recorded, no round is open, every confirmed must-fix/high is fixed, and
   (with `e2e: required`) a verify command runs e2e tests. `--force` only when the user agrees.

Severity rubric (the reviewer picks it, the triage may lower it):

| Severity | Meaning                                                                      | Fixed? |
| -------- | ---------------------------------------------------------------------------- | ------ |
| must-fix | Wrong behavior, data loss, a security hole, or an acceptance criterion unmet | yes    |
| high     | A design or architecture problem that will cause bugs or blocks the goal     | yes    |
| medium   | A real but local problem                                                     | no     |
| low      | Cleanup, naming, style                                                       | no     |

Unattended, any harness: `pnpm loop <task> --agent <a> --review [--reviewer <b>]` runs steps 4–7
headless: verify to green, then each round with a read-only reviewer and triage (fresh agents), and
the fixes by `<a>`. It reviews only once every step is done (otherwise it stops with `steps-open`). In Claude Code the `Stop` hook reminds you of the next step of the loop once per
situation.

`pnpm swarm` refuses a task that keeps code in its task folder: `tasks/` is git-ignored, and the
swarm passes work between workers only through git. Put product code that needs parallel workers in
a git-tracked place (its own repository, or a tracked folder on a branch); for task-folder code use
`pnpm loop`.

## 5. Git conventions

The `commit-msg` hook enforces the header; `pnpm workspace:setup` enables it.

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <description>`
  - Types: `feat` `fix` `refactor` `docs` `test` `chore` `style` `perf` `ci` `build`.
  - Scope (optional): `hooks` `skills` `rules` `config` `docs` `deps` `tests` `tasks` `tools`.
  - Description: imperative mood, lowercase, ≤50 characters, no trailing period.
  - Body (optional): blank line, wrap at 72, explain **why**. Footer: `Closes #123`,
    `BREAKING CHANGE: …`.
  - Good: `fix(skills): handle missing transcript`. Bad: `Added feature.`, `WIP`, `update files`.
- Branches: `<type>/<brief-description>`, e.g. `feat/context-monitor`. Never commit on `main` —
  branch first.
- PR title: same format as a commit. Body: **what** and **why**, **how to verify** (commands run),
  breaking changes and follow-ups.
- Commit or push only when the user asks.

## 6. Dependencies

- Every dependency uses the `dev` catalog in `pnpm-workspace.yaml`:
  `pnpm add -D <pkg> --save-catalog-name=dev`.
- New versions must be at least 7 days old (`minimumReleaseAge`); a fresher version fails to
  install. Pick an older one; do not bypass the check.
- `pnpm remove <pkg>` does not update the catalog — delete the entry from `pnpm-workspace.yaml`
  yourself.
- Install scripts are disabled (`ignoreScripts`); only packages listed in `allowBuilds` may build.

## 7. Scripts and tests

- Default to Node.js ESM. Use Python only for data science/ML and Bash only for shell automation.
- Before writing a script, read `.claude/rules/working-with-script.md` (structure, `runIfMain`,
  error handling).
- Before writing tests, read `.claude/rules/testing.md` (Vitest, 100% coverage, mocking).
- 100% coverage is required for `utils/`, `.claude/hooks/`, and project-owned `.agents/skills/`
  scripts. Scripts in `tasks/` are exempt.

## 8. Web and browser tools

| Need                                                        | Use                                              |
| ----------------------------------------------------------- | ------------------------------------------------ |
| Static page, API, docs, text extraction                     | your fetch tool, or `curl`                       |
| Click, fill, log in, JS-heavy pages, screenshots, ad-hoc QA | `pnpm exec agent-browser …` (default)            |
| The user's real Chrome, autonomous or cloud browsing        | `browser-use` CLI                                |
| Repeatable e2e tests                                        | Playwright, `e2e/*.e2e.{js,ts}`, `pnpm test:e2e` |

- Use one browser tool per task, and close sessions and cloud browsers when done (cloud browsers
  bill until stopped).
- Playwright is only for e2e tests, never for browsing.
- Workflows: `.agents/skills/web-browsing/SKILL.md`.

## 9. Skills

Skills are folders with a `SKILL.md`, in `.agents/skills/<name>/`. If your harness does not load
skills automatically, open the matching `SKILL.md` and follow it when its "Use when" fits.

| Skill                                            | Use when                                                    | Owner       |
| ------------------------------------------------ | ----------------------------------------------------------- | ----------- |
| `workspace-setup`                                | New clone or machine, missing skills, broken links or hooks | this repo   |
| `dependency-update`                              | Updating packages, Node, or pnpm; reviewing Dependabot PRs  | this repo   |
| `security-update`                                | A CVE or `pnpm audit` finding                               | this repo   |
| `web-browsing`                                   | Any browser or web task                                     | this repo   |
| `translation-expertise`                          | Translating EN ↔ JA ↔ zh-TW                                 | this repo   |
| `engineering-terminology`                        | Technical terms in translations                             | this repo   |
| `document-writing`                               | Formal documents in EN/JA/zh-TW                             | this repo   |
| `context-manager`                                | Long sessions losing focus                                  | this repo   |
| `code-review`, `tdd`, `diagnosing-bugs`          | Review, test-first work, hard bugs                          | third-party |
| `agent-browser`, `browser-use`, `playwright-cli` | Browser runtimes                                            | third-party |
| `skill-creator`                                  | Creating or improving skills                                | third-party |

Third-party skills appear only after `pnpm skills:install`.

Skill runtimes:

- `agent-browser` — always `pnpm exec agent-browser …` (devDependency, no global binary); run
  `pnpm exec agent-browser install` once.
- `browser-use` — `uv tool install --python 3.12 browser-use`.
- `playwright-cli` — `pnpm exec playwright cli …`.
- `skill-creator` — `uv run --with pyyaml --python 3.12 python …`.
- `gh` (GitHub CLI) — for Dependabot PR review; may not be installed (`pnpm tools show gh`).

If a runtime is missing, tell the user what to install (`pnpm tools show <name>` prints the hint for
this OS). Do not silently switch tools.

## 10. Roles (reusable agent prompts)

`.claude/agents/*.md` are role prompts. In a harness that cannot spawn subagents, read the file
and follow it as a checklist.

| File                       | Role                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `planner.md`               | Goal → small, verifiable steps with deps (`pnpm task`)        |
| `verifier.md`              | Independent PASS/FAIL: verify, acceptance, weakened tests     |
| `reviewer.md`              | Clean-context review round: findings with failure scenarios   |
| `security-reviewer.md`     | Security review: auth, injection, data exposure, dependencies |
| `test-runner.md`           | Run tests and report failures and coverage                    |
| `trilingual-translator.md` | EN/JA/zh-TW translation: initial, proofread, refine           |

## 11. Translation

Use the `trilingual-translator` role with the `translation-expertise`, `engineering-terminology`,
and `document-writing` skills. Write drafts and passes to the task's `translated/` folder.

## 12. Tools and other agents

Each machine records what it can call in `tools/local.json` (git-ignored, so it is never in a
fresh clone; run `pnpm tools scan` to create it). `tools/catalog.json` (committed) lists the tools
worth having, how to check them, how agents call them headless, and per-OS install hints.

- **Look before you give up or install:** `pnpm tools list` (`--all` adds install hints for
  missing tools); details for one tool: `pnpm tools show <name>`.
- **Call another agent** for a second opinion or a delegated question:
  `pnpm agent ask --agent claude|codex|dsh "…"` (or `-` to read the prompt from stdin). It is
  read-only by default and saves the exchange to the active task's `tmp/`. `--write` lets the agent
  edit files; use it only in a git worktree.
- **Record what you install:** after installing a tool or cloning a reusable repo, run
  `pnpm tools add <name> --kind agent|cli|runtime|source (--path … | --command "…")`. Clone source
  checkouts into `pnpm tools sources` (`~/.cache/agent-tools/src/<name>`), never into `tasks/` or
  the repo. Treat them as read-only references: do not build or run them.
- **Never** put secrets in the registry: `--env` records env var names, not values.
