# Creating New Script

When attempting to create new scripts, always try to use Node.js first, as this is a pnpm workspace.

## Language Preference

**Default: Node.js**

- This workspace is configured with pnpm and has npm packages available
- Leverage existing dependencies (@mozilla/readability, iconv-lite, jsdom)
- Use modern JavaScript/TypeScript for better maintainability

**Exceptions:**

- Python: For data science, machine learning, or when specific Python libraries are required
- Bash: For simple shell automation or system-level tasks
- Other languages: Only when specifically required by the task

## Error Checking and Validation

**All scripts must include proper error handling:**

```javascript
// Good: Handle errors properly
try {
  const data = await fetchData();
  processData(data);
} catch (error) {
  console.error('Error processing data:', error.message);
  process.exit(1);
}

// Good: Validate inputs
function processFile(filePath) {
  if (!filePath) {
    throw new Error('File path is required');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  // Process file...
}
```

**Use ESLint for code quality:**

- Run `pnpm lint` before committing scripts
- Fix all linting errors and warnings
- Follow workspace ESLint configuration

## Testing Requirements

**All non-trivial scripts must have test files:**

**Test file naming convention:**

- Script: `extract_article.js`
- Test: `extract_article.test.js` (same directory or `__tests__/` subdirectory)

**Use Jest for testing:**

```javascript
// Example: extract_article.test.js
const { extractArticle } = require('./extract_article');

describe('extractArticle', () => {
  test('should extract title and content', () => {
    const html = '<html><body><h1>Title</h1><p>Content</p></body></html>';
    const result = extractArticle(html);
    expect(result.title).toBe('Title');
    expect(result.content).toContain('Content');
  });

  test('should handle empty input', () => {
    expect(() => extractArticle('')).toThrow();
  });
});
```

**Test coverage guidelines:**

- Test main functionality and edge cases
- Test error handling
- Test input validation
- Run tests with `pnpm test` before committing

**When tests are required:**

- Scripts with business logic
- Data processing scripts
- API interaction scripts
- Utility functions used across multiple files

**When tests are optional:**

- Simple one-off automation scripts
- Scripts that are primarily shell command wrappers
- Throwaway/experimental scripts in `output/tasks/`

## Script Structure

**Recommended structure for production scripts:**

```javascript
#!/usr/bin/env node

/**
 * Script description
 * Usage: node script_name.js [arguments]
 */

// Imports
const fs = require('fs');

// Main function
async function main() {
  try {
    // Script logic here
    console.log('Success');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run main function
if (require.main === module) {
  main();
}

// Export functions for testing
module.exports = { main };
```

## Quality Checklist

Before committing a new script:

- [ ] Uses Node.js (unless exception applies)
- [ ] Includes proper error handling
- [ ] Validates all inputs
- [ ] Has test file (if non-trivial)
- [ ] Passes `pnpm lint` (no errors)
- [ ] Passes `pnpm test` (all tests pass)
- [ ] Includes usage comments/documentation
- [ ] Exports functions for testability
