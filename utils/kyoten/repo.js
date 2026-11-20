/**
 * Git and prerequisite helpers for a home kyoten manages.
 *
 * A managed home is a git repository. Its `kyoten/upstream` branch holds the
 * pristine snapshots kyoten installed, one commit per version; the user's
 * branch (`main` at first) merges them, so local changes survive updates.
 * Snapshot commits are made with plumbing (`write-tree`, `commit-tree`): no
 * hooks run, no git identity or signing setup is needed, and an update never
 * touches the user's index or working tree before the merge.
 */
import fs from 'fs';
import path from 'path';
import { crossSpawn } from '../spawn.js';
import { MIN_NODE_MAJOR } from '../workspace-config.js';
import { capture } from './snapshot.js';

export const UPSTREAM = 'kyoten/upstream';
export const KYOTEN_IDENTITY = {
  GIT_AUTHOR_NAME: 'kyoten',
  GIT_AUTHOR_EMAIL: 'kyoten@localhost',
  GIT_COMMITTER_NAME: 'kyoten',
  GIT_COMMITTER_EMAIL: 'kyoten@localhost',
};

/** @typedef {import('../spawn.js').Spawn} Spawn */

/** @param {string} version */
export const snapshotMessage = (version) => `chore: kyoten ${version} snapshot`;

/**
 * Stage every file of `workTree` into `index` (the home's own index when
 * omitted) and write the tree. `-f`: a user's global gitignore must not drop
 * a snapshot file.
 *
 * @param {{ run?: Spawn, home: string, workTree?: string, index?: string, env?: NodeJS.ProcessEnv }} input
 * @returns {string}  the tree id
 */
export function writeTree({
  run = crossSpawn(),
  home,
  workTree = home,
  index,
  env = process.env,
}) {
  const gitEnv = index ? { ...env, GIT_INDEX_FILE: index } : env;
  const base = ['--git-dir', path.join(home, '.git'), '--work-tree', workTree];
  capture(run, 'git', [...base, 'add', '-A', '-f'], { env: gitEnv });
  return capture(run, 'git', [...base, 'write-tree'], { env: gitEnv }).trim();
}

/**
 * @param {{ run?: Spawn, home: string, tree: string, version: string, parent?: string, env?: NodeJS.ProcessEnv }} input
 * @returns {string}  the commit id
 */
export function commitTree({
  run = crossSpawn(),
  home,
  tree,
  version,
  parent,
  env = process.env,
}) {
  const args = [
    '-C',
    home,
    'commit-tree',
    '--no-gpg-sign',
    tree,
    '-m',
    snapshotMessage(version),
  ];
  if (parent) args.push('-p', parent);
  return capture(run, 'git', args, {
    env: { ...env, ...KYOTEN_IDENTITY },
  }).trim();
}

/**
 * Make `home` (holding a fresh snapshot) a repository whose `main` and
 * `kyoten/upstream` both point at one snapshot commit.
 *
 * @param {{ run?: Spawn, home: string, version: string, env?: NodeJS.ProcessEnv }} input
 * @returns {string}  the commit id
 */
export function initRepo({
  run = crossSpawn(),
  home,
  version,
  env = process.env,
}) {
  capture(run, 'git', ['init', '-q', home], { env });
  // `git init -b` needs git 2.28; this works everywhere.
  capture(run, 'git', ['-C', home, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {
    env,
  });
  const tree = writeTree({ run, home, env });
  const commit = commitTree({ run, home, tree, version, env });
  capture(run, 'git', ['-C', home, 'update-ref', 'refs/heads/main', commit], {
    env,
  });
  capture(
    run,
    'git',
    ['-C', home, 'update-ref', `refs/heads/${UPSTREAM}`, commit],
    { env }
  );
  return commit;
}

/**
 * Why `home` cannot take an update now, or null.
 *
 * @param {{ run?: Spawn, home: string }} input
 * @returns {string | null}
 */
export function updateBlocker({ run = crossSpawn(), home }) {
  const gitDir = path.join(home, '.git');
  for (const [file, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
  ]) {
    if (fs.existsSync(path.join(gitDir, file))) {
      return `${what} is in progress in ${home}.\nFix: finish it (or abort it), then run kyoten update again`;
    }
  }
  if (
    run('git', ['-C', home, 'symbolic-ref', '-q', 'HEAD'], {
      encoding: 'utf-8',
    }).status !== 0
  ) {
    return `${home} is not on a branch (detached HEAD).\nFix: git -C "${home}" switch main, then run kyoten update again`;
  }
  const changed = capture(run, 'git', [
    '-C',
    home,
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  if (changed.trim()) {
    return `${home} has uncommitted changes to tracked files.\nFix: commit or stash them, then run kyoten update again`;
  }
  return null;
}

/**
 * The environment for a merge commit: the user's own identity when git has
 * one, else kyoten's, so a fresh machine can still merge.
 *
 * @param {{ run?: Spawn, home: string, env?: NodeJS.ProcessEnv }} input
 */
export function mergeEnv({ run = crossSpawn(), home, env = process.env }) {
  const email = run('git', ['-C', home, 'config', 'user.email'], {
    encoding: 'utf-8',
    env,
  });
  return email.status === 0 && String(email.stdout).trim()
    ? env
    : { ...env, ...KYOTEN_IDENTITY };
}

/**
 * @param {{ versions?: NodeJS.ProcessVersions }} [input]
 */
export function checkNode({ versions = process.versions } = {}) {
  const major = Number(versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(
      `kyoten needs Node.js ${MIN_NODE_MAJOR} or newer (this is ${versions.node}).\nFix: install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org`
    );
  }
}

/** How to get each tool the home needs. */
export const TOOL_FIXES = {
  git: 'install git (https://git-scm.com/downloads) and make sure it is on PATH',
  pnpm: 'corepack enable (without admin rights: corepack enable --install-directory <a folder on your PATH you can write to>)',
};

/**
 * Throw when `bin --version` does not run.
 *
 * @param {{ run?: Spawn, bin: keyof typeof TOOL_FIXES }} input
 * @returns {string}  the version line
 */
export function checkTool({ run = crossSpawn(), bin }) {
  const result = run(bin, ['--version'], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} was not found.\nFix: ${TOOL_FIXES[bin]}`);
  }
  return String(result.stdout).trim();
}

/**
 * -1, 0, or 1 for two `x.y.z` versions (a pre-release suffix is ignored).
 *
 * @param {string} a
 * @param {string} b
 */
export function compareVersions(a, b) {
  const parts = (/** @type {string} */ v) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
