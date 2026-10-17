# Task Organization

Place generated files in `tasks/<task-name-yymmdd>/` at the repository root:

```
tasks/
└── some-task-260101/
    ├── plan.md
    ├── NOTES.md
    ├── reviews/
    │   └── REVIEW_some-task.md
    ├── studies/
    │   └── STUDIES_some-task.md
    ├── scripts/
    │   └── some-script.js
    └── ...
```

**Conventions**:

- Task directory: `<task-name>-<yymmdd>` — a descriptive kebab-case name followed by the
  two-digit year, month, and day (e.g. `translate-x-post-260111`).
- Subdirectories by content type: `reviews/`, `studies/`, `scripts/`, `docs/`, `translated/`,
  `tmp/`.
- File names should make the purpose obvious:
  - Reviews: `REVIEW_<task-name>.md`
  - Studies/research: `STUDIES_<task-name>.md`
  - Scripts: descriptive name with the appropriate extension (`.js`, `.mjs`, `.py`, `.sh`)
- Temporary/intermediate files go in the task's `tmp/` subdirectory, not the repository root.
- `plan.md` and `NOTES.md` live in the task directory and are the cross-session memory; there are
  no repository-root scratch files.

Do not create summary/completion documents unless the user asks for them — the conversation, git
history, and the files above are the record.
