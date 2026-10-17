---
name: dependency-update
description: 'Dependabot-style dependency maintenance for any pnpm workspace: update packages (pnpm catalog or package.json) to safe versions and flag breaking or stale-major upgrades; bump Node/pnpm versions; review a Dependabot PR and post a verdict comment. Use when asked to update or upgrade dependencies, check outdated or major updates, bump node/pnpm versions, or review/verify a Dependabot (chore(deps)) PR. For a CVE or pnpm audit finding, use the security-update skill instead.'
---

# Dependency Update

Dependabot-style dependency maintenance for **any pnpm workspace**. Covers three tasks — pick by intent:

| The user wants to…                                      | Workflow                                  | Detail                               |
| ------------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Update / upgrade packages, check outdated, check majors | [1. Packages](#1-update-packages)         | `references/package-updates.md`      |
| Bump Node / pnpm version                                | [2. Runtime](#2-update-runtime-versions)  | `references/runtime-versions.md`     |
| Review / verify a Dependabot PR, comment a verdict      | [3. PR review](#3-review-a-dependabot-pr) | `references/dependabot-pr-review.md` |

**Routing:** this skill handles **version currency**. For a **vulnerability / CVE / `pnpm audit`
finding**, use the `security-update` skill instead — it owns the audit → `overrides` flow.

## Discover the project first — never assume

This skill is **settings-agnostic**: discover how _this_ project is configured before acting. The
analyzer and the verification pipeline both adapt to what you find.

- **Where versions live** — read `pnpm-workspace.yaml`. If it defines `catalog:` / `catalogs:`,
  versions live there and `package.json` references them as `catalog:<name>`. Otherwise versions are
  plain ranges in `package.json`. `analyze_deps.mjs` handles **both** automatically.
- **Safety policy the project enforces** — check `pnpm-workspace.yaml` (and `.npmrc`) for any of:
  - `minimumReleaseAge` (+ `minimumReleaseAgeExclude`) — a release cooldown; if set, `pnpm install`
    refuses versions younger than it. The analyzer reads and reports this; don't hardcode a number.
  - `strictPeerDependencies` — if `true`, install **hard-fails** on peer conflicts.
  - `engineStrict` + `engines` — if `true`, install fails below the required Node/pnpm.
  - `packageManagerStrict` (pnpm ≤11) — if `true`, pnpm refuses to run when `package.json`'s
    `packageManager` field does not match the running version. pnpm 12 enforces the field directly.
  - `overrides` — pins for transitive deps (usually security; leave to the security-update flow).
- **Verification scripts** — read `package.json` `scripts` and map the [pipeline](#verification-pipeline)
  to whatever names exist (`typecheck`/`tsc`/`compile`, `test`, `lint`, `format`, `build`).
- **Automation + repo** — `.github/dependabot.yml` or `renovate.json` (grouping, ignored majors,
  rebase strategy); `gh repo view --json nameWithOwner` for the current repo.
- **Runtime version files** (task 2) — which of `.nvmrc`, `.node-version`, `.tool-versions`,
  `mise.toml`, `pnpm-workspace.yaml` (`nodeVersion`), `package.json` (`engines`, `packageManager`,
  `volta`), `Dockerfile*`, or CI workflows this project actually uses.

### This workspace

- Versions live in the `dev` catalog in `pnpm-workspace.yaml`; `package.json` uses `catalog:dev`.
- `minimumReleaseAge: 10080` (7 days), `strictPeerDependencies: true`,
  `engineStrict: true`, `allowBuilds` for esbuild, and a security `overrides` list are set.
- `package.json` pins pnpm 12.14.0 via `packageManager`; `engines.pnpm` requires it. Use
  `corepack pnpm` (or enable Corepack) before running commands.
- Verification scripts: `pnpm typecheck`, `pnpm test:coverage`, `pnpm lint`,
  `pnpm format:check`. There is no build step and no Docker.

**Never hand-edit `pnpm-lock.yaml`** — it is generated. Change the manifest/catalog, then let pnpm
write it.

## Run the analyzer

This skill bundles `scripts/analyze_deps.mjs` (dependency-free Node). Run it with Node from the
project root:

```bash
node .claude/skills/dependency-update/scripts/analyze_deps.mjs [package] [--catalog <name>] [--json] [--stale-months 12]
```

It discovers catalogs + `package.json` deps + the cooldown policy, then labels each package and prints
ready-to-paste target ranges:

- `UP_TO_DATE` · `MINOR_PATCH` (safe) · `MAJOR` (breaking) · `STALE_MAJOR` (in-major ceiling
  unmaintained > `--stale-months` **and** a newer major exists — the "`8.8.1` is a year old but
  `9.x` shipped" signal) · `ERROR`.
- Flags below-cooldown targets and notes when a newer major also exists. Exit code `3` = a
  `MAJOR`/`STALE_MAJOR` decision is pending. Use `--json` to consume it programmatically.

## 1. Update packages

Take the `MINOR_PATCH` list from the analyzer → bump those ranges where the project keeps them (the
catalog in `pnpm-workspace.yaml`, or `package.json`) → regenerate the lockfile → run the
[verification pipeline](#verification-pipeline) → regression-check. **`MAJOR`/`STALE_MAJOR` are
breaking: warn the user with the specific breaking changes and get explicit permission first.** If the
project sets `strictPeerDependencies`, a peer conflict will hard-fail install — resolve by bumping the
dependant, adding a `packageExtensions` entry, or holding the update.

→ Full detail (semver tiers, cooldown, peer-conflict resolution, stale-major migration flow):
**`references/package-updates.md`**

## 2. Update runtime versions

A runtime version (Node, pnpm) is usually **duplicated across several files**. Discover every copy
first, then move them together. Bumping pnpm's `packageManager` field means regenerating its integrity
hash with `corepack use pnpm@<version>`. Node/pnpm **majors** are breaking → permission first.

→ Version-location discovery, hash regeneration, and verification:
**`references/runtime-versions.md`**

## 3. Review a Dependabot PR

Inspect with `gh pr view`, check out the branch, run the [verification pipeline](#verification-pipeline)
locally (actually install + test — don't just eyeball the diff), commit **resolvable** fixes to the
PR branch, then post a **verdict as a comment** — never `--approve`/`--request-changes`.

→ Commands, the rebase caveat, and the verdict comment template:
**`references/dependabot-pr-review.md`**

## Verification pipeline

The canonical checks, shared by all three workflows. **Discover the actual script names from
`package.json` first**, then run the equivalents **in order; stop at the first failure and fix before
continuing.** Not every project defines every step — run those that exist.

```bash
# 1. Lockfile matches the manifest. If --frozen fails, regenerate with
#    `CI=true pnpm install --no-frozen-lockfile` (that itself may be the fix to commit), then re-run.
CI=true pnpm install --frozen-lockfile
pnpm run typecheck   # whatever the project calls it: typecheck / tsc / compile
pnpm test            # note any coverage threshold the project enforces
pnpm run lint
pnpm run format      # if defined (e.g. prettier --check)
pnpm audit           # no new advisories introduced
```

> Prefer the project's own scripts (`pnpm run <script>`) over ad-hoc tool invocations, so you use the
> installed binary and the project's config. In this workspace use `pnpm typecheck`,
> `pnpm test:coverage`, `pnpm lint`, and `pnpm format:check`; there is no build step.

## Constraints

- **Breaking changes (any major, Node/pnpm major) require explicit user permission** — warn with the
  specific breaking changes first; never bump silently.
- **Respect the project's `minimumReleaseAge`** if set — pick a version older than the cooldown; do
  not extend `minimumReleaseAgeExclude` to force a newer one. The analyzer reports each target's age.
- **Edit where the project keeps versions** (catalog or `package.json`); **never hand-edit
  `pnpm-lock.yaml`.**
- **Adding a brand-new package** (not a bump) may require the project's dependency-approval process.
  Check `CLAUDE.md` / contributing docs first. In a catalog project add via
  `pnpm add <pkg> --save-catalog-name <name>` (`dev` in this workspace).
- **Committing:** for tasks 1 & 2, only commit when the user asks (branch off the default branch
  first). For a Dependabot PR (task 3), committing resolvable fixes to the PR branch is part of the job.
- **Dependabot PR verdict = a comment**, not an approve/reject.

## Resources

- `scripts/analyze_deps.mjs` — discover + classify dependencies vs the registry (up-to-date /
  minor-patch / major / stale-major); the starting point for tasks 1 and 3.
- `references/package-updates.md` — semver tiers, cooldown, peer-conflict resolution, the stale-major
  migration flow with permission gating.
- `references/runtime-versions.md` — discovering Node/pnpm version copies, `packageManager`
  hash regeneration, drift reconciliation.
- `references/dependabot-pr-review.md` — `gh`/`git` PR review flow, committing fixes to the branch,
  the verdict comment template.
