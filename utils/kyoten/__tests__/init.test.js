import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { vi } from 'vitest';
import { PNPM_INSTALL, crossSpawn } from '../../spawn.js';

/** @type {string} */
let tmp;
/** @type {string} */
let repo;
/** @type {NodeJS.ProcessEnv} */
let gitEnv;
/** @type {string} */
let first;
/** @type {string} */
let second;
/** @type {number} */
let counter = 0;

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
function git(args, cwd = repo) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, env: gitEnv, encoding: 'utf-8' }
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A `run` that executes git for real and fakes pnpm.
 *
 * @param {(args: string[]) => { status: number | null, error?: Error } | undefined} [pnpm]
 *   a failure for a `pnpm` call, or undefined for success
 */
function fakeRun(pnpm = () => undefined) {
  const real = crossSpawn();
  /** @type {{ args: string[], cwd?: string }[]} */
  const calls = [];
  /** @type {import('../../spawn.js').Spawn} */
  const run = (bin, args, options = {}) => {
    if (bin === 'pnpm') {
      if (args[0] === '--version') return { status: 0, stdout: '9.0.0\n' };
      calls.push({ args, cwd: /** @type {{ cwd?: string }} */ (options).cwd });
      return pnpm(args) ?? { status: 0 };
    }
    return real(bin, args, { env: gitEnv, ...options });
  };
  return { run, calls };
}

/** @param {string} content */
function commitSource(content) {
  fs.writeFileSync(path.join(repo, 'a.txt'), content);
  git(['add', '-A']);
  git(['commit', '-q', '-m', content]);
  return git(['rev-parse', 'HEAD']);
}

/** @param {string} commit @param {string} [version] */
const sourceAt = (commit, version = '1.0.0') =>
  /** @type {const} */ ({ kind: 'git', repo, version, commit });

