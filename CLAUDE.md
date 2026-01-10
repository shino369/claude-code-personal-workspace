# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a personal workspace for Claude Code to assist with various daily tasks including programming, documentation, research, consultation, translation, and generative-AI development.

**Package Manager**: This workspace uses `pnpm` as the package manager. Always use `pnpm` commands instead of `npm`.

## Workspace Architecture

The workspace is designed with a structured approach to organizing outputs and configurations:

### Configuration Structure

The repository has the following implemented structure:

- `./CLAUDE.md` - Main memory/guidance file (this file)
- `./.claude/rules/*` - Extended rules for Claude Code behavior (2 rules)
- `./.claude/settings.json` - Workspace configuration (permissions, hooks, attribution)
- `./.claude/agents/*` - Task-specialized subagents (trilingual-translator)
- `./.claude/skills/*` - Progressively disclosed knowledge (7 skills)
- `./.claude/hooks/*` - Claude Code hooks (audit_logger, auto_format)
- `./.claude/commands/*` - Slash commands (/translate)

**Implemented Components:**

**Agents:**

- `trilingual-translator.md` - Multi-stage translation agent with 3 roles

**Skills:**

- `translation-expertise` - Translation methodology (2,836 lines, 6 files)
- `engineering-terminology` - Technical terms (1,810 lines, 7 files, 1,075+ terms)
- `document-writing` - Writing conventions (400+ lines)
- `web-content-fetcher` - Web content extraction (492 lines)
- `claude-code-development` - Claude Code components guide (comprehensive)
- `code-review` - Software engineering best practices for code review (331 lines)
- `javascript-testing` - JavaScript/Node.js testing with Vitest (1,087 lines, 3 files)

**Commands:**

- `/translate` - Trilingual translation with file/URL support

**Hooks:**

- `audit_logger.js` - Logs all tool usage to /logs/
- `auto_format.js` - Auto-formats files using prettier

**Settings:**

- Permission system (allow/ask/deny patterns)
- Hook configuration (PostToolUse events)
- Attribution for commits and PRs

### Output Organization

All Claude Code generated files should be placed in `output/tasks/<YYYYMMDD_task_name>/`:

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

**Key conventions:**

- Task directory format: `YYYYMMDD_task_name`
- Subdirectories vary based on task nature (reviews/, studies/, scripts/, etc.)
- Choose appropriate subdirectory names that reflect the content type

## Available Systems

### Trilingual Translation System

Use `/translate` command for professional English ↔ Japanese ↔ Traditional Chinese translation.

**Features:**

- Three-stage workflow (Initial → Proofread → Refine)
- File and URL translation support
- 1,075+ technical terms across 6 engineering domains
- Automatic encoding detection

**Quick Start:**

```bash
/translate --lang en "ぬるぽ ガッ"
/translate --lang ja @README.md
/translate --lang cn --url https://example.com/article
```

See `docs/translation/README.md` for complete documentation.

### Claude Code Development

Use the `claude-code-development` skill when creating or modifying Claude Code components:

- Agents (subagents)
- Skills (progressively disclosed knowledge)
- Commands (slash commands)
- Hooks (automation)

This skill provides expert guidance and best practices for extending this workspace.

### Hooks System

**Audit Logger** (`audit_logger.js`)

- Automatically logs all tool usage
- Output: `/logs/<YYYYMMDD>/logging.json`
- Useful for reviewing work history

**Auto Formatter** (`auto_format.js`)

- Automatically formats files using prettier
- Triggers after Edit and Write operations
- Supports .js, .ts, .json, .md, .yaml, etc.

## Package Management

This workspace uses **pnpm** with the catalog feature.

**Adding dependencies:**

```bash
# Production dependencies
pnpm add package-name --save-catalog-name=prod

# Development dependencies
pnpm add -D package-name --save-catalog-name=dev
```

**Catalog benefits:**

- Centralized version management in `pnpm-workspace.yaml`
- 7-day minimum release age for stability
- Strict package manager enforcement (no npm)
- Consistent dependencies across workspace

## Working in This Repository

When creating new outputs:

1. **Create task directory**: Use format `output/tasks/YYYYMMDD_descriptive_name/`
2. **Organize by content type**: Create subdirectories like `reviews/`, `studies/`, `scripts/`, `docs/`, etc. based on what you're generating
3. **Use descriptive names**: File names should clearly indicate their purpose (e.g., `REVIEW_authentication_flow.md`, `analyze_data.py`)
4. **Use node.js for scripts**: This is a pnpm workspace, prefer node.js over other languages when creating scripts
5. **Leverage available skills**: Use translation, engineering-terminology, document-writing skills when relevant

## File Naming Conventions

- Review files: `REVIEW_*.md`
- Study/research files: `STUDIES_*.md`
- Scripts: Use appropriate extensions (`.py`, `.js`, `.sh`, etc.) with descriptive names
