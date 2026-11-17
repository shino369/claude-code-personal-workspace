/**
 * Minimal, read-only git queries for task briefs and NOTES entries. Every
 * call uses a fixed argument array (no shell) and fails soft: outside a git
 * repository the fields are null.
 */
import { spawnSync } from 'child_process';

/**
 * @typedef {(command: string, args: string[], options: object) => { status: number | null, stdout?: string | Buffer | null }} Spawn
 * @typedef {{ branch: string | null, changed: number | null, diffStat: string | null }} GitInfo
 */

/**
 * @param {Spawn} spawn
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string | null}
 */
function git(spawn, cwd, args) {
  try {
    const result = spawn('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return result.status === 0 ? String(result.stdout ?? '').trim() : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @param {Spawn} [spawn]
 * @returns {GitInfo}
 */
export function gitInfo(cwd, spawn = /** @type {Spawn} */ (spawnSync)) {
  const branch = git(spawn, cwd, ['branch', '--show-current']);
  const status = git(spawn, cwd, ['status', '--porcelain']);
  const diffStat = git(spawn, cwd, ['diff', 'HEAD', '--shortstat']);
  return {
    branch: branch || null,
    changed: status === null ? null : status.split('\n').filter(Boolean).length,
    diffStat: diffStat || null,
  };
}

/**
 * One-line summary for NOTES `State:` lines and briefs.
 *
 * @param {GitInfo} info
 * @returns {string}
 */
export function formatGit(info) {
  if (info.branch === null && info.changed === null) return 'not a git repo';
  const branch = `branch ${info.branch ?? '(detached)'}`;
  const changed =
    info.changed === null
      ? 'uncommitted unknown'
      : info.changed === 0
        ? 'uncommitted no'
        : `uncommitted yes (${info.changed} file${info.changed === 1 ? '' : 's'})`;
  return `${branch}; ${changed}`;
}
