/**
 * Task storage: locating task directories, the active-task pointer
 * (`tasks/.active`), and safe state writes.
 *
 * Writes are atomic (write a temp file, then rename) and serialized with an
 * exclusive-create lock file, so concurrent agents cannot corrupt state.json.
 */
import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '../workspace-config.js';
import { replaceStepsBlock, renderSteps, renderTemplate } from './markdown.js';
import { assertValidState, DATE_SUFFIX_RE, TASK_NAME_RE } from './state.js';

export const TASKS_DIR = 'tasks';
export const ACTIVE_FILE = '.active';
export const STATE_FILE = 'state.json';
export const PLAN_FILE = 'plan.md';
export const NOTES_FILE = 'NOTES.md';
export const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates', 'task');
export const TASK_SUBDIRS = [
  'reviews',
  'studies',
  'scripts',
  'docs',
  'translated',
  'tmp',
];

/**
 * @typedef {import('./state.js').TaskState} TaskState
 * @typedef {{ name: string, dir: string, state: TaskState | null, plan: string | null, notes: string | null }} Task
 */

/** @param {string} rootDir */
export const tasksRoot = (rootDir) => path.join(rootDir, TASKS_DIR);

/**
 * @param {string} file
 * @returns {string | null}
 */
export function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Codes Windows gives for a file another process has open or is deleting. */
const WINDOWS_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Whether `error` is Windows' transient "file in use" (worth a retry) rather
 * than a real failure. Elsewhere these codes are real permission errors.
 *
 * @param {unknown} error
 * @param {NodeJS.Platform} platform
 */
function isWindowsBusy(error, platform) {
  return (
    platform === 'win32' &&
    WINDOWS_BUSY.has(String(/** @type {NodeJS.ErrnoException} */ (error).code))
  );
}

/**
 * Write a file atomically: readers see the old or the new content, never a
 * partial write. On Windows, replacing a file another process is reading
 * fails for a moment (EPERM/EBUSY), so the rename is retried for `retryMs`.
 *
 * @param {string} file
 * @param {string} content
 * @param {{ platform?: NodeJS.Platform, retryMs?: number }} [options]
 */
export function writeFileAtomic(
  file,
  content,
  { platform = process.platform, retryMs = 2000 } = {}
) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const deadline = Date.now() + retryMs;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    for (;;) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (error) {
        if (!isWindowsBusy(error, platform) || Date.now() >= deadline) {
          throw error;
        }
        sleepSync(20);
      }
    }
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding `<dir>/.lock`. A lock older than `staleMs` is
 * assumed to belong to a crashed process and is taken over. On Windows,
 * creating the lock while another process is deleting it fails with EPERM
 * instead of EEXIST; that is waited out the same way.
 *
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, platform?: NodeJS.Platform }} [options]
 * @returns {T}
 */
export function withLock(
  dir,
  fn,
  {
    timeoutMs = 5000,
    staleMs = 30_000,
    now = Date.now,
    platform = process.platform,
  } = {}
) {
  const lock = path.join(dir, '.lock');
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (error) {
      if (
        /** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST' &&
        !isWindowsBusy(error, platform)
      ) {
        throw error;
      }
      const stat = fs.statSync(lock, { throwIfNoEntry: false });
      if (stat && now() - stat.mtimeMs > staleMs) {
        fs.rmSync(lock, { force: true, maxRetries: 5 });
        continue;
      }
      if (now() >= deadline) {
        throw new Error(
          `Task is locked by another process (${lock}). Retry in a moment; if no other agent is running, delete the .lock file.`
        );
      }
      sleepSync(50);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true, maxRetries: 5 });
  }
}

/**
 * Task directory names under tasks/ (directories holding a plan, state, or
 * notes file), sorted by name.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
export function listTaskNames(rootDir) {
  const root = tasksRoot(rootDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        [STATE_FILE, PLAN_FILE, NOTES_FILE].some((file) =>
          fs.existsSync(path.join(root, entry.name, file))
        )
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} rootDir
 * @returns {string | null} the active task name, or null when unset or gone
 */
export function readActive(rootDir) {
  const name = readIfExists(path.join(tasksRoot(rootDir), ACTIVE_FILE))?.trim();
  if (!name || !TASK_NAME_RE.test(name)) return null;
  return listTaskNames(rootDir).includes(name) ? name : null;
}

/**
 * @param {string} rootDir
 * @param {string | null} name null clears the pointer
 */
export function writeActive(rootDir, name) {
  const file = path.join(tasksRoot(rootDir), ACTIVE_FILE);
  if (name === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(tasksRoot(rootDir), { recursive: true });
  writeFileAtomic(file, `${name}\n`);
}

/**
 * Resolve a user query to a task directory name: the active task when the
 * query is empty, otherwise an exact name, the name without its date suffix,
 * or a unique prefix.
 *
 * @param {string} rootDir
 * @param {string | undefined} query
 * @returns {string}
 */
export function resolveTaskName(rootDir, query) {
  if (!query) {
    const active = readActive(rootDir);
    if (active) return active;
    throw new Error(
      'No active task.\nFix: pnpm task list, then pnpm task switch <name> (or pnpm task new <name> --goal "…")'
    );
  }
  if (!TASK_NAME_RE.test(query)) {
    throw new Error(`Invalid task name "${query}": use lowercase kebab-case`);
  }

  const names = listTaskNames(rootDir);
  if (names.includes(query)) return query;
  const byBase = names.filter(
    (name) => name.replace(DATE_SUFFIX_RE, '') === query
  );
  const matches =
    byBase.length > 0 ? byBase : names.filter((n) => n.startsWith(query));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      `No task matches "${query}".\nFix: pnpm task list (or pnpm task new ${query} --goal "…")`
    );
  }
  throw new Error(
    `"${query}" matches several tasks: ${matches.join(', ')}. Use the full name.`
  );
}

/**
 * @param {string} rootDir
 * @param {string} name
 * @returns {Task}
 */
export function loadTask(rootDir, name) {
  const dir = path.join(tasksRoot(rootDir), name);
  const raw = readIfExists(path.join(dir, STATE_FILE));
  /** @type {TaskState | null} */
  let state = null;
  if (raw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `${name}/${STATE_FILE} is not valid JSON (${/** @type {Error} */ (error).message}). Fix the file by hand; it must only be changed through pnpm task.`
      );
    }
    state = assertValidState(parsed, `${name}/${STATE_FILE}`);
  }
  return {
    name,
    dir,
    state,
    plan: readIfExists(path.join(dir, PLAN_FILE)),
    notes: readIfExists(path.join(dir, NOTES_FILE)),
  };
}

