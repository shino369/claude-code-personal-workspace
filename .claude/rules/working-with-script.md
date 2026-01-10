# Working With Script

Always use Node.js first - this is a pnpm workspace.

## Language Preference

**Default: Node.js**

- Configured with pnpm, npm packages available
- Leverage existing dependencies (@mozilla/readability, iconv-lite, jsdom)
- Modern JavaScript/TypeScript

**Exceptions:** Python (data science/ML), Bash (shell automation), other languages only when specifically required

## Error Checking and Validation

**All scripts must include:**

- Proper error handling (try-catch for async, validate inputs)
- ESLint compliance (`pnpm lint` before committing)
- Input validation before processing

## Testing Requirements

**All non-trivial scripts must have tests.**

### Structure

```
your-script-dir/
├── script.js
└── __tests__/
    └── script.test.js
```

### Coverage Requirements

**100% coverage REQUIRED for:**

- All scripts in `.claude/hooks/`, `.claude/skills/`, `utils/`
- Business logic, data processing, API interaction scripts

**Tests optional for:**

- One-off automation, shell wrappers, throwaway scripts in `output/tasks/`

**Check coverage:**

```bash
pnpm test:coverage
# Must show 100% for: Statements, Branches, Functions, Lines
```

### Detailed Guidance

Use `javascript-testing` skill for:

- Test writing principles and Vitest usage
- Mocking strategies and 100% coverage techniques
- Refactoring for testability

## Script Structure

**Production scripts (ESM):**

```javascript
#!/usr/bin/env node
import fs from 'fs';
import { runIfMain } from '#utils/module-runner.js';

// Export for testing
export function processData(data) {
  return data;
}

function main() {
  try {
    const result = processData('data');
    console.log('Success:', result);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

runIfMain(import.meta.url, main);
```

**Key points:**

- ESM imports (not CommonJS)
- Use `runIfMain()` to prevent execution when imported
- Export functions for testability
- Only `process.exit(1)` for errors

## Code Review

Use `code-review` skill for comprehensive review.

### Quick Security Check

- [ ] **Command Injection**: No user input in shell commands
- [ ] **Path Traversal**: Validate all file paths
- [ ] **Hardcoded Secrets**: No API keys/passwords in code
- [ ] **Error Handling**: All async ops have try-catch
- [ ] **Input Validation**: Validate before processing

## Quality Checklist

### Phase 1: Development

- [ ] Node.js (unless exception)
- [ ] Proper error handling
- [ ] Input validation
- [ ] Tests in `__tests__/` (if non-trivial)
- [ ] Exports for testability
- [ ] Uses `runIfMain()`

### Phase 2: Testing

- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] **100% coverage** (`pnpm test:coverage`)
- [ ] All branches tested
- [ ] Edge cases covered

### Phase 3: Review

- [ ] Run code review (use `code-review` skill)
- [ ] Fix security vulnerabilities
- [ ] Fix critical bugs
- [ ] Follows best practices

### Phase 4: Final

- [ ] Re-run `pnpm lint`
- [ ] Re-run `pnpm test:coverage`
- [ ] Manual test with real inputs
- [ ] Ready to commit
