import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  gitText,
  isLinkedWorktree,
  loopBranch,
  prepareWorktree,
  worktreePath,
} from '../worktree.js';

const TASK = 'demo-261117';

/** @type {string} */
let base;
/** @type {string} */
let repo;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf-8' }
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** `pnpm install`, also as `cmd.exe /d /s /c "…pnpm.CMD install …"` on Windows. */
const INSTALL = /pnpm\S* install --frozen-lockfile --prefer-offline/i;

/** Real git; `pnpm install` is answered by the fake installer. */
const spawn = vi.fn(
  /** @type {import('../worktree.js').Spawn} */ (
    (command, args, options) =>
      INSTALL.test([command, ...args].join(' '))
        ? { status: 0 }
        : spawnSync(command, args, options)
  )
);

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-wt-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'tasks', TASK), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tasks/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(repo, 'tasks', TASK, 'plan.md'), 'Goal: G\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  spawn.mockClear();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('gitText', () => {
  test('should return trimmed stdout on success', () => {
    expect(gitText(spawnSync, repo, ['branch', '--show-current'])).toBe('main');
  });

  test('should treat missing stdout as empty', () => {
    expect(gitText(() => ({ status: 0 }), repo, ['status'])).toBe('');
  });

  test('should return null when git fails', () => {
    expect(gitText(spawnSync, repo, ['rev-parse', 'nope'])).toBeNull();
  });
});

describe('isLinkedWorktree', () => {
  test('should be false in the main checkout', () => {
    expect(isLinkedWorktree(repo)).toBe(false);
  });

  test('should be true in a linked worktree', () => {
    const linked = path.join(base, 'linked');
    git(repo, ['worktree', 'add', '-q', '-b', 'x', linked]);
    expect(isLinkedWorktree(linked)).toBe(true);
  });

  test('should throw a Fix line outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-plain-'));
    try {
      expect(() => isLinkedWorktree(plain)).toThrow(/not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('worktreePath', () => {
  test('should use a sibling <repo>-wt folder', () => {
    expect(worktreePath('/a/ws', 't-1')).toBe(path.join('/a', 'ws-wt', 't-1'));
    expect(loopBranch('t-1')).toBe('loop/t-1');
  });
});

describe('prepareWorktree', () => {
  test('should run in place inside a linked worktree', () => {
    const linked = path.join(base, 'linked');
    git(repo, ['worktree', 'add', '-q', '-b', 'x', linked]);
    expect(prepareWorktree({ rootDir: linked, task: TASK, spawn })).toEqual({
      dir: linked,
      inPlace: true,
      created: false,
      installed: false,
      warnings: [],
    });
  });

  test('should create the worktree, copy the task, and install', () => {
    const result = prepareWorktree({ rootDir: repo, task: TASK, spawn });

    const dir = worktreePath(repo, TASK);
    expect(result).toEqual({
      dir,
      inPlace: false,
      created: true,
      installed: true,
      warnings: [],
    });
    expect(git(dir, ['branch', '--show-current'])).toBe(`loop/${TASK}`);
    expect(
      fs.readFileSync(path.join(dir, 'tasks', TASK, 'plan.md'), 'utf-8')
    ).toBe('Goal: G\n');
    expect(
      fs.readFileSync(path.join(dir, 'tasks', '.active'), 'utf-8').trim()
    ).toBe(TASK);
    const install = spawn.mock.calls.find(([command, args]) =>
      INSTALL.test([command, ...args].join(' '))
    );
    expect(install?.[2]).toMatchObject({ cwd: dir, stdio: 'inherit' });
  });

  test('should warn that uncommitted changes stay in the main checkout', () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    const { warnings } = prepareWorktree({ rootDir: repo, task: TASK, spawn });
    expect(warnings).toEqual([
      expect.stringContaining('NOT in the loop worktree'),
    ]);
  });

  test('should reuse an existing worktree without copying or installing again', () => {
    const first = prepareWorktree({ rootDir: repo, task: TASK, spawn });
    fs.writeFileSync(
      path.join(first.dir, 'tasks', TASK, 'plan.md'),
      'Goal: kept\n'
    );
    fs.mkdirSync(path.join(first.dir, 'node_modules'));
    const install = vi.fn(() => ({ status: 0 }));

    const second = prepareWorktree({ rootDir: repo, task: TASK, install });

    expect(second).toMatchObject({ created: false, installed: false });
    expect(install).not.toHaveBeenCalled();
    expect(
      fs.readFileSync(path.join(first.dir, 'tasks', TASK, 'plan.md'), 'utf-8')
    ).toBe('Goal: kept\n');
  });

  test('should copy the local memory files and refresh them on reuse', () => {
    fs.writeFileSync(path.join(repo, 'AGENTS.local.md'), 'core v1\n');
    fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), '@AGENTS.local.md\n');
    const first = prepareWorktree({ rootDir: repo, task: TASK, spawn });
    fs.mkdirSync(path.join(first.dir, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'AGENTS.local.md'), 'core v2\n');

    prepareWorktree({ rootDir: repo, task: TASK, spawn });

    expect(
      fs.readFileSync(path.join(first.dir, 'AGENTS.local.md'), 'utf-8')
    ).toBe('core v2\n');
    expect(
      fs.readFileSync(path.join(first.dir, 'CLAUDE.local.md'), 'utf-8')
    ).toBe('@AGENTS.local.md\n');
  });

  test('should check out an existing loop branch', () => {
    git(repo, ['branch', `loop/${TASK}`]);
    const { dir } = prepareWorktree({ rootDir: repo, task: TASK, spawn });
    expect(git(dir, ['branch', '--show-current'])).toBe(`loop/${TASK}`);
  });

  test('should refuse a directory that is not a worktree of this repo', () => {
    fs.mkdirSync(worktreePath(repo, TASK), { recursive: true });
    expect(() => prepareWorktree({ rootDir: repo, task: TASK, spawn })).toThrow(
      /is not a worktree of this repository/
    );
  });

  test('should refuse a worktree of another repository', () => {
    const other = worktreePath(repo, TASK);
    fs.mkdirSync(other, { recursive: true });
    git(other, ['init', '-q']);
    expect(() => prepareWorktree({ rootDir: repo, task: TASK, spawn })).toThrow(
      /is not a worktree of this repository/
    );
  });

  test('should explain a failed git worktree add', () => {
    /** @type {import('../worktree.js').Spawn} */
    const failing = (command, args, options) =>
      args[0] === 'worktree'
        ? { status: 128 }
        : spawnSync(command, args, options);
    expect(() =>
      prepareWorktree({ rootDir: repo, task: TASK, spawn: failing })
    ).toThrow(/git worktree add failed.*\nFix: git worktree list/s);
  });

  test('should explain a failed install', () => {
    expect(() =>
      prepareWorktree({
        rootDir: repo,
        task: TASK,
        install: () => ({ status: 1 }),
      })
    ).toThrow(/pnpm install failed.*\nFix: cd /s);
  });
});
