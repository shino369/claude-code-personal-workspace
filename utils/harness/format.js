/**
 * Formatting edited files with Prettier, for every harness.
 *
 * Claude Code and DSH report an edit after it happens (PostToolUse), so the
 * file is formatted then. Codex runs most edits as a shell `apply_patch`
 * and sends only PreToolUse for them (seen live, 0.155): the patch's files
 * are queued there and formatted at the next PostToolUse, or by the Stop
 * hook before it verifies (Codex runs an event's hooks concurrently, so a
 * separate Stop formatter would race the verify).
 *
 * The queue is one append-only file per session in the OS temp dir. Taking
 * it renames the file first, so paths appended meanwhile land in a new one.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { SESSION_ID_RE } from '../task/store.js';

/** Extensions Prettier formats. */
export const FORMATTABLE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.json',
  '.jsonc',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.graphql',
  '.gql',
  '.vue',
  '.svelte',
];
const QUEUE_DIR = 'workspace-format-queue';

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isFormattable(filePath) {
  return FORMATTABLE_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/**
 * Prettier's CLI script in this workspace, or null when it is not installed.
 * Run with `node` directly: no pnpm and no shell, so it works the same on
 * Windows (where pnpm is a .cmd shim) and a file path never reaches a shell.
 *
 * @param {(id: string) => string} [resolve]
 * @returns {string | null}
 */
export function prettierBin(resolve = createRequire(import.meta.url).resolve) {
  try {
    const manifest = resolve('prettier/package.json');
    const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    const script = typeof bin === 'string' ? bin : bin?.prettier;
    return script ? path.join(path.dirname(manifest), script) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {string | null} [bin] Prettier's CLI script
 * @param {string} [cwd] where Prettier looks for .prettierignore and
 *   .gitignore (default: this process's cwd)
 * @returns {boolean}
 */
export function runPrettier(filePath, bin = prettierBin(), cwd) {
  if (!bin) {
    console.error(
      `Prettier formatting failed for ${filePath}: Prettier not available (pnpm install)`
    );
    return false;
  }
  // Arguments as an array, no shell: the path cannot inject a command.
  const result = spawnSync(process.execPath, [bin, '--write', filePath], {
    stdio: 'pipe',
    encoding: 'utf-8',
    ...(cwd && { cwd }),
  });
  if (result.status !== 0) {
    console.error(
      `Prettier formatting failed for ${filePath}: ${result.stderr || result.error?.message || 'Prettier formatting failed'}`
    );
    return false;
  }
  return true;
}

/**
 * @param {string} dir
 * @param {string} file absolute
 */
const isInside = (dir, file) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * The formattable files among `files` (as an edit reported them: absolute,
 * or relative to the session's cwd), as absolute paths inside the project.
 * Anything outside the project is dropped, so a crafted patch cannot make
 * the formatter rewrite other files.
 *
 * @param {string[]} files
 * @param {{ cwd?: string, projectDir: string }} options
 * @returns {string[]}
 */
export function formatTargets(files, { cwd, projectDir }) {
  return files
    .map((file) => path.resolve(cwd ?? projectDir, file))
    .filter((file) => isFormattable(file) && isInside(projectDir, file));
}

/**
 * @typedef {{ tmpDir?: string, getuid?: (() => number) | null, username?: string, lstat?: (file: string) => { isSymbolicLink(): boolean, isDirectory(): boolean, uid: number }, constants?: { O_APPEND: number, O_CREAT: number, O_WRONLY: number, O_NOFOLLOW?: number } }} QueueOptions
 *   Everything the queue reads from the system, injectable for tests.
 */

/* c8 ignore next 4 - process.getuid is missing only on Windows; tests inject getuid */
const OWN_UID =
  typeof process.getuid === 'function'
    ? process.getuid.bind(process)
    : undefined;

/**
 * @param {QueueOptions} options
 * @returns {string} who owns the queue: the uid, or the user name on Windows
 */
function queueOwner({ getuid = OWN_UID, username } = {}) {
  const owner = getuid
    ? String(getuid())
    : (username ?? os.userInfo().username);
  return owner.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * @param {string | null | undefined} session
 * @param {string | QueueOptions} [options] a temp dir, or options
 * @returns {string | null} the session's queue file, or null for an unsafe id
 */
export function queuePath(session, options = {}) {
  const opts = typeof options === 'string' ? { tmpDir: options } : options;
  return session && SESSION_ID_RE.test(session)
    ? path.join(
        opts.tmpDir ?? os.tmpdir(),
        `${QUEUE_DIR}-${queueOwner(opts)}`,
        `${session}.txt`
      )
    : null;
}

/**
 * Whether a queue path is safe to use: not a symlink, and (where uids exist)
 * owned by this user. A path that does not exist yet is safe.
 *
 * @param {string} target
 * @param {boolean} directory it must be a directory
 * @param {QueueOptions} options
 */
function trusted(
  target,
  directory,
  { getuid = OWN_UID, lstat = fs.lstatSync } = {}
) {
  let stat;
  try {
    stat = lstat(target);
  } catch (error) {
    return (
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' &&
      !directory
    );
  }
  if (stat.isSymbolicLink() || (directory && !stat.isDirectory())) return false;
  return !getuid || stat.uid === getuid();
}

/**
 * Add files (absolute paths) to the session's queue. Does nothing, and does
 * not throw, when the queue directory or file is a symlink or belongs to
 * another user (a shared temp dir is not trusted).
 *
 * @param {string | null | undefined} session
 * @param {string[]} files
 * @param {QueueOptions} [options]
 */
export function queueFiles(session, files, options = {}) {
  const file = queuePath(session, options);
  if (!file || files.length === 0) return;
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!trusted(dir, true, options) || !trusted(file, false, options)) return;
    const { constants = fs.constants } = options;
    const fd = fs.openSync(
      file,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      fs.writeSync(fd, `${files.join('\n')}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // An unusable queue only means these files are not formatted.
  }
}

/**
 * The session's queued files, each once, emptying the queue.
 *
 * @param {string | null | undefined} session
 * @param {QueueOptions} [options]
 * @returns {string[]}
 */
export function takeQueue(session, options = {}) {
  const file = queuePath(session, options);
  if (!file) return [];
  const taken = `${file}.${process.pid}.taking`;
  try {
    if (
      !trusted(path.dirname(file), true, options) ||
      !trusted(file, false, options)
    ) {
      return [];
    }
    fs.renameSync(file, taken);
  } catch {
    return [];
  }
  const text = fs.readFileSync(taken, 'utf-8');
  fs.unlinkSync(taken);
  return [...new Set(text.split('\n').filter(Boolean))];
}

/**
 * Format the session's queued files, plus `extra`, that still exist and
 * really are inside the project (a symlink may point out of it).
 *
 * @param {string | null | undefined} session
 * @param {{ projectDir: string, extra?: string[], tmpDir?: string, run?: (file: string) => boolean, realpath?: (file: string) => string }} options
 * @returns {string[]} the files formatted
 */
export function flushFormatQueue(
  session,
  { projectDir, extra = [], tmpDir, run, realpath = fs.realpathSync }
) {
  const root = realpath(projectDir);
  // Prettier reads the ignore files from its cwd: run it in the project, not
  // wherever the hook process started (a cwd's `tmp/` rule would otherwise
  // match a path like /tmp/… and skip the file silently).
  const format = run ?? ((file) => runPrettier(file, undefined, root));
  const files = [...new Set([...takeQueue(session, { tmpDir }), ...extra])];
  return files.filter(
    (file) =>
      fs.existsSync(file) && isInside(root, realpath(file)) && format(file)
  );
}
