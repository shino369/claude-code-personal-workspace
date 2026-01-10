---
Author: shino369
---

# Claude Code Workspace

Personal Claude Code Workspace for assisting different daily tasks. From programming to documentation, research, consultation, translation to generative-AI development.

## Overview

This workspace is configured with different files to support personal tasks, with well-structured `.claude/*` setup to help claude-code operation:

- `./CLAUDE.md` to serve as main memory
- `./.claude/rules/*` for extended rules
- `./.claude/settings.json` for workspace config
- `./.claude/agents/*` for task-specialized subagents
- `./.claude/skills/*` for progressively disclosured knowledge
- `./.claude/hooks/*` for claude code hooks

For Claude Code generated file output, it should be located in the `output/tasks/<YYYYMMDD_task_name>/*`. It should follow the general structure below:

```
output/
└── tasks/
    ├── 26260101_some_task
    |   ├── reviews/
    |   |   ├── REVIEW_some_task.md
    |   |   └── ...
    |   ├── studies/
    |   |   ├── STUDIES_some_task.md
    |   |   └── ...
    |   ├── scripts/
    |   |   ├── some_script.js
    |   |   ├── some_script.py
    |   |   └── ...
    |   ├── ... // others
    |
    ├── 26260102_some_another_task
```

Directory name under `YYYYMMDD_task_name` varies and will be based on the task nature.

## Available Systems

### Trilingual Translation System

Professional translation system supporting English ↔ Japanese ↔ Traditional Chinese with a multi-stage collaborative workflow.

**Quick Start:**

```bash
/translate --lang en "ぬるぽ ガッ"
```

**Features:**

- Three-stage translation workflow (Initial → Proofread → Refine)
- File and URL translation support
- 1,075+ technical terms across 6 engineering domains
- Automatic encoding detection (UTF-8, EUC-JP, etc.)

See [Claude Code Trilingual Translation System](./docs/translation/README.md) for complete documentation.

### Claude Code Development System

Expert knowledge for creating and extending Claude Code components including agents, skills, commands, and hooks.

**Skill:** `claude-code-development`

**Covers:**

- Creating custom subagents
- Building progressively disclosed skills
- Implementing slash commands
- Setting up hooks for automation
- Best practices and patterns

**Use when:** Creating or modifying Claude Code workspace components

### Hooks System

Automated hooks that execute during Claude Code operations:

**1. Audit Logger** (`audit_logger.js`)

- Records all tool usage to `/logs/<YYYYMMDD>/logging.json`
- Provides complete working history for audit purposes
- Runs on every tool use

**2. Auto Formatter** (`auto_format.js`)

- Automatically formats files using prettier
- Runs after Edit and Write operations
- Supports .js, .ts, .json, .md, .yaml and more

See [.claude/hooks/README.md](./.claude/hooks/README.md) for configuration details.

### Available Skills

**translation-expertise** (2,836 lines)

- Translation methodology and workflow
- Language-specific characteristics (EN/JA/CN)
- Formality levels and punctuation conventions

**engineering-terminology** (1,810 lines)

- 1,075+ technical terms across 6 domains
- Software, Web, DevOps, Data, AI/ML, Hardware
- Trilingual terminology tables (EN/JA/CN)

**document-writing** (400+ lines)

- Document types and writing conventions
- Language-specific rhetorical structures
- Tone and formatting guidelines

**web-content-fetcher** (492 lines)

- Web content extraction and parsing
- 3-tier fetching strategy
- Encoding handling (UTF-8, EUC-JP)

**claude-code-development** (comprehensive)

- Agents, skills, commands, hooks guides
- Patterns and examples
- Official best practices

**code-review** (331 lines)

- Software engineering best practices
- Security review (OWASP Top 10)
- Code quality and performance analysis
- Architecture and design principles
- Testing requirements and feedback guidelines

**javascript-testing** (1,087 lines, 3 files)

- JavaScript/Node.js testing with Vitest
- 100% code coverage strategies
- Mocking patterns (process, fs, modules, timers)
- Test organization and best practices
- Progressive disclosure (mocking-guide, coverage-strategies)

## Configuration

### Package Management

This workspace uses **pnpm** with catalog feature for dependency management.

**Adding dependencies:**

```bash
# For production dependencies
pnpm add some-package --save-catalog-name=prod

# For dev dependencies
pnpm add -D some-package --save-catalog-name=dev
```

**Catalog configuration** in `pnpm-workspace.yaml`:

- `prod`: Production dependencies (@mozilla/readability, iconv-lite, jsdom)
- `minimumReleaseAge: 10080`: Wait 7 days before using new package versions
- `packageManagerStrict: true`: Enforce pnpm usage
- `strictPeerDependencies: true`: Strict peer dependency checking

### Permissions

Workspace permissions are configured in `.claude/settings.json`:

**Allowed operations:**

- pnpm commands, git operations, python, node
- ls, dir, cd, pwd, cat, type, curl, mkdir

**Requires confirmation:**

- rm operations (file deletion)

**Denied operations:**

- npm commands (use pnpm instead)
- PowerShell, cmd, Windows admin commands
- System modification commands

Additional local permissions can be added in `.claude/settings.local.json`.
