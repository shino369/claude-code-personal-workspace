/**
 * Tests for module-runner.js
 */
import { runIfMain } from '../module-runner.js';
import { fileURLToPath } from 'url';

describe('module-runner', () => {
  describe('runIfMain', () => {
    test('should not run function when import.meta.url is not file:', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      runIfMain('https://example.com/module.js', mockFn);

      expect(called).toBe(false);
    });

    test('should not run function when paths do not match', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      // Call with a file: URL that won't match process.argv[1]
      runIfMain('file:///some/other/path.js', mockFn);

      // Function should not be called (different from process.argv[1])
      expect(called).toBe(false);
    });

    test('should run function when module is executed directly', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      // Get the actual file path of the current test file
      const currentFilePath = fileURLToPath(import.meta.url);

      // Temporarily mock process.argv[1] to match
      const originalArgv = process.argv[1];
      process.argv[1] = currentFilePath;

      try {
        runIfMain(import.meta.url, mockFn);
        expect(called).toBe(true);
      } finally {
        // Restore original argv
        process.argv[1] = originalArgv;
      }
    });

    test('should run function when scriptPath + .js matches', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      // Get the current file path
      const currentFilePath = fileURLToPath(import.meta.url);

      // Mock process.argv[1] to be the path without .js
      const originalArgv = process.argv[1];
      process.argv[1] = currentFilePath.replace(/\.js$/, '');

      try {
        runIfMain(import.meta.url, mockFn);
        expect(called).toBe(true);
      } finally {
        // Restore original argv
        process.argv[1] = originalArgv;
      }
    });

    test('should handle invalid file URLs gracefully', () => {
      let called = false;
      const mockFn = () => {
        called = true;
      };

      // Invalid file URL that will cause fileURLToPath to throw
      runIfMain('file:/invalid', mockFn);

      expect(called).toBe(false);
    });
  });
});
