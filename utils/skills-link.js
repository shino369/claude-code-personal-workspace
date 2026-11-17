#!/usr/bin/env node
/**
 * Link every skill in `.agents/skills/` into harness skill directories
 * (default: `.claude/skills/`), matching the skills.sh layout:
 *
 *   .claude/skills/<name> -> ../../.agents/skills/<name>
 *
 * - Relative symlinks; on Windows without symlink rights, falls back to a
 *   directory junction (absolute target).
 * - Migrates legacy real copies: a real `.claude/skills/<name>/` directory with
 *   no canonical counterpart is moved into `.agents/skills/` and then linked.
 * - Prunes links that point into `.agents/skills/` at a skill that no longer
 *   exists. Links pointing elsewhere are reported as unmanaged and left alone.
 *
 * Usage: node utils/skills-link.js [--check] [--target <dir>]... [--json]
 */
import fs from 'fs';
import path from 'path';
import { runIfMain } from './module-runner.js';
import {
  DEFAULT_LINK_TARGETS,
  ROOT_DIR,
  SKILLS_DIR,
} from './workspace-config.js';

/**
 * @typedef {'ok' | 'linked' | 'migrated' | 'pruned' | 'missing' | 'legacy-copy' | 'stale' | 'conflict' | 'unmanaged'} LinkStatus
 * @typedef {{ target: string, name: string, status: LinkStatus, detail?: string }} LinkResult
 * @typedef {Pick<typeof fs, 'existsSync' | 'lstatSync' | 'readdirSync' | 'mkdirSync' | 'symlinkSync' | 'readlinkSync' | 'realpathSync' | 'renameSync' | 'unlinkSync'>} FsApi
 */

/** Statuses that mean the workspace is not in the desired state. */
export const PROBLEM_STATUSES = new Set([
  'missing',
  'legacy-copy',
  'stale',
  'conflict',
]);

/**
 * List skill directory names (directories containing SKILL.md).
 *
 * @param {string} dir
 * @param {FsApi} fsApi
 * @returns {string[]}
 */
export function listSkills(dir, fsApi = fs) {
  if (!fsApi.existsSync(dir)) return [];
  return fsApi
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        fsApi.existsSync(path.join(dir, entry.name, 'SKILL.md'))
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Create a directory link, preferring a relative symlink and falling back to
 * a junction on Windows when symlinks are not permitted.
 *
 * @param {string} skillPath absolute canonical skill directory
 * @param {string} linkPath absolute link location
 * @param {{ fsApi?: FsApi, platform?: string }} [options]
 * @returns {'symlink' | 'junction'}
 */
export function createLink(
  skillPath,
  linkPath,
  { fsApi = fs, platform = process.platform } = {}
) {
  const relative = path.relative(path.dirname(linkPath), skillPath);
  try {
    fsApi.symlinkSync(relative, linkPath, 'dir');
    return 'symlink';
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) {
      throw error;
    }
    fsApi.symlinkSync(skillPath, linkPath, 'junction');
    return 'junction';
  }
}

/**
 * Whether `child` is `parent` or inside it.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Inspect one existing link-directory entry that is not a canonical skill.
 *
 * @param {{ entryPath: string, skillsAbs: string, fsApi: FsApi }} options
 * @returns {'stale' | 'unmanaged' | 'other'}
 */
function classifyExtraEntry({ entryPath, skillsAbs, fsApi }) {
  const stat = fsApi.lstatSync(entryPath);
  if (!stat.isSymbolicLink()) return 'other';
  const raw = fsApi.readlinkSync(entryPath);
  const resolved = path.resolve(path.dirname(entryPath), raw);
  return isInside(skillsAbs, resolved) ? 'stale' : 'unmanaged';
}

/**
 * Reconcile one target directory against the canonical skills directory.
 *
 * @param {{ rootDir: string, target: string, check: boolean, fsApi: FsApi, platform: string }} options
 * @returns {LinkResult[]}
 */
