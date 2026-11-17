# Reviewing a Dependabot PR

Deep guidance for **use case 3**: verifying a Dependabot PR locally, committing resolvable fixes to
its branch, and posting a **verdict as a comment** (never an approve/reject).

All GitHub interaction uses the `gh` CLI. `gh pr` commands default to the current repository's remote,
so `--repo` is optional — pass a PR number, or a full PR URL to target another repo. Discover the
current repo if useful: `gh repo view --json nameWithOwner`.

## Contents

1. [Inspect the PR](#1-inspect-the-pr)
2. [Check out the branch locally](#2-check-out-the-branch-locally)
3. [Verify locally](#3-verify-locally)
4. [Commit resolvable fixes to the PR branch](#4-commit-resolvable-fixes-to-the-pr-branch)
5. [Post the verdict as a comment](#5-post-the-verdict-as-a-comment)

## 1. Inspect the PR

```bash
gh pr view <n-or-url> --json number,title,state,author,labels,additions,deletions,files
```

Identify the ecosystem from the title/labels/files:

- **npm / packages** (e.g. `chore(deps) ... bump the … group`) → edits where versions live
  (`pnpm-workspace.yaml` catalog and/or `package.json`) + `pnpm-lock.yaml`. Entries are usually
  **minor/patch** (Dependabot typically ignores majors).
- **docker** (e.g. `chore(docker) ... bump node`) → edits a `Dockerfile` base tag only. This is the
  drift trigger — see `runtime-versions.md`; other copies of the version (engines, `nodeVersion`, CI)
  will need reconciling.

See just the meaningful hunk (skip the huge lockfile diff):

```bash
gh pr diff <n-or-url> | \
  awk '/^diff --git.*(pnpm-workspace\.yaml|package\.json)/{f=1}
       /^diff --git/ && $0 !~ /(pnpm-workspace\.yaml|package\.json)/{if(f)exit} f'
gh pr diff <n-or-url> -- Dockerfile          # for a docker PR
```

## 2. Check out the branch locally

Ensure a **clean working tree first** (commit or stash unrelated local changes) — a dirty tree, or
`engineStrict`, can block checkout.

```bash
git stash --include-untracked    # if needed
gh pr checkout <n-or-url>
```

## 3. Verify locally

The goal of "verify the new package locally" is to actually install and exercise the pipeline, not to
eyeball the diff. Discover the project's script names first (see `SKILL.md`), then:

```bash
# 1. Confirm the committed lockfile matches the manifest in the PR (frozen = no drift allowed).
CI=true pnpm install --frozen-lockfile

# 2. Full pipeline — stop at the first failure (use the project's actual script names).
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build

# 3. Security posture didn't regress (ideally improved).
pnpm audit
```

Then sanity-check the bumps themselves with the bundled analyzer (invocation in `SKILL.md`):

```bash
node <skill-dir>/scripts/analyze_deps.mjs           # whole project
```

Watch for:

- **`--frozen-lockfile` fails** → the lockfile is out of sync with the manifest. Regenerate (step 4).
- **Cooldown rejection** → if the project sets `minimumReleaseAge`, Dependabot may have proposed a
  version younger than it and `pnpm install` refuses it. A legitimate blocker — the version must age
  or the bump be dropped.
- **Peer-dependency hard-fail** (when `strictPeerDependencies` is set) → resolve per
  `package-updates.md`.
- **docker PR** → reconcile the drifted Node copies and run `docker build .`.

## 4. Commit resolvable fixes to the PR branch

If a problem is **clearly resolvable and in scope**, fix it and commit to the PR branch:

```bash
# Common fix: lockfile drift
CI=true pnpm install --no-frozen-lockfile
CI=true pnpm install --frozen-lockfile   # re-confirm it's now canonical

git add pnpm-workspace.yaml pnpm-lock.yaml   # or package.json / Dockerfile — whatever you changed
git commit -m "chore(deps): resolve <peer conflict|lockfile drift|drift reconcile> for dependabot bump"
git push
```

Guidance:

- **Only commit fixes you are confident are correct.** For anything ambiguous (a failing test that may
  be a real behavioral regression, a needed major bump, a too-new version), do **not** commit a
  workaround — report it in the verdict instead.
- **Rebase caveat:** if the project's `.github/dependabot.yml` sets `rebase-strategy: auto` (check it),
  a later Dependabot rebase can discard your pushed commit. Call out in your comment that manual fixes
  were pushed so a maintainer merges before the next Dependabot run, and avoid triggering a rebase
  (e.g. don't comment `@dependabot rebase`).
- Restore any stash afterward: `git stash pop`.

## 5. Post the verdict as a comment

**Comment only — do not `gh pr review --approve` or `--request-changes`.** The verdict is a
recommendation for a human to act on.

```bash
gh pr comment <n-or-url> --body "$(cat <<'EOF'
### 🤖 Dependency review — verdict

**Verified locally** on the PR branch:

- `pnpm install --frozen-lockfile` — <pass/fail>
- typecheck — <pass/fail>
- tests — <pass/fail (+ coverage if enforced)>
- lint / format — <pass/fail>
- build — <pass/fail>
- `pnpm audit` — <no new advisories / N resolved>

**Scope:** <N packages, all minor/patch> · <any newer-major notes from analyze_deps> · <docker: version copies reconciled Y/N>

**Fixes pushed:** <none / describe commit(s)>

**Remaining risks / blockers:** <none / e.g. `<pkg>` target is below the release cooldown / a real test regression in X>

**Recommendation:** <✅ Safe to merge / ⚠️ Merge after addressing the above / ⛔ Hold — needs manual decision>
EOF
)"
```

Fill every `<...>` with the actual result. Keep it factual: if a step was skipped (e.g. Docker
unavailable), say so rather than implying it passed.
