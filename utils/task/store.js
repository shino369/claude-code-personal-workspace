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
 * The git repository a task works in: its `repo` (`--repo`), else this
 * workspace. Git state, NOTES State lines, the start commit, and the review
 * scope come from it.
 *
 * @param {string} rootDir
 * @param {TaskState | null | undefined} state
 * @returns {string}
 */
export const taskRepoDir = (rootDir, state) => state?.repo ?? rootDir;

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
 * instead of EEXIST; that is waited out the same way. `label` names what is
 * locked in the timeout message.
 *
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, platform?: NodeJS.Platform, label?: string }} [options]
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
    label = 'Task',
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
          `${label} is locked by another process (${lock}). Retry in a moment; if no other agent is running, delete the .lock file.`
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

/*
 * Session bindings (`tasks/.sessions/<session>.json`).
 *
 * `tasks/.active` is one pointer for the whole checkout, but several agent
 * sessions can work in one checkout at once. Each session therefore keeps its
 * own binding: the task its commands resolve to, and whether it has worked on
 * that task yet (`engaged`). Claude's SessionStart hook writes a dormant
 * binding to the default task; the first `pnpm task` command that changes the
 * task engages it; `new` and `switch` move it. Hooks act only on an engaged
 * task, so a session that never touched a task never runs its loop or writes
 * into its notes. `tasks/.active` stays the default for new sessions and for
 * callers without a session id.
 */

export const SESSIONS_DIR = '.sessions';
/** Session ids become file names: letters, digits, dot, dash, underscore. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Bindings untouched this long are removed (SessionStart prunes them). */
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{ task: string | null, engaged: boolean, updatedAt: string }} SessionBinding
 */

/**
 * Session ids each harness sets for the model's shell commands, equal to its
 * hooks' `session_id`: Codex (`CODEX_SESSION_ID` is the same value), DSH, and
 * Claude Code. Child agents must not inherit them (utils/loop/adapters.js).
 */
export const HARNESS_SESSION_VARS = [
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'DSH_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
];

/**
 * The calling session: `$TASK_SESSION` (any harness can set it), else the
 * harness's own id: Codex's `$CODEX_THREAD_ID`, DSH's `$DSH_SESSION_ID`, then
 * Claude Code's `$CLAUDE_CODE_SESSION_ID`. Claude comes last because a codex
 * or dsh started from Claude Code's shell inherits Claude's id. The first one
 * set decides; null when it is not a safe id or none is set.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function sessionFromEnv(env) {
  const id =
    env.TASK_SESSION ||
    env.CODEX_THREAD_ID ||
    env.DSH_SESSION_ID ||
    env.CLAUDE_CODE_SESSION_ID;
  return id && SESSION_ID_RE.test(id) ? id : null;
}

/**
 * @param {string} rootDir
 * @param {string} session
 */
const sessionFile = (rootDir, session) =>
  path.join(tasksRoot(rootDir), SESSIONS_DIR, `${session}.json`);

/**
 * @param {string | null | undefined} session
 * @returns {session is string}
 */
const isSessionId = (session) =>
  typeof session === 'string' && SESSION_ID_RE.test(session);

/**
 * A session's binding; null when there is none or it cannot be read.
 *
 * @param {string} rootDir
 * @param {string | null | undefined} session
 * @returns {SessionBinding | null}
 */
export function readSession(rootDir, session) {
  if (!isSessionId(session)) return null;
  const raw = readIfExists(sessionFile(rootDir, session));
  if (raw === null) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const task =
    typeof data.task === 'string' && TASK_NAME_RE.test(data.task)
      ? data.task
      : data.task === null
        ? null
        : undefined;
  if (task === undefined || typeof data.engaged !== 'boolean') return null;
  return { task, engaged: data.engaged, updatedAt: String(data.updatedAt) };
}

/**
 * Write a session's binding. Returns false (and writes nothing) for a
 * missing or unsafe session id.
 *
 * @param {string} rootDir
 * @param {string | null | undefined} session
 * @param {{ task: string | null, engaged: boolean, now?: Date }} binding
 * @returns {boolean}
 */
export function writeSession(
  rootDir,
  session,
  { task, engaged, now = new Date() }
) {
  if (!isSessionId(session)) return false;
  const file = sessionFile(rootDir, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(
    file,
    `${JSON.stringify({ task, engaged, updatedAt: now.toISOString() }, null, 2)}\n`
  );
  return true;
}

/**
 * @param {string} rootDir
 * @param {string | null | undefined} session
 */
export function clearSession(rootDir, session) {
  if (!isSessionId(session)) return;
  fs.rmSync(sessionFile(rootDir, session), { force: true });
}

/**
 * Mark a session's binding as in use (its file time), so pruning removes
 * only bindings of sessions that have gone quiet.
 *
 * @param {string} rootDir
 * @param {string | null | undefined} session
 * @param {Date} [now]
 * @returns {boolean} false when there is no binding
 */
export function touchSession(rootDir, session, now = new Date()) {
  if (!isSessionId(session)) return false;
  const file = sessionFile(rootDir, session);
  if (!fs.existsSync(file)) return false;
  fs.utimesSync(file, now, now);
  return true;
}

/**
 * Remove bindings not written or touched for `maxAgeMs`.
 *
 * @param {string} rootDir
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {number} how many were removed
 */
export function pruneSessions(
  rootDir,
  { now = Date.now(), maxAgeMs = SESSION_MAX_AGE_MS } = {}
) {
  const dir = path.join(tasksRoot(rootDir), SESSIONS_DIR);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
      fs.rmSync(file, { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * The task a caller's commands resolve to: its session's bound task when
 * that task exists, else the workspace default (`tasks/.active`).
 *
 * @param {string} rootDir
 * @param {string | null} [session] default: from the environment
 * @returns {string | null}
 */
export function currentTask(rootDir, session = sessionFromEnv(process.env)) {
  const bound = readSession(rootDir, session)?.task;
  if (bound && listTaskNames(rootDir).includes(bound)) return bound;
  return readActive(rootDir);
}

/**
 * The task a hook acts on for a session, and whether the session has worked
 * on it. A session with a binding gets only its bound task (none when the
 * binding names no task or a task that is gone). A session without one
 * (started before bindings existed, or no session id) gets the workspace
 * default, treated as engaged, which is how hooks behaved before sessions.
 *
 * @param {string} rootDir
 * @param {string | null | undefined} session
 * @returns {{ name: string, engaged: boolean } | null}
 */
export function sessionTask(rootDir, session) {
  const binding = readSession(rootDir, session);
  if (binding) {
    return binding.task && listTaskNames(rootDir).includes(binding.task)
      ? { name: binding.task, engaged: binding.engaged }
      : null;
  }
  const name = readActive(rootDir);
  return name ? { name, engaged: true } : null;
}

/**
 * Resolve a user query to a task directory name: the caller's current task
 * (`currentTask`) when the query is empty, otherwise an exact name, the name
 * without its date suffix, or a unique prefix.
 *
 * @param {string} rootDir
 * @param {string | undefined} query
 * @param {string | null} [session] default: from the environment
 * @returns {string}
 */
export function resolveTaskName(
  rootDir,
  query,
  session = sessionFromEnv(process.env)
) {
  if (!query) {
    const active = currentTask(rootDir, session);
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
