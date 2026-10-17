# Node.js Package Dependency Rules

This workspace uses **pnpm** with the **catalog** feature for centralized dependency management.

## Package Manager

**Always use `pnpm`, never `npm`:**

- Workspace pins pnpm 12.14.0 via `package.json` (`packageManager`); `engineStrict: true` enforces `engines.pnpm`
- npm commands blocked in `.claude/settings.json`

## Adding Dependencies

**Development (the only catalog in this workspace):**

```bash
pnpm add -D package-name --save-catalog-name=dev
```

If a `prod` catalog is added later, use `--save-catalog-name=prod` for runtime packages.

## Catalog Feature

Centralizes version management in `pnpm-workspace.yaml`.

**Benefits:**

- Consistent versions across workspace
- Single source of truth
- 7-day minimum release age for stability
- Update once, affects all packages

## Common Commands

```bash
pnpm install                              # Install all
pnpm add -D package-name --save-catalog-name=dev # Add dev
pnpm remove package-name                  # Remove (edit catalog manually)
pnpm update                               # Update all
pnpm list                                 # List installed
pnpm test / pnpm lint                     # Run scripts
```

## Catalog Categories

**`dev`**: All current dependencies — tooling (vitest, eslint, prettier, typescript, vite)

## Important

- npm commands are **blocked**
- Catalog auto-updates when using `--save-catalog-name`
- Can edit `pnpm-workspace.yaml` directly
- New versions must be 7+ days old
