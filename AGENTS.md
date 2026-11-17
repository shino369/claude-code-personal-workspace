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
- Never commit `tasks/`, `logs/`, third-party skills, `.claude/settings.local.json`, or `.mcp.json`.
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

## 3. Commands

| Goal                          | Command                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| Full quality gate (required)  | `pnpm check`                                                     |
| Tests / with 100% coverage    | `pnpm test` / `pnpm test:coverage`                               |
| Lint / auto-fix               | `pnpm lint` / `pnpm lint:fix`                                    |
| Format / check format         | `pnpm format` / `pnpm format:check`                              |
| Typecheck                     | `pnpm typecheck`                                                 |
| Task brief / log / help       | `pnpm task status` · `pnpm task note …` · `pnpm task help`       |
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

| When                                 | Run                                                       |
| ------------------------------------ | --------------------------------------------------------- |
| Pick up the next step                | `pnpm task next`, then `pnpm task step <id> start`        |
| A step is finished                   | `pnpm task step <id> done -m "what changed"`              |
| A step cannot continue               | `pnpm task step <id> blocked -m "why"`                    |
| New work appears                     | `pnpm task step add "title" [--deps s1,s2]`               |
| Check the work                       | `pnpm task verify` (`--fast` for the quick subset)        |
| Change the goal or verify commands   | `pnpm task set --verify "pnpm check" [--verify-fast "…"]` |
| End of every session (required)      | `pnpm task note --done "…" --next "…" [--open "…"]`       |
| Write a review or study              | `pnpm task template review` / `pnpm task template study`  |
| Everything is done and verify passes | `pnpm task done`                                          |

`pnpm task note` appends (never rewrites) this entry to `NOTES.md` and fills in `State:` for you.
Write the same shape by hand only when the CLI cannot run:

```markdown
## <yyyy-mm-dd hh:mm> — <agent/harness> (<model>)

Done: <what changed, file paths>
State: branch <name>; uncommitted <yes/no>; verify <pass/fail/not run>
Next: <the single next action, concrete enough to start without rereading everything>
Open: <blockers or decisions waiting on the user>
```

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

## 5. Git conventions

The `commit-msg` hook enforces the header; `pnpm workspace:setup` enables it.

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <description>`
  - Types: `feat` `fix` `refactor` `docs` `test` `chore` `style` `perf` `ci` `build`.
  - Scope (optional): `hooks` `skills` `rules` `config` `docs` `deps` `tests`.
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
- `gh` (GitHub CLI) — for Dependabot PR review; may not be installed.

If a runtime is missing, tell the user what to install. Do not silently switch tools.

## 10. Roles (reusable agent prompts)

`.claude/agents/*.md` are role prompts. In a harness that cannot spawn subagents, read the file
and follow it as a checklist.

| File                       | Role                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `security-reviewer.md`     | Security review: auth, injection, data exposure, dependencies |
| `test-runner.md`           | Run tests and report failures and coverage                    |
| `trilingual-translator.md` | EN/JA/zh-TW translation: initial, proofread, refine           |

## 11. Translation

Use the `trilingual-translator` role with the `translation-expertise`, `engineering-terminology`,
and `document-writing` skills. Write drafts and passes to the task's `translated/` folder.
