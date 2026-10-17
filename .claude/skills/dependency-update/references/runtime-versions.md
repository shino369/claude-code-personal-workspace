# Runtime Versions (Node / pnpm / Docker)

Deep guidance for **use case 2**: bumping the Node.js, pnpm, and Docker base-image versions — and
keeping every duplicated copy of each version in sync, which Dependabot does **not** do. Discover
which files a given project uses; the exact set varies.

## Contents

1. [Discover where each version lives](#discover-where-each-version-lives)
2. [The drift problem](#the-drift-problem)
3. [Bump Node (minor/patch)](#bump-node-minorpatch)
4. [Bump Node (major — requires permission)](#bump-node-major--requires-permission)
5. [Bump pnpm (regenerate the packageManager hash)](#bump-pnpm-regenerate-the-packagemanager-hash)
6. [Bump the Docker base image](#bump-the-docker-base-image)
7. [Verification](#verification)

## Discover where each version lives

A runtime version is usually declared in more than one file. **Find every copy before changing
anything** — start with a sweep:

```bash
# Node, pnpm, and image versions across the files that commonly hold them:
grep -RnE 'node[:@]?[0-9]|nodeVersion|useNodeVersion|"node"|"pnpm"|packageManager|pnpm@[0-9]|FROM .*node' \
  .nvmrc .node-version .tool-versions mise.toml pnpm-workspace.yaml package.json Dockerfile* \
  .github/workflows .github/dependabot.yml 2>/dev/null
```

Common locations to reconcile (only some will exist in a given project):

| Runtime         | Where it may appear                                                                      |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Node**        | `.nvmrc`, `.node-version`, `.tool-versions`, `mise.toml`                                 |
| **Node**        | `pnpm-workspace.yaml` → `nodeVersion:` (or `useNodeVersion:`)                            |
| **Node**        | `package.json` → `engines.node`, and/or `volta.node`                                     |
| **Node**        | `Dockerfile*` → `FROM node:<tag>` base image; CI workflow `node-version:`                |
| **pnpm**        | `package.json` → `packageManager` (**carries a SHA-512 integrity hash**), `engines.pnpm` |
| **pnpm**        | `Dockerfile*` → any `npm i -g pnpm@<v>` / `corepack prepare pnpm@<v>` line               |
| **Docker base** | `Dockerfile*` → the `node:<tag>` image tag                                               |

Do **not** create a version file (e.g. `.nvmrc`) that the project doesn't already have unless asked —
it becomes one more copy to keep in sync.

## The drift problem

Dependabot's `docker` ecosystem edits **only the `Dockerfile`**. It does not touch `nodeVersion` in
`pnpm-workspace.yaml`, `engines.node` in `package.json`, CI `node-version`, or a `.nvmrc` — and it
does not manage pnpm at all. After a Dependabot Docker Node bump, those other copies drift.

**When you bump any runtime — or when reviewing a Dependabot Docker PR — reconcile every copy you
discovered.** A mismatch (e.g. Docker on `20.11` while `engines.node` demands `>=20.12.0`) causes an
`engineStrict` install failure in the image build.

## Bump Node (minor/patch)

Node `X.y → X.z` within the same major is non-breaking (same LTS line). Pick a version whose image tag
is published on Docker Hub, then update **every** discovered copy to the matching value/format:

1. `Dockerfile` base tag (`FROM node:<tag>`), and any CI `node-version`.
2. `pnpm-workspace.yaml` `nodeVersion:` (exact `<maj.min.patch>`), if present.
3. `package.json` `engines.node` (raise the floor to match), `volta.node` if present, and any
   `.nvmrc` / `.node-version` / `.tool-versions`.
4. Run `pnpm install` locally (confirms `engineStrict` is satisfied), then the
   [verification](#verification) pipeline including a Docker build if a `Dockerfile` exists.

## Bump Node (major — requires permission)

A Node **major** bump (e.g. 22 → 24) is breaking: LTS lifecycle, V8/native-addon compatibility, and
the minimum-version requirements of the framework and toolchain all matter. **Treat it like a major
package migration — warn the user and get explicit permission first** (see `package-updates.md`).

- Prefer an **LTS** major (even-numbered). Confirm the framework, tooling, and any native addons
  support it.
- Confirm the target image tag exists.
- On approval, bump every Node copy, install, and run the full pipeline + Docker build + a smoke of
  the running container.

## Bump pnpm (regenerate the packageManager hash)

If `package.json` has a `packageManager` field, it carries a **SHA-512 integrity hash**. If you
hand-edit only the version number, Corepack refuses to run (hash mismatch). Always regenerate it with
Corepack:

```bash
corepack enable pnpm            # once, if not already enabled
corepack use pnpm@<version>     # rewrites packageManager WITH the correct +sha512 hash
```

Then align the other pnpm copies you discovered: `engines.pnpm`, and any `Dockerfile` pnpm-install
line (some Dockerfiles install pnpm via `npm i -g pnpm@X` rather than Corepack — keep that literal in
sync).

pnpm **major** bumps (e.g. 11 → 12) can change the lockfile format and workspace-config keys — treat
as breaking (permission + read the pnpm release notes; expect a `pnpm-lock.yaml` `lockfileVersion`
change and re-verify install). Minor/patch pnpm bumps are low-risk but still run the pipeline.

## Bump the Docker base image

This is what Dependabot's `docker` ecosystem bumps (minor/patch; majors usually ignored). When doing
it manually or reconciling a Dependabot PR:

- Keep the same image variant the multi-stage build assumes (e.g. an `-alpine` base may rely on
  `apk add libc6-compat`; a `-slim`/Debian base uses `apt`). Don't silently switch variants.
- Reconcile the Node copies you discovered above.
- Rebuild the image to confirm system libs and native deps still resolve on the new base.

## Verification

After any runtime bump, run the project's standard pipeline (discover the script names — see
`SKILL.md`) **plus** a Docker build when a `Dockerfile` exists, since runtime changes fully surface
only in the image:

```bash
# Standard pipeline (use the project's actual script names)
CI=true pnpm install --frozen-lockfile
pnpm run typecheck   # or tsc / compile
pnpm test
pnpm run lint
pnpm run build

# Docker (if a Dockerfile exists): confirm the new base + pnpm install + build succeed
docker build -t runtime-version-check .
# Optionally verify the Node version actually running in the image:
docker run --rm --entrypoint node runtime-version-check --version
```

If Docker is unavailable in the environment, say so explicitly in your report rather than implying the
image was verified.
