import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { readActive } from '../../task/store.js';
import {
  addWorktree,
  branchExists,
  commitAll,
  copyTask,
  freeStepSlot,
  installIfNeeded,
  mergeBranch,
  swarmBranch,
  swarmDir,
} from '../git.js';

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
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const spawn = /** @type {import('../git.js').Spawn} */ (spawnSync);
const head = (/** @type {string} */ cwd) => git(cwd, ['rev-parse', 'HEAD']);

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-git-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(repo, 'tasks', TASK), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tasks/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(repo, 'tasks', TASK, 'plan.md'), 'Goal: G\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('names', () => {
  test('should name the integration branch and worktrees', () => {
    expect(swarmBranch(TASK)).toBe(`swarm/${TASK}`);
    expect(swarmDir(repo, TASK)).toBe(
      path.join(base, 'repo-wt', `swarm-${TASK}`)
    );
    expect(swarmDir(repo, TASK, 's2-2')).toBe(
      path.join(base, 'repo-wt', `swarm-${TASK}--s2-2`)
    );
  });
});

describe('addWorktree', () => {
  test('should create a new branch from the base, then reuse the worktree', () => {
    const dir = swarmDir(repo, TASK);
    const options = {
      rootDir: repo,
      dir,
      branch: swarmBranch(TASK),
      base: head(repo),
      spawn,
    };
    expect(addWorktree(options)).toEqual({ created: true });
    expect(git(dir, ['branch', '--show-current'])).toBe(swarmBranch(TASK));
    expect(addWorktree(options)).toEqual({ created: false });
  });

  test('should check out an existing branch', () => {
    git(repo, ['branch', 'swarm/x']);
    const dir = path.join(base, 'wt');
    addWorktree({ rootDir: repo, dir, branch: 'swarm/x', base: 'nope', spawn });
    expect(git(dir, ['branch', '--show-current'])).toBe('swarm/x');
  });

  test('should refuse a directory that is not a worktree of this repo', () => {
    const dir = path.join(base, 'plain');
    fs.mkdirSync(dir);
    expect(() =>
      addWorktree({ rootDir: repo, dir, branch: 'b', base: 'HEAD', spawn })
    ).toThrow(/is not a worktree of this repository/);
    const other = path.join(base, 'other');
    fs.mkdirSync(other);
    git(other, ['init', '-q']);
    expect(() =>
      addWorktree({
        rootDir: repo,
        dir: other,
        branch: 'b',
        base: 'HEAD',
        spawn,
      })
    ).toThrow(/is not a worktree of this repository/);
  });

  test('should explain a failed git worktree add', () => {
    expect(() =>
      addWorktree({
        rootDir: repo,
        dir: path.join(base, 'wt'),
        branch: 'b',
        base: 'no-such-ref',
        spawn,
      })
    ).toThrow(/git worktree add failed .*\nFix: git worktree list/);
  });
});

describe('branchExists / freeStepSlot', () => {
  test('should pick the first attempt whose branch and dir are free', () => {
    expect(branchExists(spawn, repo, 'main')).toBe(true);
    expect(
      freeStepSlot({ rootDir: repo, task: TASK, id: 's1', spawn })
    ).toEqual({
      slot: 's1',
      branch: `swarm/${TASK}--s1`,
      dir: swarmDir(repo, TASK, 's1'),
    });
    git(repo, ['branch', `swarm/${TASK}--s1`]);
    fs.mkdirSync(swarmDir(repo, TASK, 's1-2'), { recursive: true });
    expect(
      freeStepSlot({ rootDir: repo, task: TASK, id: 's1', spawn }).slot
    ).toBe('s1-3');
  });
});

