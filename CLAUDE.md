# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a personal workspace for Claude Code to assist with various daily tasks including programming, documentation, research, consultation, translation, and generative-AI development.

**Package Manager**: This workspace uses `pnpm` as the package manager. Always use `pnpm` commands instead of `npm`.

## Context Management

**Why Context Management Matters**: Claude Code has a 200K token context window, but quality degrades at 20-40% usage. Managing context prevents degraded outputs and keeps conversations focused.

**Best Practices:**

1. **Scope conversations per feature** - One conversation per task/feature prevents context bleeding. Don't build auth and refactor database in the same session.

2. **Use external memory** - Write plans and progress to `SCRATCHPAD.md` or `plan.md` at the root. These persist across sessions, allowing fresh context with preserved knowledge.

3. **The copy-paste reset** - When context gets bloated:
   - Copy important info from terminal
   - Run `/compact` to summarize
   - Run `/clear` to wipe context
   - Paste back only what matters

4. **Know when to clear** - If explaining the same thing 3+ times, `/clear` and reframe. Fresh context > fighting through degraded context.

5. **Use plan mode proactively** - Press `Shift+Tab` twice before complex tasks. Planning with fresh context produces dramatically better results than iterating through confusion.

**External Memory Files:**

- `SCRATCHPAD.md` - Temporary notes, findings, progress tracking
- `plan.md` - Architecture decisions, implementation plans
- `output/tasks/<YYYYMMDD_task_name>/NOTES.md` - Task-specific notes

**Model Selection: important! use inherit model from the main session**

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

- `trilingual-translator` - Multi-stage translation agent with 3 roles
- `security-reviewer` - Security vulnerability review
- `test-runner` - Test execution and reporting

**Skills:**

- `translation-expertise` - Translation methodology (2,836 lines, 6 files)
- `engineering-terminology` - Technical terms (1,810 lines, 7 files, 1,075+ terms)
- `document-writing` - Writing conventions (400+ lines)
- `web-content-fetcher` - Web content extraction (492 lines)
- `claude-code-development` - Claude Code components guide (comprehensive)
- `code-review` - Software engineering best practices for code review (331 lines)
- `javascript-testing` - JavaScript/Node.js testing with Vitest (1,087 lines, 3 files)
- `commit-messages` - Conventional commits standard
- `context-manager` - Proactive context window management

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

### Subagents System

**Why Subagents Matter**: Each subagent gets its own 200K context window. This prevents context pollution when handling complex subtasks - the main conversation only holds summaries, not full exploration history.

**Built-in Subagents:**

- **Explore** - Fast, read-only agent for searching/analyzing codebases without making changes
- **Plan** - Research agent for gathering context before presenting implementation plans
- **General-purpose** - Capable agent for complex, multi-step tasks requiring both exploration and action

**Custom Subagents:**

- `trilingual-translator` - Multi-stage translation with 3 roles (Initial → Proofread → Refine)
- `security-reviewer` - Reviews code for security vulnerabilities
- `test-runner` - Runs tests and reports results in clean format

**How Subagents Work:**

1. Main agent identifies task suitable for delegation
2. Subagent executes in isolated context
3. Subagent returns summary to main agent
4. Main context stays clean

**Pattern for Large Refactoring**: Identify all files needing changes, spin up subagent for each logical group, synthesize summaries. Main agent never holds full context of every file simultaneously.

Run `/agents` to see all available subagents.

## Package Management

This workspace uses **pnpm** with the catalog feature.

**Adding dependencies:**

```bash
# Production dependencies
pnpm add package-name --save-catalog-name=prod

# Development dependencies
pnpm add -D package-name --save-catalog-name=dev
```

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

## Additional Documentation

**External Memory Templates:**

- `SCRATCHPAD.md` - Temporary session notes and progress tracking
- `plan.md` - Architecture decisions and implementation plans

**Skills for Common Tasks:**

- Use `commit-messages` skill when creating commits
- Use `context-manager` skill when context approaches 20-40% or quality degrades
- Use `security-reviewer` agent for security audits
- Use `test-runner` agent to execute tests and report results

**Quick Reference:**

- Context degradation starts at 20-40%, not 100% - manage proactively
- Use plan mode (`Shift+Tab` twice) before complex implementations
- Delegate to subagents to keep main context clean
- External memory (SCRATCHPAD.md, plan.md) persists across sessions
- `/clear` without hesitation - fresh context beats degraded context