export function reconcileTarget({ rootDir, target, check, fsApi, platform }) {
  const skillsAbs = path.join(rootDir, SKILLS_DIR);
  const targetAbs = path.join(rootDir, target);
  /** @type {LinkResult[]} */
  const results = [];
  const push = (
    /** @type {string} */ name,
    /** @type {LinkStatus} */ status,
    /** @type {string | undefined} */ detail = undefined
  ) => results.push({ target, name, status, ...(detail ? { detail } : {}) });

  if (!check) fsApi.mkdirSync(targetAbs, { recursive: true });

  // 1. Migrate legacy real copies that have no canonical counterpart.
  for (const name of listSkills(targetAbs, fsApi)) {
    const entryPath = path.join(targetAbs, name);
    if (fsApi.lstatSync(entryPath).isSymbolicLink()) continue;

    const canonical = path.join(skillsAbs, name);
    if (fsApi.existsSync(canonical)) {
      push(
        name,
        'conflict',
        `real directory ${path.join(target, name)} shadows ${path.join(SKILLS_DIR, name)}; compare them, keep one, then re-run`
      );
      continue;
    }

    if (check) {
      push(name, 'legacy-copy', 'run pnpm skills:link to migrate it');
      continue;
    }
    fsApi.mkdirSync(skillsAbs, { recursive: true });
    fsApi.renameSync(entryPath, canonical);
    push(name, 'migrated', `moved to ${path.join(SKILLS_DIR, name)}`);
  }

  // 2. Ensure every canonical skill has a correct link.
  const canonicalSkills = listSkills(skillsAbs, fsApi);
  for (const name of canonicalSkills) {
    const skillPath = path.join(skillsAbs, name);
    const linkPath = path.join(targetAbs, name);

    /** @type {import('fs').Stats | null} */
    let stat = null;
    try {
      stat = fsApi.lstatSync(linkPath);
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') {
        throw error;
      }
    }

    if (stat && !stat.isSymbolicLink()) continue; // reported as conflict above

    if (stat) {
      let ok = false;
      try {
        ok = fsApi.realpathSync(linkPath) === fsApi.realpathSync(skillPath);
      } catch {
        ok = false;
      }
      if (ok) {
        push(name, 'ok');
        continue;
      }
      push(
        name,
        'unmanaged',
        `${path.join(target, name)} is a link to somewhere else; left alone`
      );
      continue;
    }

    if (check) {
      push(name, 'missing', 'run pnpm skills:link');
      continue;
    }
    const kind = createLink(skillPath, linkPath, { fsApi, platform });
    push(name, 'linked', kind);
  }

  // 3. Prune links into .agents/skills whose skill no longer exists.
  if (fsApi.existsSync(targetAbs)) {
    const known = new Set(canonicalSkills);
    for (const name of fsApi.readdirSync(targetAbs)) {
      if (known.has(name)) continue;
      const entryPath = path.join(targetAbs, name);
      const kind = classifyExtraEntry({ entryPath, skillsAbs, fsApi });
      if (kind === 'stale') {
        if (check) {
          push(name, 'stale', 'link points at a removed skill');
        } else {
          fsApi.unlinkSync(entryPath);
          push(name, 'pruned');
        }
      } else if (kind === 'unmanaged') {
        push(name, 'unmanaged', 'link outside .agents/skills; left alone');
      }
    }
  }

  return results;
}

/**
 * @param {{ rootDir?: string, targets?: string[], check?: boolean, fsApi?: FsApi, platform?: string }} [options]
 * @returns {LinkResult[]}
 */
export function linkSkills({
  rootDir = ROOT_DIR,
  targets = DEFAULT_LINK_TARGETS,
  check = false,
  fsApi = fs,
  platform = process.platform,
} = {}) {
  return targets.flatMap((target) =>
    reconcileTarget({ rootDir, target, check, fsApi, platform })
  );
}

/**
 * @param {string[]} argv
 * @returns {{ check: boolean, json: boolean, targets: string[] }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const targets = [];
  let check = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    if (flag === '--check') check = true;
    else if (flag === '--json') json = true;
    else if (flag === '--target') {
      const value = inline ?? argv[++i];
      if (!value) throw new Error('--target needs a directory');
      targets.push(value);
    } else {
      throw new Error(`Unknown option: ${argv[i]}`);
    }
  }

  return {
    check,
    json,
    targets: targets.length > 0 ? targets : DEFAULT_LINK_TARGETS,
  };
}

/**
 * @param {LinkResult} result
 * @returns {string}
 */
export function formatResult(result) {
  const mark = PROBLEM_STATUSES.has(result.status)
    ? '✗'
    : result.status === 'unmanaged'
      ? '!'
      : '✓';
  const detail = result.detail ? ` — ${result.detail}` : '';
  return `${mark} ${path.join(result.target, result.name)} ${result.status}${detail}`;
}

/**
 * @param {{ argv?: string[], rootDir?: string, fsApi?: FsApi, platform?: string, log?: (message: string) => void }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  rootDir = ROOT_DIR,
  fsApi = fs,
  platform = process.platform,
  log = console.log,
} = {}) {
  const { check, json, targets } = parseArgs(argv);
  const results = linkSkills({ rootDir, targets, check, fsApi, platform });
  const problems = results.filter((r) => PROBLEM_STATUSES.has(r.status));

  if (json) {
    log(JSON.stringify({ ok: problems.length === 0, results }, null, 2));
  } else {
    for (const result of results) {
      if (result.status !== 'ok') log(formatResult(result));
    }
    const ok = results.filter((r) => r.status === 'ok').length;
    log(
      problems.length === 0
        ? `Skills linked: ${results.length - ok} changed, ${ok} already ok.`
        : `${problems.length} problem(s). ${check ? 'Fix: pnpm skills:link' : 'Resolve the conflicts above, then re-run pnpm skills:link.'}`
    );
  }

  return problems.length === 0 ? 0 : 1;
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, () => {
  try {
    process.exit(main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
