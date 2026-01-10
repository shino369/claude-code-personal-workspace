# Node.js package Dependency Rules

- always use `pnpm` instead of `npm`.
- when adding new package, use pnpm `catalog` feature: `pnpm add some-package --save-catalog-name=<prod|dev>`, where `prod` as `dependencies` and `dev` as `devDependencies`.