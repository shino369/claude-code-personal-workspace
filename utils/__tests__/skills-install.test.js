import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildInstallArgs,
  installSkills,
  main,
  parseArgs,
} from '../skills-install.js';

/** @type {string[]} */
let tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-install-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {Record<string, { source?: string }>} skills
 * @returns {Promise<string>}
 */
async function writeLock(root, skills) {
  const lockPath = path.join(root, 'skills-lock.json');
  await writeFile(lockPath, JSON.stringify({ version: 1, skills }));
  return lockPath;
}

/**
 * @param {number | null} status
 */
function makeSpawn(status) {
  /** @type {Array<{ command: string, args: string[], options: object }>} */
  const calls = [];
  const spawn = (
    /** @type {string} */ command,
    /** @type {string[]} */ args,
    /** @type {object} */ options
  ) => {
    calls.push({ command, args, options });
    return { status };
  };
  return { calls, spawn };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

describe('buildInstallArgs', () => {
  test('builds the skills add command', () => {
    expect(buildInstallArgs({ source: 'owner/repo' }, 'alpha')).toEqual([
      'dlx',
      'skills',
      'add',
      'owner/repo',
      '--skill',
      'alpha',
      '--copy',
      '--agent',
      'claude-code',
      '-y',
    ]);
  });

  test('falls back to an empty source', () => {
    expect(buildInstallArgs({}, 'alpha')[3]).toBe('');
  });
});

describe('parseArgs', () => {
  test('parses space-separated values', () => {
    expect(
      parseArgs(['--skip', 'a,b', '--only', 'c', '--unknown', 'x'])
    ).toEqual({ skip: ['a', 'b'], only: ['c'] });
  });

  test('parses inline values', () => {
    expect(parseArgs(['--skip=a', '--only=b,c'])).toEqual({
      skip: ['a'],
      only: ['b', 'c'],
    });
  });

  test('ignores a flag with no value', () => {
    expect(parseArgs(['--skip'])).toEqual({ skip: [], only: [] });
  });
});

describe('installSkills', () => {
  test('installs every lock entry', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
      beta: { source: 'owner/b' },
    });
    const { calls, spawn } = makeSpawn(0);
    /** @type {string[]} */
    const lines = [];

    const code = await installSkills({
      rootDir: root,
      lockPath,
      spawn,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('owner/a');
    expect(calls[1].args).toContain('owner/b');
    expect(lines).toContain('Installed 2 skill(s).');
  });

  test('honours --skip', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
      beta: { source: 'owner/b' },
    });
    const { calls, spawn } = makeSpawn(0);

    const code = await installSkills({
      rootDir: root,
      lockPath,
      skip: ['beta'],
      spawn,
      log: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('alpha');
  });

  test('honours --only', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
      beta: { source: 'owner/b' },
    });
    const { calls, spawn } = makeSpawn(0);

    const code = await installSkills({
      rootDir: root,
      lockPath,
      only: ['beta'],
      spawn,
      log: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('beta');
  });

  test('skips entries without a source', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, { alpha: {} });
    const { calls, spawn } = makeSpawn(0);
    /** @type {string[]} */
    const lines = [];

    const code = await installSkills({
      rootDir: root,
      lockPath,
      spawn,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(lines).toContain('✗ alpha (no source in skills-lock.json)');
  });

  test('reports a failed install', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
    });
    const { spawn } = makeSpawn(1);
    /** @type {string[]} */
    const lines = [];

    const code = await installSkills({
      rootDir: root,
      lockPath,
      spawn,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines).toContain('✗ alpha failed (exit 1)');
    expect(lines).toContain('1 of 1 skill(s) failed.');
  });

  test('handles an unknown exit status', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
    });
    const { spawn } = makeSpawn(null);
    /** @type {string[]} */
    const lines = [];

    const code = await installSkills({
      rootDir: root,
      lockPath,
      spawn,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines).toContain('✗ alpha failed (exit unknown)');
  });

  test('handles an empty selection', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
    });
    const { calls, spawn } = makeSpawn(0);
    /** @type {string[]} */
    const lines = [];

    const code = await installSkills({
      rootDir: root,
      lockPath,
      skip: ['alpha'],
      spawn,
      log: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(lines).toContain('No skills to install.');
  });
});

describe('main', () => {
  test('passes parsed arguments through', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
      beta: { source: 'owner/b' },
    });
    const { calls, spawn } = makeSpawn(0);

    const code = await main({
      argv: ['--skip', 'beta'],
      rootDir: root,
      lockPath,
      spawn,
      log: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('uses the process arguments by default', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { source: 'owner/a' },
    });
    const { calls, spawn } = makeSpawn(0);

    const code = await main({
      rootDir: root,
      lockPath,
      spawn,
      log: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('handles default options', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(main({ argv: ['--only', 'does-not-exist'] })).resolves.toBe(
        0
      );
    } finally {
      spy.mockRestore();
    }
  });
});
