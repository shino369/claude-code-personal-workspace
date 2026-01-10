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

Professional translation system supporting English ↔ Japanese ↔ Traditional Chinese.

**Quick Start:**

```bash
/translate --lang en "ぬるぽ ガッ"
```

See [Claude Code Trilingual Translation System](./docs/translation/README.md) for overview.