/**
 * Validate and write state.json, and refresh the generated steps block in
 * plan.md when it has one.
 *
 * @param {string} dir
 * @param {TaskState} state
 */
export function saveState(dir, state) {
  assertValidState(state);
  writeFileAtomic(
    path.join(dir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`
  );
  const planFile = path.join(dir, PLAN_FILE);
  const plan = readIfExists(planFile);
  const updated = plan === null ? null : replaceStepsBlock(plan, state.steps);
  if (updated !== null && updated !== plan) writeFileAtomic(planFile, updated);
}

/**
 * Read-modify-write state.json under the task lock.
 *
 * @param {string} rootDir
 * @param {string} name
 * @param {(state: TaskState) => TaskState} mutate
 * @param {{ now?: Date, agent?: string | null }} [options]
 * @returns {TaskState}
 */
export function updateState(
  rootDir,
  name,
  mutate,
  { now = new Date(), agent } = {}
) {
  const dir = path.join(tasksRoot(rootDir), name);
  return withLock(dir, () => {
    const { state } = loadTask(rootDir, name);
    if (!state) {
      throw new Error(
        `${name} has no ${STATE_FILE} (a hand-written task).\nFix: pnpm task init ${name}`
      );
    }
    const next = {
      ...mutate(state),
      updatedAt: now.toISOString(),
      ...(agent ? { lastAgent: agent } : {}),
    };
    saveState(dir, next);
    return next;
  });
}

/**
 * Append an entry to NOTES.md (creating it if needed).
 *
 * @param {string} dir
 * @param {string} entry
 * @param {(existing: string, entry: string) => string} separate
 */
export function appendNotes(dir, entry, separate) {
  const file = path.join(dir, NOTES_FILE);
  const existing = readIfExists(file) ?? '';
  fs.appendFileSync(file, separate(existing, entry), 'utf-8');
}

/**
 * Scaffold a task directory from templates/task/.
 *
 * @param {{ rootDir: string, name: string, state: TaskState, acceptance: string, date: string, templatesDir?: string }} options
 * @returns {string} the task directory
 */
export function scaffoldTask({
  rootDir,
  name,
  state,
  acceptance,
  date,
  templatesDir = TEMPLATES_DIR,
}) {
  const dir = path.join(tasksRoot(rootDir), name);
  if (fs.existsSync(dir)) {
    throw new Error(
      `Task ${name} already exists.\nFix: pnpm task switch ${name}`
    );
  }
  const values = {
    name,
    goal: state.goal,
    acceptance,
    date,
    steps: renderSteps(state.steps),
  };
  /** @param {string} file */
  const render = (file) =>
    renderTemplate(
      fs.readFileSync(path.join(templatesDir, file), 'utf-8'),
      values
    );
  const plan = render(PLAN_FILE);
  const notes = render(NOTES_FILE);

  fs.mkdirSync(dir, { recursive: true });
  for (const sub of TASK_SUBDIRS) fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(path.join(dir, PLAN_FILE), plan, 'utf-8');
  fs.writeFileSync(path.join(dir, NOTES_FILE), notes, 'utf-8');
  saveState(dir, state);
  return dir;
}