/** A path for a new, not yet existing home. */
const newHome = () => path.join(tmp, `home-${(counter += 1)}`);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-home-repo-'));
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  repo = path.join(tmp, 'source');
  fs.mkdirSync(path.join(repo, 'utils', 'kyoten'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'dir'));
  fs.mkdirSync(path.join(repo, 'bin'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"kyoten"}\n');
  fs.writeFileSync(path.join(repo, 'utils', 'kyoten', 'cli.js'), '');
  fs.writeFileSync(path.join(repo, '.gitignore'), '/.kyoten/\n');
  fs.writeFileSync(path.join(repo, 'dir', '.gitignore'), 'x\n');
  fs.writeFileSync(path.join(repo, 'dir', 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(repo, 'bin', 'run.sh'), '#!/bin/sh\n', {
    mode: 0o755,
  });
  git(['init', '-q']);
  first = commitSource('one\n');
  git(['update-index', '--chmod=+x', 'bin/run.sh']);
  git(['commit', '-q', '--amend', '--no-edit']);
  first = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  second = commitSource('two\n');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
import { readHomeInfo } from '../home.js';
import { initHome, runSetup } from '../init.js';

const now = () => new Date('2026-01-02T03:04:05.000Z');

describe('initHome', () => {
  test('should create a home in a missing folder and install it', () => {
    const home = newHome();
    const { run, calls } = fakeRun();
    const log = vi.fn();

    const result = initHome({ home, source: sourceAt(first), log, run, now });

    expect(result).toEqual({ created: true });
    expect(fs.readFileSync(path.join(home, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(fs.existsSync(path.join(home, 'dir', '.gitignore'))).toBe(true);
    expect(git(['rev-parse', 'HEAD'], home)).toBe(
      git(['rev-parse', 'refs/heads/kyoten/upstream'], home)
    );
    expect(git(['symbolic-ref', 'HEAD'], home)).toBe('refs/heads/main');
    expect(readHomeInfo(home)).toEqual({
      managed: true,
      version: '1.0.0',
      sourceCommit: first,
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(log.mock.calls[0][0]).toContain(first.slice(0, 7));
    expect(calls).toHaveLength(2);
  });

  test('should create a home in an empty folder', () => {
    const home = newHome();
    fs.mkdirSync(home);
    const { run } = fakeRun();

    const result = initHome({
      home,
      source: sourceAt(first),
      log: vi.fn(),
      run,
      setup: false,
    });

    expect(result.created).toBe(true);
    expect(fs.existsSync(path.join(home, 'package.json'))).toBe(true);
  });

  test('should run pnpm install then workspace:setup in the home', () => {
    const home = newHome();
    const { run, calls } = fakeRun();

    initHome({ home, source: sourceAt(first), log: vi.fn(), run });

    expect(calls.map((c) => c.args)).toEqual([
      PNPM_INSTALL,
      ['workspace:setup'],
    ]);
    expect(calls.map((c) => path.resolve(c.cwd ?? ''))).toEqual([
      path.resolve(home),
      path.resolve(home),
    ]);
  });

  test('should not create a home again but still run setup', () => {
    const home = newHome();
    initHome({
      home,
      source: sourceAt(first),
      log: vi.fn(),
      run: fakeRun().run,
      setup: false,
      now,
    });
    const { run, calls } = fakeRun();
    const log = vi.fn();

    const result = initHome({ home, source: sourceAt(second), log, run });

    expect(result).toEqual({ created: false });
    expect(fs.readFileSync(path.join(home, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('already a kyoten workspace')
    );
    expect(calls).toHaveLength(2);
  });

  test('should refuse a non-empty folder that is not a kyoten workspace', () => {
    const home = newHome();
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'mine.txt'), 'x');
    const { run, calls } = fakeRun();

    expect(() =>
      initHome({ home, source: sourceAt(first), log: vi.fn(), run })
    ).toThrow(/not empty and is not a kyoten workspace\.\nFix:/);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(home)).toEqual(['mine.txt']);
  });

  test('should not call pnpm when setup is false', () => {
    const home = newHome();
    const seen = /** @type {string[]} */ ([]);
    const { run } = fakeRun();
    /** @type {import('../../spawn.js').Spawn} */
    const spy = (bin, args, options) => {
      seen.push(bin);
      return run(bin, args, options);
    };

    initHome({
      home,
      source: sourceAt(first),
      log: vi.fn(),
      run: spy,
      setup: false,
    });

    expect(seen).not.toContain('pnpm');
    expect(fs.existsSync(path.join(home, '.kyoten', 'home.json'))).toBe(true);
  });

  test('should fail before creating anything when pnpm is missing', () => {
    const home = newHome();
    const { run } = fakeRun();
    /** @type {import('../../spawn.js').Spawn} */
    const noPnpm = (bin, args, options) =>
      bin === 'pnpm'
        ? { status: null, error: new Error('ENOENT') }
        : run(bin, args, options);

    expect(() =>
      initHome({ home, source: sourceAt(first), log: vi.fn(), run: noPnpm })
    ).toThrow(/pnpm was not found/);
    expect(fs.existsSync(home)).toBe(false);
  });

  test('should fail with the Fix line when pnpm install fails', () => {
    const home = newHome();
    const { run, calls } = fakeRun(() => ({ status: 1 }));

    expect(() =>
      initHome({ home, source: sourceAt(first), log: vi.fn(), run })
    ).toThrow(/pnpm install .* failed in .*\nFix: .* init/);
    expect(calls).toHaveLength(1);
  });
});

describe('runSetup', () => {
  test('should throw when pnpm cannot be spawned', () => {
    const home = newHome();
    const { run } = fakeRun(() => ({ status: null, error: new Error('x') }));

    expect(() => runSetup({ home, log: vi.fn(), run })).toThrow(
      /pnpm install .* failed/
    );
  });

  test('should stop at workspace:setup when it fails', () => {
    const home = newHome();
    const { run, calls } = fakeRun((args) =>
      args[0] === 'workspace:setup' ? { status: 2 } : undefined
    );
    const log = vi.fn();

    expect(() => runSetup({ home, log, run })).toThrow(
      /pnpm workspace:setup failed in/
    );
    expect(calls).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test('should use the default runner and environment shape', () => {
    const { run } = fakeRun();

    expect(() =>
      runSetup({ home: tmp, log: vi.fn(), run, env: gitEnv })
    ).not.toThrow();
  });
});
