/**
 * ESLint Configuration (Flat Config)
 * For more information: https://eslint.org/docs/latest/use/configure/configuration-files
 */

import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    // Global ignores
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/dist/**',
      '**/build/**',
      '**/output/**',
      '**/logs/**',
      '**/*.min.js',
    ],
  },
  {
    // Configuration for all JavaScript files
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        // Vitest globals (describe, test, expect, etc.)
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    rules: {
      // Possible Problems
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'error',
      'no-constant-condition': 'warn',
      'no-console': 'off', // Allow console in Node.js scripts

      // Suggestions
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-throw-literal': 'error',
      'prefer-arrow-callback': 'warn',
    },
  },
  {
    // Relaxed rules for test files
    files: ['**/*.test.js', '**/*.spec.js', '**/__tests__/**/*.js'],
    rules: {
      'no-unused-expressions': 'off',
    },
  },
  {
    // Relaxed rules for config files
    files: ['*.config.js', '.*.js'],
    rules: {
      'no-console': 'off',
    },
  },
  // Prettier config must be last to override other configs
  prettier,
];
