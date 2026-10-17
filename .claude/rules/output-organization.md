# Output Organization

Place generated files in `output/tasks/<YYYYMMDD_task_name>/`:

```
output/
└── tasks/
    ├── 20260101_some_task/
    │   ├── reviews/
    │   │   └── REVIEW_some_task.md
    │   ├── studies/
    │   │   └── STUDIES_some_task.md
    │   ├── scripts/
    │   │   └── some_script.js
    │   └── ...
    └── 20260102_another_task/
```

**Conventions**:

- Task directory: `YYYYMMDD_task_name` (descriptive snake_case name)
- Subdirectories by content type: `reviews/`, `studies/`, `scripts/`, `docs/`, `translated/`, `tmp/`
- File names should make the purpose obvious:
  - Reviews: `REVIEW_*.md`
  - Studies/research: `STUDIES_*.md`
  - Scripts: descriptive name with the appropriate extension (`.js`, `.mjs`, `.py`, `.sh`)
- Temporary/intermediate files go in the task's `tmp/` subdirectory, not the repository root.
- Cross-session notes belong in `SCRATCHPAD.md` or `plan.md` at the repository root.

Do not create summary/completion documents unless the user asks for them — the conversation, git history, and the files above are the record.
