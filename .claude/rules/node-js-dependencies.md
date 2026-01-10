# Node.js Package Dependency Rules

This workspace uses **pnpm** with the **catalog** feature for centralized dependency management.

## Package Manager

**Always use `pnpm`, never use `npm`:**

- Workspace is configured with `packageManagerStrict: true`
- npm commands are blocked in `.claude/settings.json`
- Use `pnpm` for all package operations

## Adding Dependencies

### Using Catalog Feature

**For production dependencies:**

```bash
pnpm add some-package --save-catalog-name=prod
```

**For development dependencies:**

```bash
pnpm add -D some-package --save-catalog-name=dev
```

### What is the Catalog Feature?

The catalog feature centralizes version management in `pnpm-workspace.yaml`:

```yaml
catalogs:
  prod:
    '@mozilla/readability': ^0.6.0
    iconv-lite: ^0.7.1
    jsdom: ^27.4.0
  dev:
    jest: ^29.7.0
    eslint: ^9.17.0
```

**Benefits:**

- **Consistent versions**: All packages in the workspace use the same version
- **Single source of truth**: Update versions in one place
- **Stability**: `minimumReleaseAge: 10080` (7 days) prevents using brand-new, potentially unstable releases
- **Easy updates**: Update catalog once, affects all packages using it

### Examples

**Adding a production dependency:**

```bash
# Adds to both package.json and pnpm-workspace.yaml catalog:prod
pnpm add axios --save-catalog-name=prod
```

Result in `package.json`:

```json
{
  "dependencies": {
    "axios": "catalog:prod"
  }
}
```

Result in `pnpm-workspace.yaml`:

```yaml
catalogs:
  prod:
    axios: ^1.6.0
```

**Adding a dev dependency:**

```bash
# Adds to devDependencies and catalog:dev
pnpm add -D typescript --save-catalog-name=dev
```

Result in `package.json`:

```json
{
  "devDependencies": {
    "typescript": "catalog:dev"
  }
}
```

## Installing Dependencies

**Install all dependencies:**

```bash
pnpm install
```

**Install a specific package:**

```bash
pnpm add package-name --save-catalog-name=prod
```

## Updating Dependencies

**Update a specific package in catalog:**

1. Edit `pnpm-workspace.yaml` to change the version
2. Run `pnpm install` to apply changes

**Update all dependencies:**

```bash
pnpm update
```

## Catalog Categories

**`prod` catalog** - Production dependencies:

- Runtime dependencies required by the application
- Examples: @mozilla/readability, iconv-lite, jsdom, axios

**`dev` catalog** - Development dependencies:

- Build tools, testing frameworks, linters
- Examples: jest, eslint, typescript, prettier

## Common Commands

```bash
# Install dependencies
pnpm install

# Add production dependency
pnpm add package-name --save-catalog-name=prod

# Add dev dependency
pnpm add -D package-name --save-catalog-name=dev

# Remove dependency (also remove from catalog manually)
pnpm remove package-name

# Update dependencies
pnpm update

# List installed packages
pnpm list

# Run scripts
pnpm test
pnpm lint
```

## Important Notes

- **npm is blocked**: Running `npm` commands will be denied by workspace settings
- **Catalog updates**: When adding packages with `--save-catalog-name`, the catalog is automatically updated
- **Manual catalog management**: You can edit `pnpm-workspace.yaml` directly to manage versions
- **Minimum release age**: New package versions must be at least 7 days old (configurable in `pnpm-workspace.yaml`)
