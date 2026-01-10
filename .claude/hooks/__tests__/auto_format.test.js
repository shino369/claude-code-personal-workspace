/**
 * Tests for auto_format.js
 */
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock child_process module
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Import after mocking
const { execSync } = await import('child_process');
const { processHookInput, runPrettier } = await import('../auto_format.js');

describe('auto_format', () => {
  const testDir = 'test_format_files';

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: prettier is available and succeeds
    execSync.mockImplementation(() => {});
  });

  describe('processHookInput', () => {
    test('should return false for non-Edit/Write operations', () => {
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: 'test.js' },
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(execSync).not.toHaveBeenCalled();
    });

    test('should return false when file_path is missing', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: {},
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(execSync).not.toHaveBeenCalled();
    });

    test('should return false for non-formattable files', () => {
      const testFile = path.join(testDir, 'image.png');
      fs.writeFileSync(testFile, 'fake image data');

      const input = {
        tool_name: 'Write',
        tool_input: { file_path: testFile },
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(execSync).not.toHaveBeenCalled();
    });

    test('should return false when file does not exist', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(testDir, 'nonexistent.js') },
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(execSync).not.toHaveBeenCalled();
    });

    test('should format JavaScript file successfully', () => {
      const testFile = path.join(testDir, 'test.js');
      fs.writeFileSync(testFile, 'const x=1;');

      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      const input = {
        tool_name: 'Edit',
        tool_input: { file_path: testFile },
      };

      const result = processHookInput(input);

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        `pnpm prettier --write "${testFile}"`,
        expect.any(Object)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Formatted')
      );

      consoleLogSpy.mockRestore();
    });

    test('should format various file types', () => {
      const fileTypes = [
        'test.js',
        'test.jsx',
        'test.mjs',
        'test.ts',
        'test.json',
        'test.md',
        'test.yaml',
        'test.css',
      ];

      fileTypes.forEach((fileName) => {
        const testFile = path.join(testDir, fileName);
        fs.writeFileSync(testFile, 'content');

        const input = {
          tool_name: 'Write',
          tool_input: { file_path: testFile },
        };

        const result = processHookInput(input);
        expect(result).toBe(true);
      });
    });

    test('should return false when prettier fails', () => {
      const testFile = path.join(testDir, 'bad.js');
      fs.writeFileSync(testFile, 'const x=1;');

      execSync.mockImplementation(() => {
        throw new Error('Prettier error');
      });

      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const input = {
        tool_name: 'Edit',
        tool_input: { file_path: testFile },
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Prettier formatting failed')
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('runPrettier', () => {
    test('should return true when prettier succeeds', () => {
      const result = runPrettier('test.js');

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith('pnpm prettier --version', {
        stdio: 'ignore',
      });
      expect(execSync).toHaveBeenCalledWith(
        'pnpm prettier --write "test.js"',
        expect.any(Object)
      );
    });

    test('should return false and log error when prettier is not available', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--version')) {
          throw new Error('prettier not found');
        }
      });

      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const result = runPrettier('test.js');

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    test('should return false when prettier fails to format', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--write')) {
          throw new Error('formatting error');
        }
      });

      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const result = runPrettier('test.js');

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Prettier formatting failed')
      );

      consoleErrorSpy.mockRestore();
    });
  });
});
