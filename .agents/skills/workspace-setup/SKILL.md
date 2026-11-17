---
name: workspace-setup
description: Initialise or repair this workspace on a new machine or clone — installs dependencies, installs third-party skills from skills-lock.json (skills.sh), links .agents/skills into harness skill folders (.claude/skills), and enables the git commit hooks. Use after cloning or pulling, when a skill is missing or not found, when Codex/Claude/another harness cannot see skills, when commit hooks do not run, or when adding a project-owned skill.
---

# Workspace Setup

One command does the work; this skill tells you how to run it and how to fix what it reports.

## Layout (do not change it)

- `.agents/skills/<name>/` — the real skill files. Codex reads this folder directly.
- `.claude/skills/<name>` — a **link** to `../../.agents/skills/<name>` for Claude Code. Never edit
  files through it, and never put real folders here.
- Project-owned skills are committed. Third-party skills come from `skills-lock.json` via
  skills.sh and are git-ignored.

## Procedure

1. Check Node.js: `node --version` must be 24 or later. If `pnpm` is missing, run `corepack enable`.
2. Run setup:

   ```bash
   pnpm workspace:setup
   ```

   Options (combine as needed):

   | Need                                       | Add               |
   | ------------------------------------------ | ----------------- |
   | Browser automation (agent-browser, e2e)    | `--with-browsers` |
   | No network / skip skills.sh                | `--skip-skills`   |
   | Dependencies already installed             | `--skip-install`  |
   | Another harness reads its own skill folder | `--target <dir>`  |
   | Machine-readable output                    | `--json`          |

3. Read the output. Lines start with `✓` (ok), `!` (warning), `✗` (must fix), or `-` (skipped).
   Each `!`/`✗` line has a `Fix:` line — run exactly that command.
4. Verify: `pnpm workspace:check` must end with `Workspace check passed.` Repeat steps 3–4 until it
   does.
5. Restart the agent session so it picks up new skills.

## Troubleshooting

| Symptom                                   | Fix                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill-links: … conflict`                 | A real folder in `.claude/skills/<name>` shadows `.agents/skills/<name>`. Compare the two, keep the `.agents` copy, move the other away, re-run `pnpm skills:link`. |
| `skill-links: … legacy-copy`              | Old copied install. Run `pnpm skills:link` — it moves the copy into `.agents/skills/` and links it.                                                                 |
| `skills: not installed: …`                | Needs GitHub access. Run the printed `pnpm skills:install --only …` command when online. Skills are optional; the workspace still works.                            |
| Windows: links fail                       | The linker falls back to directory junctions automatically. If that also fails, enable Windows Developer Mode and re-run setup.                                     |
| `git-hooks: commit hooks are not enabled` | `pnpm workspace:setup` (sets `git config core.hooksPath .githooks`).                                                                                                |
| Commit rejected by `commit-msg`           | Rewrite the message as `<type>(<scope>): <description>`; see AGENTS.md → Git conventions.                                                                           |
| Commit rejected by `pre-commit`           | Run the printed `Fix:` command (prettier/eslint), `git add` the files, commit again.                                                                                |
| A harness still cannot see a skill        | Codex: skill must be in `.agents/skills/`. Claude Code: run `pnpm skills:link`, then restart. Other harness: `pnpm workspace:setup --target <its skill dir>`.       |
| `tools: … recommended but missing: …`     | Optional. Install the listed tools with the printed hints, then `pnpm tools scan`. `pnpm tools list --all` shows the rest.                                          |
| `node_modules missing` / install fails    | `corepack enable && pnpm install`. Never use `npm`.                                                                                                                 |

## Adding a project-owned skill

1. Create `.agents/skills/<name>/SKILL.md` with `name: <name>` and a `description` saying when to use it.
2. Register it in three places (a test fails if you forget one):
   - `OWNED_SKILLS` in `utils/workspace-config.js`
   - `.gitignore`: add `!/.agents/skills/<name>/`
   - `tsconfig.json` `include`: add `.agents/skills/<name>/**/*`
3. Run `pnpm skills:link`, then `pnpm check`.

## Adding a third-party skill

```bash
pnpm dlx skills add <owner/repo> --skill <name> --agent claude-code codex -y
pnpm skills:link
```

Commit `skills-lock.json` if it changed. Do not commit the skill folder.

## Never

- Never use `--copy` with skills.sh, `npm`, or `pnpm add -g`.
- Never edit files under `.claude/skills/` — edit `.agents/skills/` instead.
- Never commit third-party skill folders or anything under `tasks/` or `logs/`.
