/**
 * Git plumbing for `pnpm swarm`: the integration worktree, one worktree per
 * step, commits on step branches, and merges into the integration branch.
 *
 * Every branch and worktree the swarm makes is its own (`swarm/<task>…`,
 * `../<repo>-wt/swarm-<task>…`). Nothing is ever deleted or reset: a retried
 * step gets a new attempt suffix instead of reusing an old branch.
 */
import fs from 'fs';
import path from 'path';
import { tasksRoot, writeActive } from '../task/store.js';
import { gitText, worktreePath } from '../loop/worktree.js';

/**
 * @typedef {import('../loop/worktree.js').Spawn} Spawn
 * @typedef {import('../loop/worktree.js').Install} Install
 */

/** @param {string} task */
export const swarmBranch = (task) => `swarm/${task}`;

/**
 * The integration worktree (no step) or a step attempt's worktree.
 *
 * @param {string} rootDir
 * @param {string} task
 * @param {string} [slot] e.g. `s2` or `s2-2`
 * @returns {string}
 */
export const swarmDir = (rootDir, task, slot) =>
  worktreePath(rootDir, `swarm-${task}${slot ? `--${slot}` : ''}`);

/**
 * @param {Spawn} spawn
 * @param {string} cwd
 * @param {string} branch
 * @returns {boolean}
 */
export const branchExists = (spawn, cwd, branch) =>
  gitText(spawn, cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]) !== null;

/**
 * Create a worktree on `branch` (from `base` when the branch is new), or reuse
 * an existing worktree of this repository.
 *
 * @param {{ rootDir: string, dir: string, branch: string, base: string, spawn: Spawn }} options
 * @returns {{ created: boolean }}
 */
export function addWorktree({ rootDir, dir, branch, base, spawn }) {
  if (fs.existsSync(dir)) {
    const ours = gitText(spawn, rootDir, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const theirs = gitText(spawn, dir, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (!ours || !theirs || path.resolve(ours) !== path.resolve(theirs)) {
      throw new Error(
        `${dir} exists but is not a worktree of this repository.\nFix: move it away and re-run pnpm swarm`
      );
    }
    return { created: false };
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const added = gitText(
    spawn,
    rootDir,
    branchExists(spawn, rootDir, branch)
      ? ['worktree', 'add', dir, branch]
      : ['worktree', 'add', '-b', branch, dir, base]
  );
  if (added === null) {
    throw new Error(
      `git worktree add failed for ${dir} (branch ${branch}).\nFix: git worktree list — then git worktree prune if the entry is stale`
    );
  }
  return { created: true };
}

/**
 * The first attempt slot whose branch and worktree are both unused.
 *
 * @param {{ rootDir: string, task: string, id: string, spawn: Spawn }} options
 * @returns {{ slot: string, branch: string, dir: string }}
 */
export function freeStepSlot({ rootDir, task, id, spawn }) {
  for (let attempt = 1; ; attempt++) {
    const slot = attempt === 1 ? id : `${id}-${attempt}`;
    const branch = `${swarmBranch(task)}--${slot}`;
    const dir = swarmDir(rootDir, task, slot);
    if (!fs.existsSync(dir) && !branchExists(spawn, rootDir, branch)) {
      return { slot, branch, dir };
    }
  }
}

/**
 * Copy the git-ignored task folder into a worktree (unless it is already
 * there) and make it the worktree's active task.
 *
 * @param {{ rootDir: string, dir: string, task: string }} options
 */
export function copyTask({ rootDir, dir, task }) {
  const target = path.join(tasksRoot(dir), task);
  if (!fs.existsSync(target)) {
    fs.cpSync(path.join(tasksRoot(rootDir), task), target, {
      recursive: true,
      filter: (source) => !/[\\/](swarm|loop)$/.test(source),
    });
  }
  writeActive(dir, task);
}

/**
 * Install dependencies when the worktree has a package.json but no
 * node_modules yet.
 *
 * @param {string} dir
 * @param {Install} install
 * @returns {boolean} whether it installed
 */
export function installIfNeeded(dir, install) {
  if (
    !fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(dir, 'node_modules'))
  ) {
    return false;
  }
  if (install(dir).status !== 0) {
    throw new Error(
      `pnpm install failed in ${dir}.\nFix: cd ${dir} && pnpm install, then re-run pnpm swarm (or pass --no-install)`
    );
  }
  return true;
}

/**
 * @param {Spawn} spawn
 * @param {string} cwd
 * @param {string[]} args
 */
function git(spawn, cwd, args) {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5 * 60 * 1000,
  });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .map(String)
      .join('\n')
      .trim(),
  };
}

/**
 * Stage everything and commit it (git hooks run; never --no-verify).
 *
 * @param {{ dir: string, subject: string, body: string, spawn: Spawn }} options
 * @returns {{ ok: true, sha: string | null } | { ok: false, error: string }}
 *   sha is null when there was nothing to commit
 */
export function commitAll({ dir, subject, body, spawn }) {
  const added = git(spawn, dir, ['add', '-A']);
  if (!added.ok) return { ok: false, error: `git add failed: ${added.output}` };
  if (git(spawn, dir, ['diff', '--cached', '--quiet']).ok) {
    return { ok: true, sha: null };
  }
  const committed = git(spawn, dir, ['commit', '-m', subject, '-m', body]);
  if (!committed.ok) {
    return { ok: false, error: `git commit failed: ${committed.output}` };
  }
  return { ok: true, sha: gitText(spawn, dir, ['rev-parse', 'HEAD']) };
}

/**
 * Merge a step branch into the integration worktree's branch. A conflicting
 * merge is aborted, leaving the integration branch as it was.
 *
 * @param {{ dir: string, branch: string, subject: string, spawn: Spawn }} options
 * @returns {{ ok: true, sha: string | null } | { ok: false, error: string }}
 */
export function mergeBranch({ dir, branch, subject, spawn }) {
  const merged = git(spawn, dir, ['merge', '--no-ff', '-m', subject, branch]);
  if (merged.ok) {
    return { ok: true, sha: gitText(spawn, dir, ['rev-parse', 'HEAD']) };
  }
  git(spawn, dir, ['merge', '--abort']);
  return { ok: false, error: `git merge ${branch} failed: ${merged.output}` };
}
