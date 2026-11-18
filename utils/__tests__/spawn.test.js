import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { crossSpawn, quoteCmdArg, resolveCommand, which } from '../spawn.js';

/**
 * A Windows-like file check: case-insensitive, like NTFS.
 *
 * @param {string[]} files
 */
const winFiles =
  (...files) =>
  (/** @type {string} */ f) =>
    files.some((x) => x.toLowerCase() === f.toLowerCase());

const WIN = {
  env: {
    Path: 'C:\\nvm4w\\nodejs',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: 'C:\\Windows\\cmd.exe',
  },
  platform: /** @type {const} */ ('win32'),
};

describe('which', () => {
  test('should prefer a PATHEXT shim over an extensionless POSIX script on Windows', () => {
    // nvm4w / npm put both `pnpm` (a sh script) and `pnpm.cmd` in one folder.
    const isExecutable = winFiles(
      'C:\\nvm4w\\nodejs\\pnpm',
      'C:\\nvm4w\\nodejs\\pnpm.cmd'
    );
    expect(which('pnpm', { ...WIN, isExecutable })).toBe(
      'C:\\nvm4w\\nodejs\\pnpm.CMD'
    );
  });

  test('should still find an extensionless file on Windows when nothing else matches', () => {
    expect(
      which('tool', {
        ...WIN,
        isExecutable: (f) => f === 'C:\\nvm4w\\nodejs\\tool',
      })
    ).toBe('C:\\nvm4w\\nodejs\\tool');
  });
});

describe('quoteCmdArg', () => {
  test('should leave plain arguments and quote ones with spaces or cmd characters', () => {
    expect(quoteCmdArg('--version')).toBe('--version');
    expect(quoteCmdArg('C:\\Program Files (x86)\\x.cmd')).toBe(
      '"C:\\Program Files (x86)\\x.cmd"'
    );
    expect(quoteCmdArg('a&b')).toBe('"a&b"');
    expect(quoteCmdArg('')).toBe('""');
  });

  test('should refuse characters cmd.exe expands even inside quotes', () => {
    for (const bad of ['a"b', '%PATH%', 'x!y', 'a\nb', 'a\rb']) {
      expect(() => quoteCmdArg(bad)).toThrow(/cannot be passed safely/);
    }
  });
});

describe('resolveCommand', () => {
  test('should change nothing off Windows', () => {
    expect(
      resolveCommand('pnpm', ['-v'], { platform: 'darwin', env: {} })
    ).toEqual({
      bin: 'pnpm',
      args: ['-v'],
      options: {},
    });
  });

  test('should run a .cmd shim through cmd.exe with verbatim, quoted arguments', () => {
    const isExecutable = winFiles('C:\\nvm4w\\nodejs\\pnpm.cmd');
    expect(
      resolveCommand('pnpm', ['--version'], { ...WIN, isExecutable })
    ).toEqual({
      bin: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\nvm4w\\nodejs\\pnpm.CMD --version"'],
      options: { windowsVerbatimArguments: true },
    });
    // A recorded extensionless path (an old registry entry) finds its .cmd too.
    expect(
      resolveCommand('C:\\nvm4w\\nodejs\\pnpm', [], { ...WIN, isExecutable })
        .args
    ).toEqual(['/d', '/s', '/c', '"C:\\nvm4w\\nodejs\\pnpm.CMD"']);
  });

  test('should spawn an .exe directly and fall back to cmd.exe without ComSpec', () => {
    expect(
      resolveCommand('gh', ['auth'], {
        ...WIN,
        isExecutable: (f) => f === 'C:\\nvm4w\\nodejs\\gh.EXE',
      })
    ).toEqual({
      bin: 'C:\\nvm4w\\nodejs\\gh.EXE',
      args: ['auth'],
      options: {},
    });
    expect(
      resolveCommand('x', [], {
        platform: 'win32',
        env: { Path: 'C:\\b' },
        isExecutable: (f) => f === 'C:\\b\\x.BAT',
      }).bin
    ).toBe('cmd.exe');
  });

  test('should leave an unknown command for spawn to report', () => {
    expect(
      resolveCommand('nope', ['-v'], { ...WIN, isExecutable: () => false })
    ).toEqual({
      bin: 'nope',
      args: ['-v'],
      options: {},
    });
  });
});

describe('crossSpawn', () => {
  test('should pass the resolved command and merge the options', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const run = crossSpawn(spawn, {
      ...WIN,
      isExecutable: winFiles('C:\\nvm4w\\nodejs\\codex.cmd'),
    });
    expect(run('codex', ['exec', '-'], { cwd: 'C:\\w' })).toEqual({
      status: 0,
    });
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\nvm4w\\nodejs\\codex.CMD exec -"'],
      { cwd: 'C:\\w', windowsVerbatimArguments: true }
    );
  });

  test('should run a real executable with the process defaults', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
    try {
      const result = crossSpawn()(process.execPath, ['-e', 'console.log(42)'], {
        cwd: dir,
        encoding: 'utf-8',
      });
      expect(String(result.stdout).trim()).toBe('42');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === 'win32')(
    'should run a real .cmd shim on Windows',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn shim '));
      try {
        const shim = path.join(dir, 'hello.cmd');
        fs.writeFileSync(shim, '@echo off\r\necho hello %1\r\n');
        // Plain spawnSync cannot run it (EINVAL since CVE-2024-27980)…
        expect(spawnSync(shim, ['x']).error).toBeDefined();
        // …crossSpawn can, even from a folder with spaces.
        const result = crossSpawn()(shim, ['world'], { encoding: 'utf-8' });
        expect(String(result.stdout).trim()).toBe('hello world');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
