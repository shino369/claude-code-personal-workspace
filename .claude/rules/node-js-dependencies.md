# Node.js Package Dependency Rules

This workspace uses **pnpm** with the **catalog** feature for centralized dependency management.

## Package Manager

**Always use `pnpm`, never `npm`:**

- Workspace configured with `packageManagerStrict: true`
- npm commands blocked in `.claude/settings.json`

## Adding Dependencies

**Production:**

```bash
pnpm add package-name --save-catalog-name=prod
```

**Development:**

```bash
pnpm add -D package-name --save-catalog-name=dev
```

## Catalog Feature

Centralizes version management in `pnpm-workspace.yaml`:

```yaml
catalogs:
  prod:
    '@mozilla/readability': ^0.6.0
    jsdom: ^27.4.0
  dev:
    eslint: ^9.17.0
    vitest: ^2.1.8
```

**Benefits:**

- Consistent versions across workspace
- Single source of truth
- 7-day minimum release age for stability
- Update once, affects all packages

**Result in `package.json`:**

```json
{
  "dependencies": {
    "package-name": "catalog:prod"
  }
}
```

## Common Commands

```bash
pnpm install                              # Install all
pnpm add package-name --save-catalog-name=prod   # Add prod
pnpm add -D package-name --save-catalog-name=dev # Add dev
pnpm remove package-name                  # Remove (edit catalog manually)
pnpm update                               # Update all
pnpm list                                 # List installed
pnpm test / pnpm lint                     # Run scripts
```

## Catalog Categories

**`prod`**: Runtime dependencies (@mozilla/readability, iconv-lite, jsdom)
**`dev`**: Build tools, testing, linters (vitest, eslint, prettier)

## Important

- npm commands are **blocked**
- Catalog auto-updates when using `--save-catalog-name`
- Can edit `pnpm-workspace.yaml` directly
- New versions must be 7+ days old
