import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
  defaultProbeDeps,
  guessVia,
  mergeScan,
  parseVersion,
  probeTool,
  runCheck,
} from '../scan.js';
import { isExecutable, which } from '../../spawn.js';

const NOW = new Date('2026-11-17T09:00:00.000Z');

/** @param {Partial<import('../registry.js').ToolEntry>} [overrides] */
const entry = (overrides = {}) => ({
  name: 'codex',
  kind: /** @type {const} */ ('agent'),
  path: '/bin/codex',
  version: '1.0.0',
  source: /** @type {const} */ ('scan'),
  ok: true,
  checkedAt: NOW.toISOString(),
  ...overrides,
});

describe('isExecutable', () => {
  test('should accept an executable file only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-exec-'));
    try {
      const file = path.join(dir, 'tool');
      fs.writeFileSync(file, '#!/bin/sh\n');
      fs.chmodSync(file, 0o644);
      expect(isExecutable(file)).toBe(process.platform === 'win32');
      fs.chmodSync(file, 0o755);
      expect(isExecutable(file)).toBe(true);
      expect(isExecutable(dir)).toBe(false);
      expect(isExecutable(path.join(dir, 'missing'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('defaultProbeDeps', () => {
  test('should use the real process and resolve real paths', () => {
    const deps = defaultProbeDeps();
    expect(deps.platform).toBe(process.platform);
    expect(deps.realpath(os.tmpdir())).toBe(fs.realpathSync(os.tmpdir()));
    expect(deps.realpath('/definitely/missing')).toBe('/definitely/missing');
  });
});

describe('which', () => {
  test('should search PATH in order on posix', () => {
    const canRun = vi.fn((/** @type {string} */ f) => f === '/b/codex');
    expect(
      which('codex', {
        env: { PATH: '/a::/b' },
        platform: 'darwin',
        isExecutable: canRun,
      })
    ).toBe('/b/codex');
    expect(canRun.mock.calls.map(([f]) => f)).toEqual(['/a/codex', '/b/codex']);
  });

  test('should try PATHEXT extensions on Windows and read Path', () => {
    const canRun = (/** @type {string} */ f) => f === 'C:\\bin\\gh.CMD';
    expect(
      which('gh', {
        env: { Path: 'C:\\bin', PATHEXT: '.EXE;.CMD' },
        platform: 'win32',
        isExecutable: canRun,
      })
    ).toBe('C:\\bin\\gh.CMD');
    expect(
      which('gh', {
        env: { Path: 'C:\\bin' },
        platform: 'win32',
        isExecutable: (f) => f === 'C:\\bin\\gh.EXE',
      })
    ).toBe('C:\\bin\\gh.EXE');
  });

  test('should check names with a path separator as given', () => {
    const deps = { env: {}, platform: /** @type {const} */ ('darwin') };
    expect(which('./x', { ...deps, isExecutable: (f) => f === './x' })).toBe(
      './x'
    );
    expect(which('./x', { ...deps, isExecutable: () => false })).toBeNull();
    expect(
      which('C:\\t\\x', {
        env: {},
        platform: 'win32',
        isExecutable: (f) => f === 'C:\\t\\x.EXE',
      })
    ).toBe('C:\\t\\x.EXE');
  });

  test('should return null when not found or PATH is empty', () => {
    expect(
      which('x', { env: {}, platform: 'linux', isExecutable: () => true })
    ).toBeNull();
  });
});

describe('parseVersion', () => {
  test.each([
    ['codex-cli 0.155.0', '0.155.0'],
    ['v24.22.3', 'v24.22.3'],
    ['jq-1.7.1-apple', '1.7.1-apple'],
    ['gh version 2.81 (2026-01-01)', '2.81'],
    ['2.1.326 (Claude Code)', '2.1.326'],
  ])('should read %s', (text, version) => {
    expect(parseVersion(text)).toBe(version);
  });

  test('should return null without a version', () => {
    expect(parseVersion('no digits')).toBeNull();
  });
});

describe('guessVia', () => {
  test.each([
    ['/opt/homebrew/Cellar/gh/2/bin/gh', 'brew'],
    [
      'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\x.exe',
      'winget',
    ],
    ['/Users/a/.nvm/versions/node/v24/bin/node', 'nvm'],
    ['/Users/a/.local/share/uv/tools/browser-use/bin/browser-use', 'uv tool'],
    ['/Users/a/Library/pnpm/codex', 'pnpm (global)'],
    ['/Users/a/.cargo/bin/rg', 'cargo'],
    ['/Users/a/.local/share/claude/versions/2.1', 'claude native installer'],
    ['/usr/bin/git', 'system'],
  ])('should map %s', (file, via) => {
    expect(guessVia(file)).toBe(via);
  });

  test('should return undefined for unknown locations', () => {
    expect(guessVia('/usr/local/bin/docker')).toBeUndefined();
  });
});

describe('runCheck', () => {
  test('should run argv without a shell and parse the version', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: 'tool 1.2.3',
      stderr: '',
    }));
    expect(
      runCheck(['/bin/t', '--version'], { spawn, env: { A: '1' } })
    ).toEqual({ ok: true, version: '1.2.3' });
    expect(spawn).toHaveBeenCalledWith('/bin/t', ['--version'], {
      cwd: undefined,
      encoding: 'utf-8',
      timeout: CHECK_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { A: '1', NO_COLOR: '1' },
    });
  });

  test('should report failures without a version', () => {
    const failing = vi.fn(() => ({ status: 1, stdout: '1.0.0' }));
    expect(runCheck(['t'], { spawn: failing, env: {} })).toEqual({
      ok: false,
      version: null,
    });
    const crashed = vi.fn(() => ({ status: 0, error: new Error('ENOENT') }));
    expect(
      runCheck(['t'], { spawn: crashed, env: {} }, { cwd: '/', timeoutMs: 5 })
    ).toEqual({ ok: false, version: null });
    expect(crashed).toHaveBeenCalledWith(
      't',
      [],
      expect.objectContaining({ cwd: '/', timeout: 5 })
    );
  });

  test('should read the version from stderr too', () => {
    const spawn = vi.fn(() => ({ status: 0, stderr: 'v3.4' }));
    expect(runCheck(['t'], { spawn, env: {} }).version).toBe('v3.4');
  });
});

describe('probeTool', () => {
  /** @param {Partial<import('../scan.js').ProbeDeps>} [overrides] */
  const deps = (overrides = {}) => ({
    env: { PATH: '/opt/homebrew/bin' },
    platform: /** @type {NodeJS.Platform} */ ('darwin'),
    isExecutable: (/** @type {string} */ f) => f === '/opt/homebrew/bin/gh',
    realpath: (/** @type {string} */ f) => f,
    spawn: vi.fn(() => ({ status: 0, stdout: 'gh version 2.81.0' })),
    ...overrides,
  });

  test('should record a found tool with catalog extras', () => {
    expect(
      probeTool(
        {
          name: 'gh',
          kind: 'cli',
          purpose: 'p',
          check: ['gh', '--version'],
          headless: 'gh …',
          env: ['GH_TOKEN'],
        },
        deps(),
        NOW
      )
    ).toEqual({
      name: 'gh',
      kind: 'cli',
      path: '/opt/homebrew/bin/gh',
      version: '2.81.0',
      via: 'brew',
      source: 'scan',
      ok: true,
      checkedAt: NOW.toISOString(),
      headless: 'gh …',
      env: ['GH_TOKEN'],
    });
  });

  test('should omit unknown extras and return null when missing', () => {
    const tool = {
      name: 'gh',
      kind: /** @type {const} */ ('cli'),
      purpose: 'p',
      check: ['gh'],
    };
    expect(
      probeTool(tool, deps({ realpath: () => '/usr/local/bin/gh' }), NOW)
    ).not.toHaveProperty('via');
    expect(
      probeTool(tool, deps({ isExecutable: () => false }), NOW)
    ).toBeNull();
  });
});

describe('mergeScan', () => {
  test('should add, refresh, and drop scan entries but keep manual ones', () => {
    const current = [
      entry({ name: 'gone' }),
      entry({ name: 'codex', version: '0.1' }),
      entry({ name: 'dsh', source: 'manual', path: null, command: 'npx dsh' }),
    ];
    const found = [
      entry({ name: 'codex', version: '0.2' }),
      entry({ name: 'gh' }),
      entry({ name: 'dsh' }),
    ];
    const merged = mergeScan(current, found);
    expect(
      merged.tools.map((t) => `${t.name}:${t.source}:${t.version}`)
    ).toEqual(['dsh:manual:1.0.0', 'codex:scan:0.2', 'gh:scan:1.0.0']);
    expect(merged.added).toEqual(['gh']);
    expect(merged.removed).toEqual(['gone']);
  });
});
