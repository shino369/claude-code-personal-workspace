# Kyoten

[![Test CI](https://github.com/shino369/claude-code-personal-workspace/actions/workflows/test.yml/badge.svg)](https://github.com/shino369/claude-code-personal-workspace/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

Kyoten (拠点) is a supercharged personal workspace for programming, documentation, research, translation, and
generative-AI work. It packages reusable rules, subagents, skills, hooks, and a repeatable quality
gate. Mainly designed for Claude Code, but also works for Codex / DSH.

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [Repository Layout](#repository-layout)
  - [Tasks](#tasks)
  - [Memory](#memory)
- [Skills](#skills)
  - [Project-owned skills](#project-owned-skills)
  - [Third-party skills](#third-party-skills)
  - [Managing skills](#managing-skills)
  - [Skill runtime prerequisites](#skill-runtime-prerequisites)
- [Agents](#agents)
- [Rules](#rules)
- [Hooks](#hooks)
- [Translation](#translation)
- [Testing](#testing)
- [Configuration](#configuration)
  - [Package Management](#package-management)
  - [Permissions](#permissions)
  - [MCP Servers](#mcp-servers)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

## Overview

This workspace keeps the Claude Code setup in one repository:

- `AGENTS.md` — canonical instructions for every agent harness (Claude Code, Codex, DeepSeek harnesses, …)
- `CLAUDE.md` — imports `AGENTS.md` and adds Claude-Code-only notes
- `.agents/skills/` — skills (project-owned ones tracked; third-party ones from skills.sh git-ignored)
- `.claude/skills/` — generated links into `.agents/skills/` for Claude Code (git-ignored)
- `.claude/rules/` — path-scoped rules (scripts, tests)
- `.claude/agents/` — role prompts / subagents
- `.claude/hooks/` — task resume brief, context monitor, audit logger, auto-formatter (Claude Code only)
- `utils/task/` + `templates/task/` — the `pnpm task` CLI and task templates (every harness)
- `.githooks/` — commit hooks for every harness (format, lint, Conventional Commits)
- `skills-lock.json` — pinned sources and hashes for third-party skills

The workspace is deliberately lightweight: no slash commands, no monorepo, and no build step.
Translation, code review, dependency maintenance, and context management are handled by skills and
subagents — ask Claude directly.

## Requirements

- Node.js **24 or later** (`.nvmrc` pins 24; `agent-browser` requires 24+)
- pnpm **12.14.0**, pinned in `package.json` via Corepack. Run `corepack enable`, or prefix
  commands with `corepack pnpm`
- Chrome/Chromium, for Playwright e2e tests and browser-driving skills
- `uv`, for the `browser-use` runtime and the `skill-creator` and `transparent-background` Python
  scripts

## Getting Started

```bash
corepack enable
pnpm workspace:setup   # install deps + third-party skills, link skills, enable git hooks, memory init
pnpm workspace:check   # verify; every failure prints its Fix command
```

Add `--with-browsers` for agent-browser and Playwright Chromium, `--skip-skills` when offline, or
`--target <dir>` to link skills into another harness's skill folder. The `workspace-setup` skill
(`.agents/skills/workspace-setup/SKILL.md`) covers troubleshooting.

Quality gate (typecheck, lint, format check, tests at 100% coverage):

```bash
pnpm check
```

Then simply run the agent inside this workspace.

## Repository Layout

```text
.
├── .agents/skills/          # Skills: project-owned (tracked) + third-party (ignored)
├── .claude/
│   ├── agents/              # Role prompts / subagents
│   ├── hooks/               # Resume brief, context monitor, audit logger, formatter
│   ├── rules/               # Path-scoped rules (scripts, tests)
│   ├── skills/              # Links into .agents/skills (generated, ignored)
│   └── workflows/           # Saved Claude Code workflows (review, implement-plan, research)
├── .githooks/               # pre-commit + commit-msg (all harnesses)
├── docs/harness.md          # How the harness works (tasks, loops, review), with examples
├── docs/testing/            # Deep testing guides
├── e2e/                     # Playwright e2e tests
├── tasks/                   # Generated task outputs (git-ignored)
├── templates/task/          # plan/NOTES/REVIEW/STUDIES templates for pnpm task
├── tools/                   # catalog.json (tracked) + local.json (this machine, ignored)
├── utils/                   # Shared Node utilities (task/, loop/, swarm/, agent/, tools/ CLIs)
├── AGENTS.md                # Instructions for every agent
├── CLAUDE.md                # @AGENTS.md + Claude Code notes
├── skills-lock.json         # skills.sh lockfile
└── ...
```

Third-party skills are not committed. `pnpm skills:install` installs the recommended set from
`skills-lock.json` into `.agents/skills/` (git-ignored), so each user chooses what to install.

### Tasks

Generated work goes in `tasks/<task-name-yymmdd>/`, managed with the `pnpm task` CLI so any
agent (or you) can stop and resume without losing the thread:

```bash
pnpm task new some-task --goal "Translate the X post" --step "Draft" --step "Proofread" --verify "pnpm check"
pnpm task step s1 start            # … work …
pnpm task step s1 done -m "draft in translated/"
pnpm task note --done "drafted" --next "proofread section 2"
pnpm task status                   # resume brief: goal, next step, last note, verify, git
```

```text
tasks/some-task-260101/
├── plan.md                        # goal, acceptance, generated steps, decisions
├── state.json                     # machine state (only via pnpm task)
├── NOTES.md                       # append-only log
├── reviews/REVIEW_some-task.md    # pnpm task template review
├── studies/STUDIES_some-task.md   # pnpm task template study
└── scripts/ docs/ translated/ tmp/
```

`tasks/.active` names the active task. In Claude Code, the `SessionStart` hook injects the brief
after startup, `/clear`, and `/compact`; other harnesses run `pnpm task status` (AGENTS.md §2).
The full procedure is in `AGENTS.md` §4; `pnpm task help` lists every command. How the pieces fit
together, with a worked example: `docs/harness.md`. `tasks/` and
`logs/` are git-ignored — tasks are personal to each machine.

### Memory

Agents remember lasting facts across sessions and harnesses, on this machine only (`memory/`,
`AGENTS.local.md`, and `CLAUDE.local.md` are git-ignored; nothing is synced):

```bash
pnpm memory init                    # once (pnpm workspace:setup runs it)
pnpm memory                         # status: notes, core block, saving on/off, extraction queue
pnpm memory add "The user prefers design first, then review." --scope user --type preference --tags design,review
pnpm memory recall "how do I merge this PR"   # what the hooks would inject
pnpm memory personalize --presets   # how agents talk to you (every message to you, nothing else)
pnpm memory personalize --language "Japanese"   # keep it even when you write in English
pnpm memory personalize --persona-file persona.md   # a longer persona, written in markdown
# or keep it in memory/persona.md: pnpm memory init (and workspace:setup) apply your edits
pnpm memory personalize --off       # pause applying the saved response settings
pnpm memory personalize --on        # resume applying them in new sessions
pnpm memory off --session           # an incognito session
pnpm memory export                  # back up or move: a checksummed .tar.gz; import <file> --dry-run
```

Agents save what they learn as they go and say so; in Claude Code a background job also extracts
what they missed from each finished session. Every session loads a small core block (your
settings, pinned notes, recent tasks), and hooks recall the notes that match each prompt or failed
command. Agent rules: `AGENTS.md` §13; how it works: `docs/harness.md`.

## Skills

### Project-owned skills

| Skill                     | What it does                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- |
| `translation-expertise`   | English ↔ Japanese ↔ Traditional Chinese translation methodology and references. |
| `engineering-terminology` | Trilingual technical glossaries across six engineering domains.                  |
| `document-writing`        | Document conventions and rhetorical patterns for English, Japanese, and Chinese. |
| `context-manager`         | Context-degradation prevention and recovery.                                     |
| `dependency-update`       | Dependabot-style pnpm updates with `analyze_deps.mjs`.                           |
| `security-update`         | CVE and audit patching with release-age checks.                                  |
| `web-browsing`            | Tool selection and workflows for web interaction, real-browser sessions, e2e.    |
| `transparent-background`  | Flat-background image → transparent PNG with clean edges; specks and recolour.   |

### Third-party skills

These are not committed. Install the recommended set with `pnpm skills:install`; each skill is
installed locally into the git-ignored `.agents/skills/`. All credit belongs to the original authors.
Sources and hashes are pinned in `skills-lock.json`; each upstream repository ships its own license.

#### Browser & Web

| Skill            | What it does                                                                   | Source                                                                    | Credit      |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------- |
| `agent-browser`  | Browser automation CLI: navigation, forms, screenshots, scraping, app testing. | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Vercel Labs |
| `browser-use`    | Direct browser control over CDP: automation, scraping, screenshots.            | [browser-use/browser-use](https://github.com/browser-use/browser-use)     | Browser Use |
| `playwright-cli` | Playwright browser automation and e2e test workflows.                          | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)   | Microsoft   |

> Browser-tool selection is defined in `AGENTS.md` §8: `agent-browser` is the
> default for ad-hoc interaction, `browser-use` covers autonomous/Python/cloud work, and Playwright
> is reserved for e2e tests.

#### Engineering Workflow

| Skill             | What it does                                                                | Source                                                    | Credit      |
| ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- | ----------- |
| `code-review`     | Two-axis review (repo standards + originating spec) in parallel sub-agents. | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `diagnosing-bugs` | Structured diagnosis loop for hard bugs and performance regressions.        | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |
| `tdd`             | Test-driven development with red-green-refactor.                            | [mattpocock/skills](https://github.com/mattpocock/skills) | Matt Pocock |

#### Meta & Accessibility

| Skill           | What it does                                        | Source                                                    | Credit    |
| --------------- | --------------------------------------------------- | --------------------------------------------------------- | --------- |
| `skill-creator` | Create, edit, benchmark, and optimise agent skills. | [anthropics/skills](https://github.com/anthropics/skills) | Anthropic |

Personal or optional skills (for example `i-have-adhd`) are not in the recommended lock. Install
them individually with
`pnpm dlx skills add ayghri/i-have-adhd --skill i-have-adhd --copy --agent claude-code`.

> All third-party skills remain under their upstream licenses. Installed copies do not include
> license files except `skill-creator`, which ships `LICENSE.txt` at
> `.agents/skills/skill-creator/LICENSE.txt`; check the source repositories above for the others.

### Managing skills

Project-owned skills live in `.agents/skills/` and are committed to this repository. To add one,
follow "Adding a project-owned skill" in `.agents/skills/workspace-setup/SKILL.md`.

Third-party skills are **not committed**. Install the recommended set from `skills-lock.json` with
Vercel's [`skills` CLI](https://github.com/vercel-labs/skills) (the [skills.sh](https://skills.sh)
ecosystem):

```bash
pnpm skills:install                      # install everything in skills-lock.json
pnpm skills:install --skip <name>        # skip optional skills
pnpm skills:install --only <name>        # install only the named skills (comma-separated)
pnpm skills:update                       # update installed skills
pnpm skills:check                        # verify lock entries are installed
pnpm skills:link                         # (re)link .agents/skills into .claude/skills
```

Installation uses skills.sh's default layout with `--agent claude-code codex`: the real files land
in `.agents/skills/<name>/` (read directly by Codex) and `.claude/skills/<name>` is a relative
symlink to them. `skills:link` creates the same links for project-owned skills, migrates old copied
installs, prunes stale links, and falls back to directory junctions on Windows. Third-party
installs remain untracked. `skills-lock.json` pins sources and hashes;
commit it when it changes. `skills:check` verifies every lock entry is installed with a matching
frontmatter name.
The lock's hash is a source snapshot hash, not reproducible from the installed copy, so content
changes are reviewed via `git diff`. On Windows, `skills:update` may exit 127 after a successful
update due to an upstream crash — verify the files changed before treating it as a failure.

To add a skill manually, use
`pnpm dlx skills add <owner/repo> --skill <name> --agent claude-code codex -y`, then
`pnpm skills:link`; it is installed locally and remains untracked.

### Skill runtime prerequisites

Most skills are instructions only. These require a local runtime:

| Skill                    | Runtime                            | Check / install                                                                                                                           |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-browser`          | `agent-browser` CLI                | `pnpm exec agent-browser --version`; run `pnpm exec agent-browser install` once, then `pnpm exec agent-browser ...` (devDependency)       |
| `browser-use`            | `browser-use` CLI                  | `browser-use --version`; install with `uv tool install --python 3.12 browser-use`                                                         |
| `playwright-cli`         | local Playwright                   | `pnpm exec playwright --version`; run `pnpm exec playwright cli ...`                                                                      |
| `skill-creator`          | Python 3.12 + PyYAML               | `uv run --with pyyaml --python 3.12 python ...` from the skill directory                                                                  |
| `transparent-background` | Python 3.12 + Pillow, NumPy, SciPy | `uv run --python 3.12 --with pillow --with numpy --with scipy python -I .agents/skills/transparent-background/scripts/imgalpha.py --help` |
| `dependency-update`      | `gh` CLI                           | `gh --version`; install from <https://cli.github.com/> (also used for PR attachments)                                                     |
| Playwright e2e           | Chromium                           | `pnpm exec playwright install chromium`                                                                                                   |

`npm` commands are blocked in this workspace. Use `pnpm dlx` for one-off CLIs, `pnpm add -D` +
`pnpm exec` for project-local binaries, and `uv tool` / `uvx` for Python CLIs. Avoid `pnpm add -g`:
the global bin directory is not on `PATH`, and global installs bypass the workspace lockfile and
supply-chain settings.

The `browser-use` skill comes from
[browser-use/browser-use](https://github.com/browser-use/browser-use) and requires its `browser-use`
CLI. The package pulls in `browser-harness` as a pinned dependency, so install `browser-use` rather
than `browser-harness` alone.

The vendored `agent-browser` skill invokes `agent-browser`; in this workspace call it as
`pnpm exec agent-browser ...` because no global shim is installed.

Browser skills that attach to local Chrome need its CDP endpoint. Either enable
`chrome://inspect/#remote-debugging`, or launch an isolated Chrome with
`--remote-debugging-port=9222 --user-data-dir=<profile>` and set
`BU_CDP_URL=http://127.0.0.1:9222` for `browser-use`.

## Agents

| Agent                   | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `planner`               | Turns a goal into small, verifiable steps with deps (`pnpm task`).    |
| `verifier`              | Independent PASS/FAIL: runs verify, checks acceptance and tests.      |
| `reviewer`              | Clean-context review round from a brief; findings for triage.         |
| `security-reviewer`     | Security-focused review: auth, injection, XSS, secrets, dependencies. |
| `test-runner`           | Runs tests and reports failures and coverage.                         |
| `trilingual-translator` | EN/JA/ZH translation in initial, proofread, and refine roles.         |

## Rules

Always-on guidance (safety rules, task procedure, git conventions, dependencies, browser tools,
skills index) lives in `AGENTS.md`, so every harness sees it. `.claude/rules/` keeps only the
path-scoped rules, which Claude Code loads for matching files and `AGENTS.md` tells other agents
to read:

| Rule                  | Scope      | Purpose                                    |
| --------------------- | ---------- | ------------------------------------------ |
| `testing`             | Test files | Vitest, 100% coverage, mocking.            |
| `working-with-script` | Scripts    | Node-first scripts, error handling, tests. |

## Using other agents

| Harness                     | Instructions                           | Skills                                                      |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Claude Code                 | `CLAUDE.md` → `@AGENTS.md`             | `.claude/skills/` links (created by `pnpm workspace:setup`) |
| Codex                       | `AGENTS.md`                            | `.agents/skills/` (native)                                  |
| DeepSeek harness and others | `AGENTS.md` (point it there if needed) | `.agents/skills/`, or `pnpm workspace:setup --target <dir>` |

Most of the Claude Code hooks work on other harness after the setup (but some don't). The git hooks in `.githooks/` (enabled by
`pnpm workspace:setup`) enforce formatting, linting, and commit messages for everyone, and
`pnpm task status` gives every harness the same resume brief the `SessionStart` hook injects.

### Tools and calling other agents

`pnpm tools scan` records the agents, CLIs, and runtimes this machine has in `tools/local.json`
(git-ignored), checking the list in `tools/catalog.json`. `pnpm tools list` shows them, and the
`SessionStart` brief ends with a one-line summary so Claude knows what it can call. Tools the scan
cannot find (an `npx`-only harness, a cloned reference repo) are recorded with `pnpm tools add`;
source checkouts live outside the repo in `~/.cache/agent-tools/src/` (`pnpm tools sources`).

```bash
pnpm tools list --all                                   # what is here, and how to install the rest
pnpm tools add dsh --kind agent --command "npx -y @deepseek-ai/dsh"
pnpm agent ask --agent codex "Review utils/task/loop.js for edge cases"   # read-only second opinion
pnpm loop my-task --agent codex --max 3                 # unattended fix-until-green, in a worktree
pnpm loop my-task --agent codex --review --reviewer claude   # + review rounds and fixes (code tasks)
pnpm swarm my-task --agent claude --workers 2           # parallel workers, one worktree per step
```

## Hooks

| Hook                   | Event                                                                                | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `session_start.js`     | `SessionStart`                                                                       | Injects the active task's resume brief.                       |
| `pre_compact.js`       | `PreCompact`                                                                         | Appends a checkpoint to the task's `NOTES.md`.                |
| `task_loop.js`         | `Stop`, `UserPromptSubmit`                                                           | Inner loop: verify, then the review loop (code).              |
| `context_monitor.js`   | `UserPromptSubmit`                                                                   | Warns at 20/40/60% of the context window.                     |
| `audit_logger.js`      | `PostToolUse` (`*`)                                                                  | Logs tool use to `logs/<YYYYMMDD>/logging.jsonl`.             |
| `auto_format.js`       | `PostToolUse` (`Edit\|Write`)                                                        | Runs Prettier on edited files.                                |
| `utils/memory/hook.js` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUseFailure`, `SessionEnd` | Memory: recall, announcements, extraction queue (also Codex). |

The context monitor defaults to a 1M window; set `CLAUDE_CONTEXT_WINDOW` to override it.

## Translation

Ask Claude to translate, or invoke the `trilingual-translator` agent. `translation-expertise`
supplies the methodology; `engineering-terminology` and `document-writing` add domain and style
guidance.

- English ↔ Japanese ↔ Traditional Chinese
- Optional initial → proofread → refine workflow
- File and URL sources: `WebFetch` for simple pages; `agent-browser` / `browser-use` for JS-heavy
  pages
- 1,075+ technical terms across six engineering domains

Do not use Playwright for text extraction; it is reserved for e2e tests.

## Testing

Unit and integration tests use **Vitest**:

```bash
pnpm test
pnpm test:coverage   # 100% thresholds
```

Test rules: `.claude/rules/testing.md`. Deep guides: `docs/testing/`.

End-to-end tests use **Playwright** in `e2e/` (the scaffold passes with an empty suite until you add
`*.e2e.*` tests):

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Playwright is e2e-only. For normal browsing or text extraction, use `WebFetch` or
`agent-browser` / `browser-use`.

## Configuration

### Package Management

pnpm **12.14.0** is pinned via `packageManager` and enforced by `engines.pnpm` / `engineStrict`.
All current dependencies use the `dev` catalog.

```bash
pnpm add -D some-package --save-catalog-name=dev
```

`pnpm-workspace.yaml` hardening:

- `minimumReleaseAge: 10080` — wait 7 days before using a new package version
- `strictPeerDependencies: true`
- `engineStrict: true`
- `ignoreScripts: true` with `allowBuilds: { esbuild: true }`
- `trustPolicy: no-downgrade`
- `overrides` — bounded security pins for transitive dependencies

### Permissions

Workspace permissions are configured in `.claude/settings.json`:

**Allowed operations:**

- pnpm commands (including `pnpm task rm`, the undoable delete), git status/diff/log/add/commit,
  creating a branch (`git switch -c`, `git checkout -b`), and read-only git (`rev-parse`, `show`)
- `node` only for repo scripts (`utils/`, `.claude/hooks/`, `.agents/skills/`)
- ls, dir, cd, pwd, echo, type, mkdir

`python`, arbitrary `node`, `cat`, and `curl` are deliberately not pre-approved: each can run
arbitrary code, read files the Read deny rules protect, or send data out.

**Requires confirmation:**

- git push, rebase, merge, cherry-pick
- kill -9, pkill, killall

**Denied operations:**

- rm (agents delete with `pnpm task rm`, which moves files to `tasks/.trash/` for 7 days), sudo,
  chmod, chown, dd, mount, systemctl, mkfs, fdisk, parted
- npm commands (use pnpm instead)
- PowerShell, cmd, Windows admin commands
- destructive git operations (force push, hard reset, clean -fd, branch -D, tag -d)
- pnpm publish

Local overrides belong in `.claude/settings.local.json` (git-ignored).

### MCP Servers

Local MCP configuration lives in `.mcp.json`, which is git-ignored. Copy `.mcp.json.example` and
adjust the paths for your machine.

## Contributing

This is a personal workspace, but forks and suggestions are welcome. Before opening a PR, run
`pnpm check`.

Third-party skills are managed with skills.sh; project-owned skills live in `.agents/skills/`.

## Credits

- **Third-party skills**: the [skills.sh](https://skills.sh) ecosystem, installed with
  [vercel-labs/skills](https://github.com/vercel-labs/skills). Individual authors are credited in
  the tables above.
- **Built for**: [Claude Code](https://claude.com/claude-code).

## License

The original contents of this repository are [ISC](./LICENSE). Third-party skills are not
distributed here; when installed, they remain under their upstream licenses.
