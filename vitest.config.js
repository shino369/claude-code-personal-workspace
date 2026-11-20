/**
 * Vitest Configuration
 * For more information: https://vitest.dev/config/
 */
import { defineConfig } from 'vitest/config';
import { localGlobs, vendoredGlobs } from './utils/workspace-config.js';

// Third-party skills (and the .claude/skills link mirror) are vendored as-is;
// do not run or measure them. Project-owned skills in .agents/skills are tested.
const thirdPartySkills = vendoredGlobs();
// Local-only folders git ignores (resources/ with venvs, …): Vitest does not
// read .gitignore, and coverage would otherwise measure every JS file there.
const localOnly = localGlobs();

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Spawning git and node is several times slower on Windows: tests that
    // build real repositories take 1–4 s there (vs 5 s default), so a slow
    // runner times them out.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,

    // Tests never see the session of the agent running them: task commands
    // would otherwise resolve to that session's task (utils/task/store.js).
    env: {
      TASK_SESSION: '',
      CLAUDE_CODE_SESSION_ID: '',
      // A session kyoten started passes these on; tests must not see them.
      KYOTEN_HOME: '',
      KYOTEN_CALLER_DIR: '',
    },

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
      '**/tasks/**',
      '**/logs/**',
      // Shared fixture helpers, imported by tests (not tests themselves)
      '**/__tests__/support/**',
      ...thirdPartySkills,
      ...localOnly,
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
        '**/tasks/**',
        '**/logs/**',
        '**/__tests__/**',
        '**/*.test.js',
        '**/*.spec.js',
        '**/*.integration.test.js',
        // Playwright e2e tests (pnpm test:e2e) run outside the Vitest suite.
        'e2e/**',
        // Run only in the Workflow tool's runtime; smoke-tested by evaluating
        // them against stubs in .claude/workflows/__tests__/.
        '.claude/workflows/*.js',
        ...thirdPartySkills,
        ...localOnly,
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
