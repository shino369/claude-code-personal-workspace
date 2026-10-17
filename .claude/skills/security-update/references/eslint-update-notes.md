# ESLint Update Notes

> **Project note:** Run ESLint with `pnpm lint` (the script runs `eslint .` with the flat config).
> There is no build step, so `pnpm lint` is the only lint gate.

When patching a package in the ESLint dependency tree, the linter's behaviour can change even when
no application code changed. Common scenarios and fixes:

## Scenario 1: Patched package is a direct ESLint dep

**Packages**: `@eslint/eslintrc`, `@eslint/js`, `eslint`, `eslint-config-prettier`,
`@typescript-eslint/*`, `eslint-plugin-*`

**Symptom**: `pnpm lint` fails with new rule errors that did not exist before.

**Fix**:

1. Update the ESLint-related parent in the `dev` catalog in `pnpm-workspace.yaml` to a version that
   is compatible with the patched sub-dep.
2. Prefer a minor/patch bump of the ESLint plugin. Check the plugin's changelog for new rules or
   changed rule defaults.
3. If a new rule flags existing code, decide whether to fix the code, set the rule to `"warn"`, or
   disable it in `eslint.config.js` with a comment explaining why.

## Scenario 2: An override resolves to the wrong major

**Symptom**: `pnpm lint` crashes with an internal error rather than a lint violation, for example:

```
NOT SUPPORTED: option missingRefs. Pass empty schema with $id that should be ignored to ajv.addSchema.
TypeError: Cannot set properties of undefined (setting 'defaultMeta')
```

**Cause**: an unbounded override target let a transitive dependency jump a major. The concrete case
in this workspace was `ajv@<6.14.0: '>=6.14.0'`, which resolved **ajv 8** while `@eslint/eslintrc`
expects **ajv 6**.

**Fix**: bound every override to the major line that contains the fix:

```yaml
overrides:
  ajv@<6.14.0: '>=6.14.0 <7'
```

Then regenerate the lockfile:

```bash
CI=true pnpm install --no-frozen-lockfile
pnpm why ajv   # confirm @eslint/eslintrc gets ajv 6.x
```

An unbounded target such as `'>=6.14.0'` is unsafe for any package that has a newer major.

## Scenario 3: Duplicate ESLint package versions

**Symptom**: `pnpm lint` fails with "Cannot find module 'eslint/...'" or rules are silently ignored.

**Cause**: pnpm's resolution graph can place two copies of a package at different paths.

**Fix**: check `node_modules/.pnpm` for duplicate ESLint installs:

```bash
ls node_modules/.pnpm | grep eslint
```

If duplicates exist, tighten the override so it does not match the version already required by the
ESLint plugins, then reinstall.

## Scenario 4: New rules flag existing code

**Symptom**: the lint error is a real rule violation, not a crash.

**Fix**: fix the code where practical. If the rule is part of an upgrade that is out of scope, set it
to `"warn"` or turn it off in `eslint.config.js` with a comment and a follow-up note. Do not disable
the rule silently.
