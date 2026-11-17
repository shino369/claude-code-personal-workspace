# Node.js Package Dependency Rules

This workspace uses **pnpm** with the **catalog** feature (`pnpm-workspace.yaml`) for centralized dependency management.

## Adding Dependencies

**Development (the only catalog in this workspace):**

```bash
pnpm add -D package-name --save-catalog-name=dev
```

If a `prod` catalog is added later, use `--save-catalog-name=prod` for runtime packages.

## Gotchas

- New versions must be 7+ days old (minimum release age).
- `pnpm remove package-name` does not update the catalog — remove its entry from `pnpm-workspace.yaml` manually.
