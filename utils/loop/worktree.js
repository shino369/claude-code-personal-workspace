/**
 * Worktree isolation for `pnpm loop`: unattended runs never touch the main
 * checkout. From a linked worktree the loop runs in place; from the main
 * checkout it creates (or reuses) `../<repo>-wt/<task>` on branch
 * `loop/<task>`, copies the git-ignored task directory into it, and installs
 * dependencies there. Nothing is ever deleted.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tasksRoot, writeActive } from '../task/store.js';

/**
 * @typedef {(command: string, args: string[], options: object) => { status: number | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null, error?: Error }} Spawn
 */

/**
 * Run git with a fixed argument array; trimmed stdout, or null on failure.
 *
 * @param {Spawn} spawn
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null}
 */
export function gitText(spawn, cwd, args) {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60 * 1000,
  });
  return result.status === 0 ? String(result.stdout ?? '').trim() : null;
}

/**
 * @param {string} cwd
 * @param {Spawn} spawn
 * @returns {{ gitDir: string, commonDir: string } | null}
 */
function gitDirs(cwd, spawn) {
  const gitDir = gitText(spawn, cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
  ]);
  const commonDir = gitText(spawn, cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return gitDir && commonDir ? { gitDir, commonDir } : null;
}

/**
 * True in a linked worktree (its git dir differs from the shared one).
 *
 * @param {string} cwd
 * @param {Spawn} [spawn]
 * @returns {boolean}
 */
export function isLinkedWorktree(
  cwd,
  spawn = /** @type {Spawn} */ (spawnSync)
) {
  const dirs = gitDirs(cwd, spawn);
  if (!dirs) {
    throw new Error(
      `${cwd} is not a git repository, so the loop cannot isolate its changes.\nFix: run pnpm loop inside the workspace's git checkout`
    );
  }
  return path.resolve(dirs.gitDir) !== path.resolve(dirs.commonDir);
}

/**
 * Where the loop worktree for a task lives: a sibling `<repo>-wt/` folder.
 *
 * @param {string} rootDir
 * @param {string} task
 * @returns {string}
 */
export function worktreePath(rootDir, task) {
  return path.join(path.dirname(rootDir), `${path.basename(rootDir)}-wt`, task);
}

/** @param {string} task */
export const loopBranch = (task) => `loop/${task}`;

/**
 * @typedef {{ dir: string, inPlace: boolean, created: boolean, installed: boolean, warnings: string[] }} Worktree
 * @typedef {(dir: string) => { status: number | null }} Install
 */

/**
 * Find or create the loop worktree for a task.
 *
 * @param {{ rootDir: string, task: string, spawn?: Spawn, install?: Install }} options
 * @returns {Worktree}
 */
export function prepareWorktree({
  rootDir,
  task,
  spawn = /** @type {Spawn} */ (spawnSync),
  install = (dir) =>
    spawn('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: dir,
      stdio: 'inherit',
    }),
}) {
  if (isLinkedWorktree(rootDir, spawn)) {
    return {
      dir: rootDir,
      inPlace: true,
      created: false,
      installed: false,
      warnings: [],
    };
  }

  /** @type {string[]} */
  const warnings = [];
  const status = gitText(spawn, rootDir, ['status', '--porcelain']);
  if (status) {
    warnings.push(
      'The main checkout has uncommitted changes; they are NOT in the loop worktree (it starts from HEAD). Commit first if the loop needs them.'
    );
  }

  const dir = worktreePath(rootDir, task);
  const branch = loopBranch(task);
  let created = false;
  if (fs.existsSync(dir)) {
    const ours = gitDirs(rootDir, spawn);
    const theirs = gitDirs(dir, spawn);
    if (
      !theirs ||
      path.resolve(theirs.commonDir) !==
        path.resolve(/** @type {{ commonDir: string }} */ (ours).commonDir)
    ) {
      throw new Error(
        `${dir} exists but is not a worktree of this repository.\nFix: move it away, or run pnpm loop from inside the worktree you want to use`
      );
    }
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const exists =
      gitText(spawn, rootDir, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]) !== null;
    const added = gitText(
      spawn,
      rootDir,
      exists
        ? ['worktree', 'add', dir, branch]
        : ['worktree', 'add', '-b', branch, dir]
    );
    if (added === null) {
      throw new Error(
        `git worktree add failed for ${dir} (branch ${branch}).\nFix: git worktree list — then remove the stale entry with git worktree prune, or pick another task name`
      );
    }
    created = true;
  }

  const source = path.join(tasksRoot(rootDir), task);
  const target = path.join(tasksRoot(dir), task);
  if (!fs.existsSync(target)) {
    fs.cpSync(source, target, { recursive: true });
  }
  writeActive(dir, task);

  let installed = false;
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    const result = install(dir);
    if (result.status !== 0) {
      throw new Error(
        `pnpm install failed in ${dir}.\nFix: cd ${dir} && pnpm install, then re-run pnpm loop from there`
      );
    }
    installed = true;
  }

  return { dir, inPlace: false, created, installed, warnings };
}
