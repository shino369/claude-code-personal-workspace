/**
 * `pnpm task rm <path>…` — delete files without asking, safely.
 *
 * Agents may not run `rm` (denied in .claude/settings.json), so cleaning up a
 * stale file used to stop the work until the user deleted it. This removes
 * files and folders inside the operation scope — this workspace and the
 * active task's repository (`--repo`) — by moving them to
 * `tasks/.trash/<yyyymmdd-hhmmss>/` (git-ignored), where they stay for
 * TRASH_KEEP_MS, so every removal can be undone with one `mv`.
 *
 * Refused: anything outside the scope, a scope root, `.git`, the task records
 * (`tasks/`, a task folder, its state.json/NOTES.md/plan.md, `tasks/.*`), and
 * files that look like secrets. Every path is checked before anything moves.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TASK_FILES } from './check.js';

export const TRASH_DIR = path.join('tasks', '.trash');
/** How long removed files are kept before the next `pnpm task rm` prunes them. */
export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const SECRET_NAME_RE = /^(?:\.env(?:\..*)?|credentials\.json|.*\.(?:pem|key))$/;

/**
 * @typedef {{ from: string, label: string, rel: string }} Removal
 *   from: the canonical path; label: the trash subfolder for its scope
 *   (`workspace` or `repo-<name>`); rel: the path inside that scope.
 */

/**
 * @param {string} rel
 * @returns {boolean} whether `rel` (from a scope) stays inside it
 */
const inside = (rel) =>
  rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);

/**
 * Check one path and work out where it goes in the trash.
 *
 * @param {{ rootDir: string, scopes: string[], target: string, cwd: string }} options
 * @returns {Removal}
 */
export function planRemoval({ rootDir, scopes, target, cwd }) {
  const expanded = /^~(?=$|[\\/])/.test(target)
    ? path.join(os.homedir(), target.slice(1))
    : target;
  const abs = path.resolve(cwd, expanded);
  if (!fs.lstatSync(abs, { throwIfNoEntry: false })) {
    throw new Error(`${target}: no such file or folder (${abs}).`);
  }
  // The real folder it is in, so `..` and symlinked parents cannot leave the
  // scope; the path itself is not followed (a symlink is moved as a link).
  const from = path.join(
    fs.realpathSync(path.dirname(abs)),
    path.basename(abs)
  );
  const workspace = fs.realpathSync(rootDir);
  const scope = scopes
    .map((dir) => fs.realpathSync(dir))
    .filter((dir) => inside(path.relative(dir, from)))
    .sort((a, b) => b.length - a.length)[0];
  if (!scope) {
    throw new Error(
      `${target}: ${from} is outside this workspace and the task's repository; pnpm task rm only deletes inside them.`
    );
  }
  const rel = path.relative(scope, from);
  if (rel === '') {
    throw new Error(`${target} is the workspace or the repository itself.`);
  }
  const parts = rel.split(path.sep);
  if (parts.includes('.git')) {
    throw new Error(`${target} is inside .git; pnpm task rm never touches it.`);
  }
  if (
    scope === workspace &&
    parts[0] === 'tasks' &&
    (parts.length <= 2 ||
      parts[1].startsWith('.') ||
      (parts.length === 3 && TASK_FILES.has(parts[2])))
  ) {
    throw new Error(
      `${target} is part of the task records (tasks/, a task folder, its state.json, NOTES.md, plan.md, tasks/.*); pnpm task rm does not delete those.`
    );
  }
  if (parts.includes('secrets') || SECRET_NAME_RE.test(path.basename(from))) {
    throw new Error(
      `${target} looks like secrets; pnpm task rm never touches them.`
    );
  }
  return {
    from,
    label: scope === workspace ? 'workspace' : `repo-${path.basename(scope)}`,
    rel,
  };
}

/**
 * Remove trash batches older than TRASH_KEEP_MS.
 *
 * @param {string} rootDir
 * @param {number} nowMs
 * @returns {number} how many batches were removed
 */
export function pruneTrash(rootDir, nowMs) {
  const trash = path.join(rootDir, TRASH_DIR);
  if (!fs.existsSync(trash)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(trash, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(trash, entry.name);
    if (nowMs - fs.statSync(dir).mtimeMs > TRASH_KEEP_MS) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Move a file or folder, copying across devices when a rename cannot.
 *
 * @param {string} from
 * @param {string} to
 */
function move(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') {
      throw error;
    }
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * @param {Date} date
 * @returns {string} yyyymmdd-hhmmss in local time
 */
function stamp(date) {
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * Move `paths` to a new trash batch. All paths are checked first; one
 * refused path moves nothing.
 *
 * @param {{ rootDir: string, scopes: string[], paths: string[], cwd: string, now: Date }} options
 * @returns {{ batch: string, moved: Array<{ from: string, to: string }> }}
 */
export function trashPaths({ rootDir, scopes, paths, cwd, now }) {
  if (paths.length === 0) {
    throw new Error('Usage: pnpm task rm <path>… (moves them to tasks/.trash)');
  }
  const plans = paths.map((target) =>
    planRemoval({ rootDir, scopes, target, cwd })
  );
  pruneTrash(rootDir, now.getTime());
  const base = path.join(rootDir, TRASH_DIR, stamp(now));
  let batch = base;
  for (let n = 2; fs.existsSync(batch); n++) batch = `${base}-${n}`;
  /** @type {Array<{ from: string, to: string }>} */
  const moved = [];
  for (const { from, label, rel } of plans) {
    // A path inside one already moved went with it.
    if (moved.some((m) => inside(path.relative(m.from, from)))) continue;
    const to = path.join(batch, label, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    move(from, to);
    moved.push({ from, to });
  }
  return { batch, moved };
}