describe('copyTask', () => {
  test('should copy the task without run logs and make it active', () => {
    const source = path.join(repo, 'tasks', TASK);
    fs.mkdirSync(path.join(source, 'swarm', 'run-1'), { recursive: true });
    fs.mkdirSync(path.join(source, 'loop'), { recursive: true });
    fs.mkdirSync(path.join(source, 'tmp'), { recursive: true });
    const dir = path.join(base, 'wt');
    copyTask({ rootDir: repo, dir, task: TASK });
    const target = path.join(dir, 'tasks', TASK);
    expect(fs.readdirSync(target).sort()).toEqual(['plan.md', 'tmp']);
    expect(readActive(dir)).toBe(TASK);
  });

  test('should keep an existing copy', () => {
    const dir = path.join(base, 'wt');
    const target = path.join(dir, 'tasks', TASK);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'plan.md'), 'Goal: mine\n');
    copyTask({ rootDir: repo, dir, task: TASK });
    expect(fs.readFileSync(path.join(target, 'plan.md'), 'utf-8')).toBe(
      'Goal: mine\n'
    );
  });
});

describe('installIfNeeded', () => {
  test('should skip without package.json or with node_modules', () => {
    const install = vi.fn(() => ({ status: 0 }));
    expect(installIfNeeded(repo, install)).toBe(false);
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    expect(installIfNeeded(repo, install)).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  test('should install, and explain a failed install', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    expect(installIfNeeded(repo, () => ({ status: 0 }))).toBe(true);
    expect(() => installIfNeeded(repo, () => ({ status: 1 }))).toThrow(
      /pnpm install failed in .*\nFix: .*--no-install/
    );
  });
});

describe('commitAll', () => {
  test('should report nothing to commit', () => {
    expect(commitAll({ dir: repo, subject: 's', body: 'b', spawn })).toEqual({
      ok: true,
      sha: null,
    });
  });

  test('should stage everything and commit', () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
    const result = commitAll({
      dir: repo,
      subject: 'chore: swarm step s1',
      body: 'body',
      spawn,
    });
    expect(result).toEqual({ ok: true, sha: head(repo) });
    expect(git(repo, ['log', '-1', '--format=%s%n%b'])).toBe(
      'chore: swarm step s1\nbody'
    );
  });

  test('should report add and commit failures with output', () => {
    const failAdd = vi.fn(() => ({ status: 1, stderr: 'locked' }));
    expect(
      commitAll({ dir: repo, subject: 's', body: 'b', spawn: failAdd })
    ).toEqual({ ok: false, error: 'git add failed: locked' });
    const failCommit = vi.fn(
      /** @type {import('../git.js').Spawn} */ (
        (_command, args) =>
          args[0] === 'diff'
            ? { status: 1 }
            : args[0] === 'commit'
              ? { status: 1, stdout: 'hook said no', error: new Error('boom') }
              : { status: 0 }
      )
    );
    expect(
      commitAll({ dir: repo, subject: 's', body: 'b', spawn: failCommit })
    ).toEqual({ ok: false, error: 'git commit failed: hook said no\nboom' });
  });
});

describe('mergeBranch', () => {
  /** @param {string} content */
  const branchWith = (content) => {
    git(repo, ['switch', '-q', '-c', 'step']);
    fs.writeFileSync(path.join(repo, 'README.md'), content);
    git(repo, ['commit', '-q', '-am', 'step']);
    git(repo, ['switch', '-q', 'main']);
  };

  test('should merge with a merge commit', () => {
    branchWith('step\n');
    const result = mergeBranch({
      dir: repo,
      branch: 'step',
      subject: 'chore: merge swarm step s1',
      spawn,
    });
    expect(result).toEqual({ ok: true, sha: head(repo) });
    expect(git(repo, ['log', '-1', '--format=%p']).split(' ')).toHaveLength(2);
  });

  test('should abort a conflicting merge and keep the branch as it was', () => {
    branchWith('step\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'main\n');
    git(repo, ['commit', '-q', '-am', 'main']);
    const before = head(repo);
    const result = mergeBranch({
      dir: repo,
      branch: 'step',
      subject: 'm',
      spawn,
    });
    expect(result.ok).toBe(false);
    expect(/** @type {{ error: string }} */ (result).error).toMatch(
      /^git merge step failed: .*CONFLICT/s
    );
    expect(head(repo)).toBe(before);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });
});
