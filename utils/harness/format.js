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
 * @returns {boolean}
 */
export function runPrettier(filePath, bin = prettierBin()) {
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
 * @param {string | null | undefined} session
 * @param {string} [tmpDir]
 * @returns {string | null} the session's queue file, or null for an unsafe id
 */
export function queuePath(session, tmpDir = os.tmpdir()) {
  return session && SESSION_ID_RE.test(session)
    ? path.join(tmpDir, QUEUE_DIR, `${session}.txt`)
    : null;
}

/**
 * Add files (absolute paths) to the session's queue.
 *
 * @param {string | null | undefined} session
 * @param {string[]} files
 * @param {{ tmpDir?: string }} [options]
 */
export function queueFiles(session, files, { tmpDir } = {}) {
  const file = queuePath(session, tmpDir);
  if (!file || files.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${files.join('\n')}\n`);
}

/**
 * The session's queued files, each once, emptying the queue.
 *
 * @param {string | null | undefined} session
 * @param {{ tmpDir?: string }} [options]
 * @returns {string[]}
 */
export function takeQueue(session, { tmpDir } = {}) {
  const file = queuePath(session, tmpDir);
  if (!file) return [];
  const taken = `${file}.${process.pid}.taking`;
  try {
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
  {
    projectDir,
    extra = [],
    tmpDir,
    run = (file) => runPrettier(file),
    realpath = fs.realpathSync,
  }
) {
  const root = realpath(projectDir);
  const files = [...new Set([...takeQueue(session, { tmpDir }), ...extra])];
  return files.filter(
    (file) => fs.existsSync(file) && isInside(root, realpath(file)) && run(file)
  );
}
