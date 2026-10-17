---
name: security-update
description: 'Safely patch vulnerable npm/pnpm packages in this pnpm workspace. Use when a security audit (pnpm audit) reveals vulnerable packages, when a dependency has a known CVE, or when asked to update or patch a specific vulnerable package. For routine version currency (not a CVE), use the dependency-update skill.'
---

# Security Update

## Workflow

### 1. Identify Vulnerable Package

Run the audit and note the vulnerable package name, version range, which direct dependency pulls it in, and the recommended safe version:

```bash
pnpm audit
```

### 2. Check Safe Version Age (minimumReleaseAge)

Before applying any fix, verify the target version was published > 10,080 minutes ago (7 days). This guards against package hijacking / dependency confusion attacks.

> **Two enforcement layers exist.** `pnpm-workspace.yaml` already sets `minimumReleaseAge: 10080`, so `pnpm install` itself refuses to resolve any package version younger than 7 days. The script below is a complementary _pre-check_ that gives a human-readable age report **before** you write anything to the workspace file. Keep both: the script stops you writing a too-new version; the workspace setting stops you installing one. Note that `pnpm audit --fix` (Step 4a) can punch a hole in this by appending to `minimumReleaseAgeExclude` — see Step 4a.

```bash
node .claude/skills/security-update/scripts/check_release_age.mjs <package-name> <target-version>
```

**Do not proceed** if the version is younger than 10,080 minutes. Pick the next older safe version that still resolves the vulnerability.

### 3. Try Direct Parent Upgrade First

**Always attempt this before adding an override.** Upgrading the parent is cleaner and avoids override sprawl.

a. Find which direct dependency pulls in the vulnerable package:

```bash
pnpm why <vulnerable-package>
```

b. Check the current and latest version of the parent:

```bash
pnpm outdated <parent-package>
```

c. Choose the target parent version and verify its age **before** editing the catalog:

```bash
node .claude/skills/security-update/scripts/check_release_age.mjs <parent-package> <target-parent-version>
```

Do not update the catalog if the parent version is younger than 10,080 minutes. Pick an older safe parent version, or use Step 4 if no aged parent version resolves the vulnerability.

d. Determine if upgrading the parent to its latest **minor/patch** resolves the vulnerability without breaking changes:

- Check the parent's changelog/release notes for any breaking changes
- Confirm the new parent version ships with the safe sub-dep version
- The parent update must be semver-compatible (no major version bump)

e. If safe, update the parent version range in `pnpm-workspace.yaml` (the catalog section), then run:

```bash
pnpm install
```

f. Run `pnpm test:coverage` to confirm the upgraded parent introduces no runtime regressions — if tests fail, the upgrade is not safe, so fall back to Step 4. If `pnpm install` itself fails because a transitive dependency shipped by the new parent is younger than 10,080 minutes (`minimumReleaseAge` enforcement), either choose an older parent version whose transitive dep has aged past the window, or abandon the parent-upgrade path and use a pnpm override (Step 4) targeting the sub-dep directly. Otherwise proceed to **Step 5: Validate**.

### 4. Fallback: pnpm Overrides

Use only when Step 3 is not possible: the parent requires a major bump, no fix has been released in the parent, or the vulnerable package has no identifiable direct parent.

#### 4a. Use `pnpm audit --fix` as a starting point

`pnpm audit --fix` auto-writes override entries into `pnpm-workspace.yaml`. Run it, then **review and consolidate the output before proceeding** — do not treat it as a finished fix.

> **pnpm version note:** This workspace uses pnpm 12.x. `pnpm audit --fix` defaults to `--fix override`; `--fix update` re-resolves the lockfile instead of adding overrides. `-i`/`--interactive` and `--ignore-unfixable` are also available. Check `pnpm audit --help` before relying on a flag.

```bash
pnpm audit --fix
```

**Known problems with raw `--fix` output:**

- **Redundant range entries** — when multiple packages depend on different version ranges of the same dep, `--fix` writes a separate override per range (e.g. `qs@>=6.11.1 <=6.15.1: '>=6.15.2'` and `qs@<6.11.1: '>=6.11.1'`). Consolidate these into the fewest entries that still cover all vulnerable ranges.
- **Lockfile not updated** — `--fix` only writes `pnpm-workspace.yaml`. Always run `pnpm install` afterwards to apply the overrides to `pnpm-lock.yaml`.
- **Over-broad specifiers** — `--fix` sometimes writes `package: '>=safe'` without a range qualifier. Narrow these where possible to limit blast radius.
- **`minimumReleaseAgeExclude` mutation (defeats the age gate)** — because `minimumReleaseAge: 10080` is set, `--fix` automatically appends each overridden package to `minimumReleaseAgeExclude` so the install proceeds immediately, **bypassing the 7-day safety window this skill exists to enforce**. After running `--fix`, diff `pnpm-workspace.yaml` and **remove any `minimumReleaseAgeExclude` entries `--fix` added** — this workspace has no permanent exclude entries. Then run Step 2 (`check_release_age.mjs`) on every overridden version yourself before committing; do not trust `--fix` to have verified age.

After reviewing, run:

```bash
pnpm install
```

