/**
 * Tests for auto_format.js
 */
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock child_process module
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

// Import after mocking
const childProcess = await import('child_process');
const spawnSync = /** @type {import('vitest').Mock} */ (
  /** @type {unknown} */ (childProcess.spawnSync)
);
const { prettierBin, processHookInput, runPrettier } =
  await import('../auto_format.js');
const BIN = /** @type {string} */ (prettierBin());

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
    spawnSync.mockImplementation(() => ({ status: 0, stderr: '' }));
  });

  describe('processHookInput', () => {
    test('should return false for non-Edit/Write operations', () => {
      const input = {
        tool_name: 'Read',
        tool_input: { file_path: 'test.js' },
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    test('should return false when file_path is missing', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: {},
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(spawnSync).not.toHaveBeenCalled();
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
      expect(spawnSync).not.toHaveBeenCalled();
    });

    test('should return false when file does not exist', () => {
      const input = {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(testDir, 'nonexistent.js') },
      };

      const result = processHookInput(input);

      expect(result).toBe(false);
      expect(spawnSync).not.toHaveBeenCalled();
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
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [BIN, '--write', testFile],
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

      spawnSync.mockImplementation((cmd, args) => {
        if (args && args.includes('--write')) {
          return { status: 1, stderr: 'Prettier error' };
        }
        return { status: 0, stderr: '' };
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

  describe('prettierBin', () => {
    test("should find this workspace's Prettier CLI script", () => {
      expect(BIN).toMatch(/prettier[\\/]bin[\\/]prettier\.c?js$/);
      expect(fs.existsSync(BIN)).toBe(true);
    });

    test('should read an object bin field and handle a missing one', () => {
      const dir = fs.mkdtempSync(path.join(testDir, 'pkg-'));
      const manifest = path.join(dir, 'package.json');
      const at = () => manifest;
      fs.writeFileSync(manifest, JSON.stringify({ bin: { prettier: 'p.js' } }));
      expect(prettierBin(at)).toBe(path.join(dir, 'p.js'));
      fs.writeFileSync(manifest, JSON.stringify({ bin: { other: 'o.js' } }));
      expect(prettierBin(at)).toBeNull();
      fs.writeFileSync(manifest, JSON.stringify({}));
      expect(prettierBin(at)).toBeNull();
      expect(
        prettierBin(() => {
          throw new Error('not installed');
        })
      ).toBeNull();
    });
  });

  describe('runPrettier', () => {
    test('should run the CLI script with node, without a shell', () => {
      expect(runPrettier('test.js')).toBe(true);
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [BIN, '--write', 'test.js'],
        { stdio: 'pipe', encoding: 'utf-8' }
      );
    });

    test('should return false and log when Prettier is not installed', () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      expect(runPrettier('test.js', null)).toBe(false);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Prettier not available')
      );
      consoleErrorSpy.mockRestore();
    });

    test('should return false with stderr, a spawn error, or a default message', () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      for (const [result, text] of [
        [{ status: 1, stderr: 'formatting error' }, 'formatting error'],
        [
          { status: null, stderr: '', error: new Error('spawn EACCES') },
          'spawn EACCES',
        ],
        [{ status: 1, stderr: '' }, 'Prettier formatting failed'],
      ]) {
        spawnSync.mockImplementation(() => result);
        expect(runPrettier('test.js')).toBe(false);
        expect(consoleErrorSpy).toHaveBeenLastCalledWith(
          expect.stringContaining(/** @type {string} */ (text))
        );
      }
      consoleErrorSpy.mockRestore();
    });
  });
});
