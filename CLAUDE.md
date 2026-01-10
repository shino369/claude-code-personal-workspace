# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a personal workspace for Claude Code to assist with various daily tasks including programming, documentation, research, consultation, translation, and generative-AI development.

**Package Manager**: This workspace uses `pnpm` as the package manager. Always use `pnpm` commands instead of `npm`.

## Workspace Architecture

The workspace is designed with a structured approach to organizing outputs and configurations:

### Configuration Structure (Planned)
The repository is set up to support:
- `./CLAUDE.md` - Main memory/guidance file (this file)
- `./.claude/rules/*` - Extended rules for Claude Code behavior
- `./.claude/settings.json` - Workspace configuration
- `./.claude/agents/*` - Task-specialized subagents
- `./.claude/skills/*` - Progressively disclosed knowledge

### Output Organization

All Claude Code generated files should be placed in `output/tasks/${YYYYMMDD_task_name}/`:

```
output/
└── tasks/
    ├── 20260101_some_task/
    │   ├── reviews/
    │   │   └── REVIEW_some_task.md
    │   ├── studies/
    │   │   └── STUDIES_some_task.md
    │   └── scripts/
    │       ├── someScript.js
    │       └── some_script.py
    └── 20260102_another_task/
```

**Key conventions:**
- Task directory format: `YYYYMMDD_task_name`
- Subdirectories vary based on task nature (reviews/, studies/, scripts/, etc.)
- Choose appropriate subdirectory names that reflect the content type

## Working in This Repository

When creating new outputs:

1. **Create task directory**: Use format `output/tasks/YYYYMMDD_descriptive_name/`
2. **Organize by content type**: Create subdirectories like `reviews/`, `studies/`, `scripts/`, `docs/`, etc. based on what you're generating
3. **Use descriptive names**: File names should clearly indicate their purpose (e.g., `REVIEW_authentication_flow.md`, `analyze_data.py`)

## File Naming Conventions

- Review files: `REVIEW_*.md`
- Study/research files: `STUDIES_*.md`
- Scripts: Use appropriate extensions (`.py`, `.js`, `.sh`, etc.) with descriptive names