#### 4b. Manual override (when `--fix` is too noisy or wrong)

Write the entry directly in the `overrides` section of `pnpm-workspace.yaml`:

```yaml
overrides:
  vulnerable-package@<bad-range>: '^safe-version'
```

Rules:

- Use the narrowest version specifier possible (e.g. `vulnerable-package@<1.2.3` not `vulnerable-package`)
- Use a bounded target specifier so future major versions cannot resolve accidentally:
  - Prefer `^safe-version` for normal semver packages when staying within the same major is safe
  - Use `>=safe-version <next-major` when the lower bound must be explicit
  - Use an exact version when compatibility is uncertain, the package is pre-1.0, or the package does not follow semver reliably
- Check existing overrides first — do not create duplicates
- Consolidate multiple overlapping ranges for the same package into one entry where safe

> **Key quoting rule:** Wrap the key in single quotes whenever it starts with `@` (scoped package) — `@` is not a valid YAML unquoted-scalar start token, so `@babel/core@<7.29.6: ...` raises a parse error. Simple keys and keys with spaces parse fine unquoted (quoting them is harmless):
>
> ```yaml
> overrides:
>   '@babel/core@<7.29.6': '^7.29.6' # scoped — key MUST be quoted
>   js-yaml@<4.2.0: '^4.2.0' # simple — quoting optional
>   qs@>=6.11.1 <=6.15.1: '>=6.15.2 <7' # spaces — also valid unquoted
> ```

Then run:

```bash
pnpm install
```

### 4c. Lockfile handling

`pnpm-lock.yaml` is generated state. Do **not** hand-edit it as the primary fix. Change `pnpm-workspace.yaml` (catalogs/overrides) first, then let pnpm generate the lockfile:

```bash
pnpm install
```

If the install runs in a non-interactive or frozen-by-default environment, use the explicit lockfile update path:

```bash
CI=true pnpm install --no-frozen-lockfile
```

To verify the lockfile is canonical before committing, run:

```bash
CI=true pnpm install --lockfile-only --no-frozen-lockfile
CI=true pnpm install --frozen-lockfile
```

If you remove incidental lockfile noise by editing hunks, immediately rerun both commands above. If pnpm rewrites the hunk, keep pnpm's output. Only commit `pnpm-lock.yaml` when pnpm has generated or revalidated it.

### 5. Validate the Fix

Run all checks in order. Stop at the first failure and fix before continuing.

```bash
# 1. Vulnerability resolved
pnpm audit

# 2. No package / peer-dep conflicts. Do NOT pipe to grep — that swallows pnpm's
#    exit code. strictPeerDependencies:true makes a real conflict hard-fail here.
CI=true pnpm install --lockfile-only --no-frozen-lockfile  # confirm pnpm preserves/regenerates lockfile
CI=true pnpm install --frozen-lockfile  # confirm the resulting lockfile is stable

# 3. Typecheck (tsc --noEmit)
pnpm typecheck

# 4. Tests (100% coverage enforced — a failure signals a breaking change from the patch)
pnpm test:coverage

# 5. Prettier formatting check
pnpm format:check

# 6. ESLint
pnpm lint
```

> Use the project's own scripts (`pnpm lint`, not `npx eslint`): `npx` may fetch from the registry instead of using the installed binary. There is no build step in this workspace.

**ESLint regressions after patching** surface during `pnpm lint`. A common cause is that the patched package is used by ESLint itself (e.g. `@eslint/eslintrc`, `ajv`, `@typescript-eslint/*`, `eslint-plugin-*`). See [references/eslint-update-notes.md](references/eslint-update-notes.md) for resolution patterns.

### 6. Commit (only when explicitly asked)

**Do NOT commit unless the user explicitly requests it. Do NOT push or open a PR unless asked.**

If the current branch is `main`, create a feature branch first:

```bash
git checkout -b fix/security-patch-<vulnerable-package>
```

Then, when the user asks to commit:

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "fix: patch <vulnerable-package> vulnerability"
```

## Key Files in This Project

| File                  | Purpose                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml` | Catalog version ranges + `overrides` section                                                                               |
| `pnpm-lock.yaml`      | Generated lockfile. Commit it after pnpm generates/revalidates it; do not hand-edit it as the primary fix                  |
| `package.json`        | Dep names only — values are `catalog:dev`. Do NOT edit versions here; all ranges live in the `pnpm-workspace.yaml` catalog |

## Constraints

- **Never use `pnpm add` without `--save-catalog-name dev`** — all deps use the `dev` catalog
- **Do not add overrides if a parent minor/patch upgrade can resolve it**
- **Overrides block the normal resolution graph** — each one is technical debt; justify it
- **Always run `pnpm install` after `pnpm audit --fix`** — the lockfile is not updated otherwise
- **Do not trust manual `pnpm-lock.yaml` edits** — prove lockfile correctness with `CI=true pnpm install --lockfile-only --no-frozen-lockfile` and `CI=true pnpm install --frozen-lockfile`

## Resources

- `scripts/check_release_age.mjs` — verify a package version is older than 10,080 minutes using pnpm's configured registry
- `references/eslint-update-notes.md` — patterns for when patching breaks ESLint
