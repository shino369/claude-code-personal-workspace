# Claude Code Personal Workspace

[![Test CI](https://github.com/shino369/claude-code-personal-workspace/actions/workflows/test.yml/badge.svg)](https://github.com/shino369/claude-code-personal-workspace/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)

A personal Claude Code workspace for programming, documentation, research, translation, and
generative-AI work. It packages reusable rules, subagents, skills, hooks, and a repeatable quality
gate.

## Table of Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Getting Started](#getting-started)
- [Repository Layout](#repository-layout)
  - [Tasks](#tasks)
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

- `CLAUDE.md` — main workspace memory and working agreements
- `.claude/rules/` — always-on and path-scoped rules
- `.claude/agents/` — task-specialised subagents
- `.claude/skills/` — project-owned skills (tracked); third-party skills install locally and are ignored
- `.claude/hooks/` — context monitor, audit logger, auto-formatter
- `.claude/settings.json` — shared permissions and hook configuration
- `.agents/` — local skills CLI cache (git-ignored)
- `skills-lock.json` — pinned sources and hashes for third-party skills

The workspace is deliberately lightweight: no slash commands, no monorepo, and no build step.
Translation, code review, dependency maintenance, and context management are handled by skills and
subagents — ask Claude directly.

## Requirements

- Node.js **22 or later** (`.nvmrc` pins 24)
- pnpm **12.14.0**, pinned in `package.json` via Corepack. Run `corepack enable`, or prefix
  commands with `corepack pnpm`
- Chrome/Chromium, for Playwright e2e tests and browser-driving skills
- `uv`, for the `browser-use` runtime and `skill-creator` Python scripts

## Getting Started

```bash
corepack enable
pnpm install

# Optional: install the recommended third-party skills
pnpm skills:install

pnpm test
```

Quality gate:

```bash
pnpm lint
pnpm typecheck
pnpm test:coverage   # 100% statements/branches/functions/lines
pnpm format:check
```

## Repository Layout

```text
.
├── .agents/                 # Local skills CLI cache (git-ignored)
├── .claude/
│   ├── agents/              # Subagents
│   ├── hooks/               # Context monitor, audit logger, formatter
│   ├── rules/               # Always-on and path-scoped rules
│   └── skills/              # Project-owned skills (tracked); third-party installs ignored
├── docs/testing/            # Deep testing guides
├── e2e/                     # Playwright e2e tests
├── tasks/                   # Generated task outputs (git-ignored)
├── utils/                   # Shared Node utilities
├── CLAUDE.md                # Main workspace memory
├── skills-lock.json         # skills.sh lockfile
└── ...
```

Third-party skills are not committed. `pnpm skills:install` copies the recommended set from
`skills-lock.json` into `.claude/skills/` (git-ignored), so each user chooses what to install.
`.agents/` is only a local skills CLI cache and is git-ignored.

### Tasks

Generated work goes in `tasks/<task-name-yymmdd>/`:

```text
tasks/some-task-260101/
├── reviews/REVIEW_some-task.md
├── studies/STUDIES_some-task.md
├── scripts/some-script.js
└── ...
```

The full convention is in `.claude/rules/task-organization.md`. `tasks/` and `logs/` are
git-ignored.

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

### Third-party skills

These are not committed. Install the recommended set with `pnpm skills:install`; each skill is
copied locally into the git-ignored `.claude/skills/`. All credit belongs to the original authors.
Sources and hashes are pinned in `skills-lock.json`; each upstream repository ships its own license.

#### Browser & Web

| Skill            | What it does                                                                   | Source                                                                    | Credit      |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------- |
| `agent-browser`  | Browser automation CLI: navigation, forms, screenshots, scraping, app testing. | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Vercel Labs |
| `browser-use`    | Direct browser control over CDP: automation, scraping, screenshots.            | [browser-use/browser-use](https://github.com/browser-use/browser-use)     | Browser Use |
| `playwright-cli` | Playwright browser automation and e2e test workflows.                          | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)   | Microsoft   |

> Browser-tool selection is defined in `.claude/rules/browser-tools.md`: `agent-browser` is the
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

> All third-party skills remain under their upstream licenses, which ship with each installed
> skill. `skill-creator` includes its license at `.claude/skills/skill-creator/LICENSE.txt` when
> installed.

### Managing skills

Project-owned skills live in `.claude/skills/` and are committed to this repository.

Third-party skills are **not committed**. Install the recommended set from `skills-lock.json` with
Vercel's [`skills` CLI](https://github.com/vercel-labs/skills) (the [skills.sh](https://skills.sh)
ecosystem):

```bash
pnpm skills:install                      # install everything in skills-lock.json
pnpm skills:install --skip <name>        # skip optional skills
pnpm skills:update                       # update installed skills
pnpm skills:check                        # verify installed skills match the lock
```

Installation uses `--copy --agent claude-code`, so skills land in `.claude/skills/` as real files
(not symlinks) and are git-ignored. `skills-lock.json` pins sources and hashes; commit it when it
changes. `skills:check` verifies every lock entry is installed with a matching frontmatter name.
The lock's hash is a source snapshot hash, not reproducible from the installed copy, so content
changes are reviewed via `git diff`. On Windows, `skills:update` may exit 127 after a successful
update due to an upstream crash — verify the files changed before treating it as a failure.

To add a skill manually, use
`pnpm dlx skills add <owner/repo> --skill <name> --copy --agent claude-code`; it is installed
locally and remains untracked.

### Skill runtime prerequisites

Most skills are instructions only. These require a local runtime:

| Skill               | Runtime              | Check / install                                                                                                                     |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent-browser`     | `agent-browser` CLI  | `pnpm exec agent-browser --version`; run `pnpm exec agent-browser install` once, then `pnpm exec agent-browser ...` (devDependency) |
| `browser-use`       | `browser-use` CLI    | `browser-use --version`; install with `uv tool install --python 3.12 browser-use`                                                   |
| `playwright-cli`    | local Playwright     | `pnpm exec playwright --version`; run `pnpm exec playwright cli ...`                                                                |
| `skill-creator`     | Python 3.12 + PyYAML | `uv run --with pyyaml --python 3.12 python ...` from the skill directory                                                            |
| `dependency-update` | `gh` CLI             | `gh --version`; install from <https://cli.github.com/> (also used for PR attachments)                                               |
| Playwright e2e      | Chromium             | `pnpm exec playwright install chromium`                                                                                             |

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
| `security-reviewer`     | Security-focused review: auth, injection, XSS, secrets, dependencies. |
| `test-runner`           | Runs tests and reports failures and coverage.                         |
| `trilingual-translator` | EN/JA/ZH translation in initial, proofread, and refine roles.         |

## Rules

| Rule                   | Scope      | Purpose                                                 |
| ---------------------- | ---------- | ------------------------------------------------------- |
| `browser-tools`        | Always     | WebFetch vs agent-browser vs browser-use vs Playwright. |
| `git-conventions`      | Always     | Conventional commits, branch naming, PR titles.         |
| `node-js-dependencies` | Always     | pnpm and catalog dependency rules.                      |
| `task-organization`    | Always     | `tasks/` layout and naming.                             |
| `testing`              | Test files | Vitest, 100% coverage, mocking.                         |
| `working-with-script`  | Always     | Node-first scripts, error handling, tests.              |

Path-scoped rules load only for matching files; all rules live in `.claude/rules/`.

## Hooks

| Hook                 | Event                         | Purpose                                            |
| -------------------- | ----------------------------- | -------------------------------------------------- |
| `context_monitor.js` | `UserPromptSubmit`            | Warns at 20/40/60% of the context window.          |
| `audit_logger.js`    | `PostToolUse` (`*`)           | Logs tool usage to `logs/<YYYYMMDD>/logging.json`. |
| `auto_format.js`     | `PostToolUse` (`Edit\|Write`) | Runs Prettier on edited files.                     |

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

- pnpm commands, git status/diff/log/add/commit, python, node
- ls, dir, cd, pwd, cat, type, curl, mkdir

**Requires confirmation:**

- git push, rebase, merge, cherry-pick
- kill -9, pkill, killall

**Denied operations:**

- rm, sudo, chmod, chown, dd, mount, systemctl, mkfs, fdisk, parted
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
`pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm format:check`.

Third-party skills are managed with skills.sh; project-owned skills live in `.claude/skills/`.

## Credits

- **Third-party skills**: the [skills.sh](https://skills.sh) ecosystem, installed with
  [vercel-labs/skills](https://github.com/vercel-labs/skills). Individual authors are credited in
  the tables above.
- **Built for**: [Claude Code](https://claude.com/claude-code).

## License

The original contents of this repository are [ISC](./LICENSE). Third-party skills are not
distributed here; when installed, they remain under their upstream licenses.
