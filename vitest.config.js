/**
 * Vitest Configuration
 * For more information: https://vitest.dev/config/
 */
import { defineConfig } from 'vitest/config';

// Third-party skills are vendored as-is; do not run or measure them.
const thirdPartySkills = [
  '**/.agents/**',
  '**/.github/skills/**',
  '**/.claude/skills/agent-browser/**',
  '**/.claude/skills/browser-use/**',
  '**/.claude/skills/code-review/**',
  '**/.claude/skills/diagnosing-bugs/**',
  '**/.claude/skills/i-have-adhd/**',
  '**/.claude/skills/playwright-cli/**',
  '**/.claude/skills/skill-creator/**',
  '**/.claude/skills/tdd/**',
];

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Include patterns
    include: [
      '**/__tests__/**/*.js',
      '**/?(*.)+(spec|test).js',
      '**/__tests__/**/*.mjs',
      '**/?(*.)+(spec|test).mjs',
      '**/__tests__/**/*.ts',
      '**/?(*.)+(spec|test).ts',
    ],

    // Exclude patterns
    exclude: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/build/**',
      '**/output/**',
      '**/logs/**',
      ...thirdPartySkills,
    ],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['**/*.js', '**/*.mjs', '**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/coverage/**',
        '**/dist/**',
        '**/build/**',
        '**/*.config.js',
        '**/*.config.mjs',
        '**/*.config.ts',
        '**/output/**',
        '**/logs/**',
        '**/__tests__/**',
        '**/*.test.js',
        '**/*.spec.js',
        '**/*.integration.test.js',
        ...thirdPartySkills,
      ],
      reportOnFailure: true,
      // Thresholds for 100% coverage
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },

    // Globals (describe, test, expect) are injected automatically
    globals: true,

    // Clear mocks between tests
    clearMocks: true,
  },
});
