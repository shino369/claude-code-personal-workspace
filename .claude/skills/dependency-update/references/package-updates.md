# Package Updates (Dependabot-style)

Deep guidance for **use case 1**: keeping dependencies current, resolving peer/conflict issues, and
deciding when a major/stale-major migration is warranted. Applies to any pnpm workspace — discover
the project's settings; do not assume them.

> This covers **version currency**. For fixing a **known vulnerability / CVE / `pnpm audit`
> finding**, use the `security-update` skill (it owns the audit → `overrides` flow). They overlap on
> the manifest and the verification pipeline; they differ in intent.

## Contents

1. [Where versions live](#where-versions-live)
2. [Semver tiers — what is safe](#semver-tiers--what-is-safe)
3. [Step-by-step: safe minor/patch updates](#step-by-step-safe-minorpatch-updates)
4. [The release cooldown (minimumReleaseAge)](#the-release-cooldown-minimumreleaseage)
5. [Resolving peer-dependency conflicts](#resolving-peer-dependency-conflicts)
6. [Major & stale-major migrations (requires user permission)](#major--stale-major-migrations-requires-user-permission)
7. [Regression check](#regression-check)
8. [Commit](#commit)

## Where versions live

Discover this first by reading `pnpm-workspace.yaml` and `package.json`:

- **Catalog workspace** — if `pnpm-workspace.yaml` defines `catalog:` / `catalogs:`, the version
  ranges live there and `package.json` references them as `catalog:<name>`. **Edit the catalog, not
  `package.json`.**
- **Plain workspace** — otherwise version ranges are direct in `package.json`
  (`dependencies` / `devDependencies`). Edit them there.

The bundled `analyze_deps.mjs` (invocation in `SKILL.md`) discovers both and prints ready-to-paste
targets, so you rarely need to hand-inspect. If the project uses Dependabot/Renovate, it typically
opens grouped minor/patch PRs and ignores majors — so **majors and stale-majors are the manual work**
this skill assists with.

## Semver tiers — what is safe

| Tier                       | Example            | Safe to apply automatically?                     |
| -------------------------- | ------------------ | ------------------------------------------------ |
| patch                      | `1.2.3 → 1.2.4`    | Yes                                              |
| minor (same major)         | `1.2.3 → 1.5.0`    | Yes (semver: no breaking changes)                |
| major                      | `1.x → 2.0.0`      | **No — needs explicit user permission**          |
| `0.x` minor                | `0.4.0 → 0.5.0`    | Treat as potentially breaking; read the notes    |
| prerelease pin (`-beta.x`) | `5.0.0-beta.29→31` | Yes within the same prerelease line, but re-test |

`analyze_deps.mjs` labels each package `UP_TO_DATE` / `MINOR_PATCH` / `MAJOR` / `STALE_MAJOR`, flags
targets below the project's cooldown, and notes when a newer major also exists. Exit code `3` means at
least one `MAJOR`/`STALE_MAJOR` decision is pending.

## Step-by-step: safe minor/patch updates

1. **Analyze** — run `analyze_deps.mjs` and take the `MINOR_PATCH` list.
2. **Edit where versions live** — bump each range (in the catalog or `package.json`), preserving the
   existing operator (`^` stays `^`, a pinned value stays pinned). The analyzer prints a ready-to-paste
   `→ ^target`. Skip any row flagged below-cooldown (see next section) unless the package is exempt —
   pick the newest version that has aged past the cooldown instead.
3. **Confirm target age** if in doubt — the analyzer already reports each target's age; to check an
   arbitrary version directly: `pnpm view <pkg> time.<version>`.
4. **Regenerate the lockfile**:
   ```bash
   CI=true pnpm install --no-frozen-lockfile
   ```
   Do **not** hand-edit `pnpm-lock.yaml`. If install fails on peer deps, see the section below.
5. **Verify** — run the verification pipeline (defined in `SKILL.md`). Stop at the first failure.
6. **Confirm the lockfile is canonical** before committing:
   ```bash
   CI=true pnpm install --lockfile-only --no-frozen-lockfile
   CI=true pnpm install --frozen-lockfile
   ```

## The release cooldown (minimumReleaseAge)

Some pnpm projects set `minimumReleaseAge` in `pnpm-workspace.yaml` — a supply-chain guard that makes
`pnpm install` **refuse to resolve any version younger than that many minutes**. **Discover whether it
is set and to what value; do not assume one.** When set:

- A brand-new release cannot be installed until it has aged past the threshold. The analyzer reads the
  configured value and flags targets younger than it. Either wait, or select an older version.
- `minimumReleaseAgeExclude` lists packages exempt from the cooldown. **Do not add packages to this
  list** to force a too-new version through — that defeats the guard.

If the project does not set `minimumReleaseAge`, there is no cooldown to respect (the analyzer reports
`not set`).

## Resolving peer-dependency conflicts

If the project sets `strictPeerDependencies: true` (check `pnpm-workspace.yaml` / `.npmrc`),
`pnpm install` **hard-fails** on an unmet or conflicting peer instead of warning — the most common
reason a minor/patch bump breaks install. Resolve in this order:

1. **Find the conflict source**:
   ```bash
   pnpm why <package>
   ```
   Read the error: it names the dependant, the peer it requires, and the version actually installed.
2. **Prefer bumping the dependant** so its peer requirement is satisfied by the installed version —
   the clean fix that keeps the graph honest.
3. **`packageExtensions`** — if a package declares an overly-strict or incorrect peer (common in the
   React `@types/*` ecosystem), relax it via `packageExtensions` in `pnpm-workspace.yaml`. Add the
   minimum needed; document why.
4. **`overrides`** — force a transitive peer to a compatible version only when 2–3 are impossible.
   Each override is technical debt; keep the specifier narrow. (Quote scoped keys in YAML —
   `'@scope/pkg@<range>'` — since a leading `@` is not a valid unquoted scalar.)
5. **Hold the update** — if none of the above is safe, leave the package as-is and report why. A
   blocked update is a valid outcome; a broken install is not.

## Major & stale-major migrations (requires user permission)

The analyzer flags two breaking situations:

- **`MAJOR`** — a newer major exists while the current major still receives releases.
- **`STALE_MAJOR`** — the current-major ceiling has had **no release in > `--stale-months`** (default 12) **and** a newer major exists. This is the "current `8.8.1`, no newer `8.x`, but `9.x` shipped"
  signal — the current line is likely unmaintained/EOL, so staying put carries its own risk (no future
  fixes).

**Never apply a major bump without explicit user permission.** Follow this flow:

1. **Investigate** the target major: read its CHANGELOG / migration guide / release notes. Identify
   concrete breaking changes that touch this codebase (removed APIs, renamed exports, config changes,
   runtime-version requirements).
2. **Warn and ask.** Present concisely: package, current → target major; for `STALE_MAJOR`, how long
   the current line has been stale (the analyzer prints `[Nd old]`); the specific breaking changes and
   what they impact here; an effort/risk estimate. Then **ask for explicit approval before editing.**
3. **Only on approval:** migrate on a dedicated branch (`<type>/upgrade-<pkg>-vN`), follow the official
   migration guide, apply required codemods, then run the full verification pipeline and a regression
   check. If it cannot be made green within scope, stop and report — do not force it.

> **Adding a new package** (not just a bump) may require the project's dependency-approval process —
> some monorepos require landing it in a base/shared repo first. Check the project docs
> (`AGENTS.md` / `CLAUDE.md` / contributing guide) before running
> `pnpm add <pkg> [--save-catalog-name <name>]`.

## Regression check

Beyond the pipeline passing, confirm no behavioral regression from the bumped packages:

- Diff what actually changed: `pnpm why <pkg>` and the lockfile diff (`git diff pnpm-lock.yaml`).
- For UI/interaction or runtime-behavior libraries, sanity-check the affected flows — a build plus a
  quick dev smoke of impacted screens, or the relevant test suites. Respect any coverage threshold the
  project enforces; a coverage or test drop is a red flag.
- Note any runtime-behavior change in the PR description even when tests pass.

## Commit

Only commit when the user asks. If on the default branch, branch first (discover it with
`git symbolic-ref --short refs/remotes/origin/HEAD`). Match the project's commit convention — a
Dependabot-style project uses:

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml   # or package.json, wherever you edited
git commit -m "chore(deps): bump <summary of packages>"
```
