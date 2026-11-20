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
import { HOME_INFO, readHomeInfo } from '../home.js';
import { initHome } from '../init.js';
import { updateHome } from '../update.js';

const t1 = () => new Date('2026-01-02T00:00:00.000Z');
const t2 = () => new Date('2026-02-03T00:00:00.000Z');

/** A home created from the first snapshot, setup skipped. */
function makeHome() {
  const home = newHome();
  initHome({
    home,
    source: sourceAt(first),
    log: vi.fn(),
    run: fakeRun().run,
    setup: false,
    now: t1,
  });
  return home;
}

describe('updateHome', () => {
  test('should refuse a home kyoten did not create', () => {
    const home = newHome();
    fs.mkdirSync(home);
    const { run } = fakeRun();

    expect(() =>
      updateHome({ home, source: sourceAt(second), log: vi.fn(), run })
    ).toThrow(
      /was not created by kyoten init.*\nFix: update it with git pull/s
    );
  });

  test('should refuse a kyoten older than the home and change nothing', () => {
    const home = makeHome();
    const upstream = git(['rev-parse', 'kyoten/upstream'], home);
    const head = git(['rev-parse', 'HEAD'], home);
    const info = fs.readFileSync(path.join(home, HOME_INFO), 'utf-8');
    const seen = /** @type {string[]} */ ([]);
    const { run } = fakeRun();
    /** @type {import('../../spawn.js').Spawn} */
    const spy = (bin, args, options) => {
      seen.push(bin);
      return run(bin, args, options);
    };

    expect(() =>
      updateHome({
        home,
        source: sourceAt(second, '0.9.0'),
        log: vi.fn(),
        run: spy,
      })
    ).toThrow(
      /this kyoten \(0\.9\.0\) is older than the home \(1\.0\.0\); updating would take the home back\.\nFix: npx kyoten@latest update/
    );
    expect(seen).toEqual([]);
    expect(git(['rev-parse', 'kyoten/upstream'], home)).toBe(upstream);
    expect(git(['rev-parse', 'HEAD'], home)).toBe(head);
    expect(fs.readFileSync(path.join(home, HOME_INFO), 'utf-8')).toBe(info);
  });

  test('should refuse a home with uncommitted tracked changes', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'a.txt'), 'edited\n');
    const { run } = fakeRun();

    expect(() =>
      updateHome({ home, source: sourceAt(second), log: vi.fn(), run })
    ).toThrow(/uncommitted changes to tracked files/);
    expect(git(['rev-parse', 'kyoten/upstream'], home)).not.toBe(second);
  });

  test('should fail when the kyoten/upstream branch is missing', () => {
    const home = makeHome();
    git(['branch', '-D', 'kyoten/upstream'], home);
    const { run } = fakeRun();

    expect(() =>
      updateHome({ home, source: sourceAt(second), log: vi.fn(), run })
    ).toThrow(/has no kyoten\/upstream branch.*\nFix: restore the branch/s);
  });

  test('should report no change for the snapshot the home already has', () => {
    const home = makeHome();
    const { run, calls } = fakeRun();
    const log = vi.fn();
    const before = git(['rev-parse', 'HEAD'], home);

    const result = updateHome({ home, source: sourceAt(first), log, run });

    expect(result).toEqual({ changed: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already has'));
    expect(calls).toHaveLength(0);
    expect(git(['rev-parse', 'HEAD'], home)).toBe(before);
    expect(readHomeInfo(home)?.updatedAt).toBeUndefined();
  });

  test('should fast-forward a home without local commits', () => {
    const home = makeHome();
    const oldUpstream = git(['rev-parse', 'kyoten/upstream'], home);
    const { run, calls } = fakeRun();
    const log = vi.fn();

    const result = updateHome({
      home,
      source: sourceAt(second, '2.0.0'),
      log,
      run,
      now: t2,
    });

    expect(result).toEqual({ changed: true });
    expect(fs.readFileSync(path.join(home, 'a.txt'), 'utf-8')).toBe('two\n');
    expect(fs.existsSync(path.join(home, 'new.txt'))).toBe(true);
    expect(git(['rev-parse', 'kyoten/upstream^'], home)).toBe(oldUpstream);
    expect(git(['rev-parse', 'HEAD'], home)).toBe(
      git(['rev-parse', 'kyoten/upstream'], home)
    );
    expect(git(['log', '-1', '--format=%s', 'kyoten/upstream'], home)).toBe(
      'chore: kyoten 2.0.0 snapshot'
    );
    expect(readHomeInfo(home)).toMatchObject({
      version: '2.0.0',
      sourceCommit: second,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-02-03T00:00:00.000Z',
    });
    expect(calls.map((c) => c.args)).toEqual([
      PNPM_INSTALL,
      ['workspace:setup'],
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('merging kyoten'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('is on kyoten 2.0.0')
    );
    expect(git(['status', '--porcelain', '--untracked-files=no'], home)).toBe(
      ''
    );
    expect(fs.readdirSync(path.join(home, '.kyoten', 'tmp'))).toEqual([]);
  });

  test('should merge a new snapshot with a local commit on another file', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'dir', 'b.txt'), 'mine\n');
    git(['commit', '-q', '-am', 'local change'], home);
    const { run } = fakeRun();

    const result = updateHome({
      home,
      source: sourceAt(second, '2.0.0'),
      log: vi.fn(),
      run,
      setup: false,
      now: t2,
    });

    expect(result).toEqual({ changed: true });
    expect(fs.readFileSync(path.join(home, 'a.txt'), 'utf-8')).toBe('two\n');
    expect(fs.readFileSync(path.join(home, 'dir', 'b.txt'), 'utf-8')).toBe(
      'mine\n'
    );
    expect(
      git(['rev-list', '--parents', '-n', '1', 'HEAD'], home).split(' ')
    ).toHaveLength(3);
    expect(
      git(['merge-base', '--is-ancestor', 'kyoten/upstream', 'HEAD'], home)
    ).toBe('');
  });

  test('should fail and leave the conflict for the user to resolve', () => {
    const home = makeHome();
    fs.writeFileSync(path.join(home, 'a.txt'), 'mine\n');
    git(['commit', '-q', '-am', 'local change'], home);
    const { run } = fakeRun();

    expect(() =>
      updateHome({
        home,
        source: sourceAt(second, '2.0.0'),
        log: vi.fn(),
        run,
        now: t2,
      })
    ).toThrow(/did not finish.*resolve the conflicts/s);
    expect(readHomeInfo(home)?.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(home, '.git', 'MERGE_HEAD'))).toBe(true);
    git(['merge', '--abort'], home);
  });

  test('should update the version when only the version changed', () => {
    const home = makeHome();
    const { run, calls } = fakeRun();
    const log = vi.fn();

    const result = updateHome({
      home,
      source: sourceAt(first, '1.1.0'),
      log,
      run,
      now: t2,
    });

    expect(result).toEqual({ changed: true });
    expect(readHomeInfo(home)).toMatchObject({
      version: '1.1.0',
      updatedAt: '2026-02-03T00:00:00.000Z',
    });
    expect(calls).toHaveLength(2);
    expect(fs.existsSync(path.join(home, HOME_INFO))).toBe(true);
  });

  test('should not run pnpm when setup is false', () => {
    const home = makeHome();
    const { run, calls } = fakeRun();

    updateHome({
      home,
      source: sourceAt(second, '2.0.0'),
      log: vi.fn(),
      run,
      setup: false,
    });

    expect(calls).toHaveLength(0);
  });

  test('should fail when pnpm is missing before touching the home', () => {
    const home = makeHome();
    const { run } = fakeRun();
    /** @type {import('../../spawn.js').Spawn} */
    const noPnpm = (bin, args, options) =>
      bin === 'pnpm' ? { status: 1 } : run(bin, args, options);

    expect(() =>
      updateHome({ home, source: sourceAt(second), log: vi.fn(), run: noPnpm })
    ).toThrow(/pnpm was not found/);
    expect(git(['rev-parse', 'kyoten/upstream'], home)).toBe(
      git(['rev-parse', 'HEAD'], home)
    );
  });
});
