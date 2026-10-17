# Git Conventions

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`

**Types**:

- `feat` — new feature
- `fix` — bug fix
- `refactor` — change that neither fixes a bug nor adds a feature
- `docs` — documentation only
- `test` — adding or updating tests
- `chore` — build process, tooling, dependencies
- `style` — formatting, missing semicolons (not CSS)
- `perf` — performance improvement
- `ci` — CI/CD configuration
- `build` — build system or external dependencies

**Scope** (optional): `hooks`, `skills`, `rules`, `config`, `docs`, `deps`, `tests`.

**Description**: imperative mood, lowercase, no trailing period, 50 characters or fewer.

**Body** (optional): blank line after the description, wrapped at 72 characters. Explain **why**, not what.

**Footer** (optional): `Closes #123`, `Refs #456`, or `BREAKING CHANGE: ...`.

**Examples**:

```
feat(hooks): add context monitor warning
fix(skills): handle missing transcript in context monitor
refactor(rules): move commit conventions out of a skill
chore(deps): bump vitest to 4.0.16
docs: explain the output directory layout
```

**Anti-patterns**:

- `WIP`, `fix bug`, `update files` — not descriptive
- `Added feature` — past tense
- `Add feature.` — capitalized and trailing period

Do not add attribution lines unless the user asks; this workspace leaves them out.

## Branches

Pattern: `<type>/<brief-description>`, using the same types as commits.

Examples: `feat/context-monitor`, `fix/module-runner-relative-path`, `chore/pnpm-config`.

## Pull Requests

Use the same `<type>: <description>` format for the title. Include:

- **What** changed and **why**
- **How to verify** (commands run, manual checks)
- Any breaking changes or follow-up work
