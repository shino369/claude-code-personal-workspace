/**
 * The name memory uses for a repository: the origin remote's repository name
 * (`git@github.com:me/web.git` → `web`), else the checkout's folder name.
 *
 * Read from the files under `.git`, without running git, so hooks stay fast.
 * A worktree resolves to its main checkout (`commondir`), so a worktree and
 * its checkout share repo notes. Repo notes store this name, and recall
 * compares it with the name of the repository the agent works in.
 */
import fs from 'fs';
import path from 'path';
import { readIfExists } from '../task/store.js';

const GITDIR_RE = /^gitdir:\s*(.+?)\s*$/m;

/**
 * @typedef {{ top: string, gitDir: string, commonDir: string }} GitDirs
 */

/**
 * The repository name in a remote url, without `.git`.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function nameFromUrl(url) {
  const last = url
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/:]/)
    .pop();
  const name = String(last).replace(/\.git$/, '');
  return name || null;
}

/**
 * The url of `[remote "origin"]` in a git config file.
 *
 * @param {string} config
 * @returns {string | null}
 */
export function originUrl(config) {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const match = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * The checkout containing `start` (its top folder, its git dir, and the
 * common dir a worktree shares with its main checkout); null outside a
 * repository.
 *
 * @param {string} start
 * @returns {GitDirs | null}
 */
export function findGitDirs(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    let gitDir = null;
    if (stat?.isDirectory()) gitDir = dotGit;
    else if (stat?.isFile()) {
      const match = GITDIR_RE.exec(fs.readFileSync(dotGit, 'utf-8'));
      if (match) gitDir = path.resolve(dir, match[1]);
    }
    if (gitDir) {
      const common = readIfExists(path.join(gitDir, 'commondir'));
      const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir;
      return { top: dir, gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @param {string} start a folder in the repository
 * @returns {string | null} null outside a repository
 */
export function repoName(start) {
  const dirs = findGitDirs(start);
  if (!dirs) return null;
  const url = originUrl(
    readIfExists(path.join(dirs.commonDir, 'config')) ?? ''
  );
  const fromUrl = url ? nameFromUrl(url) : null;
  if (fromUrl) return fromUrl;
  // A main checkout's common dir is <top>/.git; name it after that folder.
  return path.basename(dirs.commonDir) === '.git'
    ? path.basename(path.dirname(dirs.commonDir))
    : path.basename(dirs.top);
}
