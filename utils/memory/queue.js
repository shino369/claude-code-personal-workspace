/**
 * Extraction bookkeeping (design §6 path B), all under memory/ (gitignored):
 *
 * - `extract/open/<session>.json`: a session that started (SessionStart). If
 *   it never ends cleanly (a crash, a closed terminal), a later SessionStart
 *   queues it once its transcript has been idle for IDLE_MS.
 * - `extract/queue/<session>.json`: a session to extract (SessionEnd, or the
 *   catch-up). A session queued again replaces its entry.
 * - `extract/offsets.json`: how far each transcript was read, so every part
 *   of a transcript is extracted once, even across resumes.
 * - `extract/journal.jsonl`: one line per extraction run (what it changed).
 * - `extract/announced.json`: the last run the next session was told about.
 * - `extract/worker.lock`: one worker at a time.
 * - `inbox.jsonl`: ops that were held back for the user to review (they
 *   read like instructions to an agent).
 *
 * Hooks only write small files and start the worker detached
 * (`kickWorker`), so a session never waits for extraction.
 */
import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SESSION_ID_RE, readIfExists, writeFileAtomic } from '../task/store.js';
import { readJsonOrNull } from './store.js';
import { TRANSCRIPT_ADAPTERS } from './transcript.js';

export const EXTRACT_DIR = 'extract';
export const OPEN_DIR = 'open';
export const QUEUE_DIR = 'queue';
export const OFFSETS_FILE = 'offsets.json';
export const JOURNAL_FILE = 'journal.jsonl';
export const ANNOUNCED_FILE = 'announced.json';
export const LOCK_FILE = 'worker.lock';
export const INBOX_FILE = 'inbox.jsonl';
/** An open session whose transcript is idle this long has ended. */
export const IDLE_MS = 60 * 60 * 1000;
/** Offsets of transcripts untouched this long are forgotten. */
export const OFFSET_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A worker lock not refreshed this long belongs to a dead worker. */
export const WORKER_STALE_MS = 15 * 60 * 1000;
/** Failed extractions of one entry before it is dropped. */
export const MAX_ATTEMPTS = 3;
/** Set for the worker and the extraction agent: memory hooks stay silent. */
export const EXTRACT_ENV = 'MEMORY_EXTRACT';
export const WORKER_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'worker.js'
);

/**
 * @typedef {object} Entry
 * @property {string} session
 * @property {string} harness a harness with a transcript adapter
 * @property {string} transcript absolute path of the JSONL transcript
 * @property {string | null} cwd where the session ran
 * @property {string} at when it was registered or queued (ISO)
 * @property {number} attempts failed extractions so far
 * @property {string} [error] the last failure
 *
 * @typedef {{ offset: number, at: string }} Offset
 * @typedef {{ release: () => void, refresh: () => void }} Lock
 */

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {string} dir the memory directory */
const extractDir = (dir) => path.join(dir, EXTRACT_DIR);

/**
 * @param {string} dir
 * @param {string} sub
 * @param {string} session
 */
const entryFile = (dir, sub, session) =>
  path.join(extractDir(dir), sub, `${session}.json`);

/**
 * A valid entry, or null. The session id becomes a file name, so it must
 * match SESSION_ID_RE.
 *
 * @param {any} input
 * @returns {Entry | null}
 */
export function normalizeEntry(input) {
  if (
    !isObject(input) ||
    typeof input.session !== 'string' ||
    !SESSION_ID_RE.test(input.session) ||
    !Object.hasOwn(TRANSCRIPT_ADAPTERS, input.harness) ||
    typeof input.transcript !== 'string' ||
    !path.isAbsolute(input.transcript) ||
    !input.transcript.endsWith('.jsonl') ||
    typeof input.at !== 'string'
  ) {
    return null;
  }
  return {
    session: input.session,
    harness: input.harness,
    transcript: input.transcript,
    cwd: typeof input.cwd === 'string' ? input.cwd : null,
    at: input.at,
    attempts: Number.isInteger(input.attempts) ? input.attempts : 0,
    ...(typeof input.error === 'string' ? { error: input.error } : {}),
  };
}

/**
 * @param {string} file
 * @param {Entry} entry
 */
function writeEntry(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(entry));
}

/**
 * The entries in one folder, oldest first. Files that are not entries are
 * removed (only this module writes there).
 *
 * @param {string} dir
 * @param {string} sub
 * @returns {Entry[]}
 */
function readEntries(dir, sub) {
  const folder = path.join(extractDir(dir), sub);
  if (!fs.existsSync(folder)) return [];
  /** @type {Entry[]} */
  const entries = [];
  for (const name of fs.readdirSync(folder)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(folder, name);
    const entry = normalizeEntry(readJsonOrNull(file));
    if (entry) entries.push(entry);
    else fs.rmSync(file, { force: true });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/** @param {string} dir */
export const readOpen = (dir) => readEntries(dir, OPEN_DIR);

/** @param {string} dir */
export const readQueue = (dir) => readEntries(dir, QUEUE_DIR);

/**
 * Record a session that started, so a crash does not lose it.
 *
 * @param {string} dir
 * @param {unknown} input
 * @returns {boolean} false for an invalid entry
 */
export function registerOpen(dir, input) {
  const entry = normalizeEntry(input);
  if (!entry) return false;
  writeEntry(entryFile(dir, OPEN_DIR, entry.session), entry);
  return true;
}

/**
 * Queue a session for extraction (it is no longer open).
 *
 * @param {string} dir
 * @param {unknown} input
 * @returns {boolean} false for an invalid entry
 */
export function enqueue(dir, input) {
  const entry = normalizeEntry(input);
  if (!entry) return false;
  const { error: _error, ...fresh } = entry;
  writeEntry(entryFile(dir, QUEUE_DIR, entry.session), {
    ...fresh,
    attempts: 0,
  });
  fs.rmSync(entryFile(dir, OPEN_DIR, entry.session), { force: true });
  return true;
}

/**
 * Queue the open sessions (other than `current`) whose transcript has been
 * idle for `idleMs`; forget those whose transcript is gone.
 *
 * @param {string} dir
 * @param {{ current: string | null, now?: Date, idleMs?: number }} options
 * @returns {number} sessions queued
 */
export function catchUp(dir, { current, now = new Date(), idleMs = IDLE_MS }) {
  let queued = 0;
  for (const entry of readOpen(dir)) {
    if (entry.session === current) continue;
    const stat = fs.statSync(entry.transcript, { throwIfNoEntry: false });
    if (!stat) {
      fs.rmSync(entryFile(dir, OPEN_DIR, entry.session), { force: true });
    } else if (now.getTime() - stat.mtimeMs >= idleMs) {
      enqueue(dir, { ...entry, at: now.toISOString() });
      queued += 1;
    }
  }
  return queued;
}

/**
 * The queued entry for `entry`'s session, if it is still `entry` (the
 * session was not queued again meanwhile).
 *
 * @param {string} dir
 * @param {Entry} entry
 */
function sameQueued(dir, entry) {
  const file = entryFile(dir, QUEUE_DIR, entry.session);
  const current = normalizeEntry(readJsonOrNull(file));
  return current?.at === entry.at ? file : null;
}

/**
 * Remove a processed entry, unless the session was queued again meanwhile.
 *
 * @param {string} dir
 * @param {Entry} entry
 */
export function finishEntry(dir, entry) {
  const file = sameQueued(dir, entry);
  if (file) fs.rmSync(file, { force: true });
}

/**
 * Count a failed attempt; drop the entry after MAX_ATTEMPTS.
 *
 * @param {string} dir
 * @param {Entry} entry
 * @param {string} error
 * @returns {{ attempts: number, gaveUp: boolean }}
 */
export function retryEntry(dir, entry, error) {
  const attempts = entry.attempts + 1;
  const file = sameQueued(dir, entry);
  if (!file) return { attempts, gaveUp: false };
  if (attempts >= MAX_ATTEMPTS) {
    fs.rmSync(file, { force: true });
    return { attempts, gaveUp: true };
  }
  writeEntry(file, { ...entry, attempts, error });
  return { attempts, gaveUp: false };
}

/** @param {string} dir */
const offsetsFile = (dir) => path.join(extractDir(dir), OFFSETS_FILE);

/**
 * @param {string} dir
 * @returns {Record<string, Offset>}
 */
export function readOffsets(dir) {
  const data = readJsonOrNull(offsetsFile(dir));
  return isObject(data) ? /** @type {Record<string, Offset>} */ (data) : {};
}

/**
 * Record how far a session's transcript was read; forget offsets older than
 * OFFSET_MAX_AGE_MS. Only the worker (under its lock) writes offsets.
 *
 * @param {string} dir
 * @param {string} session
 * @param {number} offset bytes
 * @param {Date} now
 */
export function writeOffset(dir, session, offset, now) {
  /** @type {Record<string, Offset>} */
  const kept = {};
  for (const [id, value] of Object.entries(readOffsets(dir))) {
    if (now.getTime() - Date.parse(value.at) <= OFFSET_MAX_AGE_MS) {
      kept[id] = value;
    }
  }
  kept[session] = { offset, at: now.toISOString() };
  fs.mkdirSync(extractDir(dir), { recursive: true });
  writeFileAtomic(offsetsFile(dir), JSON.stringify(kept));
}

/**
 * @param {string} file
 * @param {unknown[]} items
 */
function appendLines(file, items) {
  if (items.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    items.map((item) => `${JSON.stringify(item)}\n`).join(''),
    'utf-8'
  );
}

/**
 * @param {string} file
 * @returns {Record<string, any>[]} the lines that are JSON objects
 */
function readLines(file) {
  const content = readIfExists(file);
  if (content === null) return [];
  /** @type {Record<string, any>[]} */
  const items = [];
  for (const line of content.split('\n')) {
    try {
      const item = JSON.parse(line);
      if (isObject(item)) items.push(item);
    } catch {
      // A torn or foreign line; skip it.
    }
  }
  return items;
}

/** @param {string} dir */
const journalFile = (dir) => path.join(extractDir(dir), JOURNAL_FILE);

/**
 * @param {string} dir
 * @param {Record<string, unknown>} run
 */
export const appendJournal = (dir, run) => appendLines(journalFile(dir), [run]);

/** @param {string} dir */
export const readJournal = (dir) => readLines(journalFile(dir));

/** @param {string} dir */
const inboxFile = (dir) => path.join(dir, INBOX_FILE);

/**
 * @param {string} dir
 * @param {Record<string, unknown>[]} items
 */
export const appendInbox = (dir, items) => appendLines(inboxFile(dir), items);

/** @param {string} dir */
export const readInbox = (dir) => readLines(inboxFile(dir));

/** @param {string} dir */
export const clearInbox = (dir) => fs.rmSync(inboxFile(dir), { force: true });

/** @param {string} dir */
const announcedFile = (dir) => path.join(extractDir(dir), ANNOUNCED_FILE);

/**
 * @param {string} dir
 * @returns {string | null} the time of the last run announced
 */
export function readAnnounced(dir) {
  const data = /** @type {any} */ (readJsonOrNull(announcedFile(dir)));
  return typeof data?.at === 'string' ? data.at : null;
}

/**
 * @param {string} dir
 * @param {string} at
 */
export function writeAnnounced(dir, at) {
  fs.mkdirSync(extractDir(dir), { recursive: true });
  writeFileAtomic(announcedFile(dir), JSON.stringify({ at }));
}

/**
 * Whether a process exists (one we may not signal still exists).
 *
 * @param {number} pid
 */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * @typedef {{ now?: () => number, pid?: number, isAlive?: (pid: number) => boolean, staleMs?: number }} LockOptions
 */

/** @param {string} dir */
const lockFile = (dir) => path.join(extractDir(dir), LOCK_FILE);

/**
 * A lock is stale when it is missing, was not refreshed for `staleMs`, or
 * its worker is gone.
 *
 * @param {string} file
 * @param {Required<Pick<LockOptions, 'now' | 'isAlive' | 'staleMs'>>} options
 */
function lockStale(file, { now, isAlive, staleMs }) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat || now() - stat.mtimeMs > staleMs) return true;
  const held = /** @type {any} */ (readJsonOrNull(file));
  return typeof held?.pid === 'number' && !isAlive(held.pid);
}

/**
 * Whether a live worker holds the lock.
 *
 * @param {string} dir
 * @param {LockOptions} [options]
 */
export function workerRunning(
  dir,
  { now = Date.now, isAlive = processAlive, staleMs = WORKER_STALE_MS } = {}
) {
  return !lockStale(lockFile(dir), { now, isAlive, staleMs });
}

/**
 * Take the worker lock, or null when a live worker holds it. A stale lock is
 * taken over. Two workers taking over the same stale lock at once only
 * repeat work: offsets and near-duplicate merging keep the notes right.
 *
 * @param {string} dir
 * @param {LockOptions} [options]
 * @returns {Lock | null}
 */
export function tryLock(
  dir,
  {
    now = Date.now,
    pid = process.pid,
    isAlive = processAlive,
    staleMs = WORKER_STALE_MS,
  } = {}
) {
  const file = lockFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify({ pid, at: new Date(now()).toISOString() });
  try {
    fs.writeFileSync(file, content, { flag: 'wx' });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') {
      throw error;
    }
    if (!lockStale(file, { now, isAlive, staleMs })) return null;
    fs.writeFileSync(file, content);
  }
  return {
    release() {
      const held = /** @type {any} */ (readJsonOrNull(file));
      if (held?.pid === pid) fs.rmSync(file, { force: true });
    },
    refresh() {
      const time = new Date();
      fs.utimesSync(file, time, time);
    },
  };
}

/**
 * Start the extraction worker detached (it outlives the hook) with the
 * memory hooks silenced for it and the agent it runs.
 *
 * @param {{ rootDir: string, env?: NodeJS.ProcessEnv, spawn?: typeof nodeSpawn, execPath?: string }} options
 */
export function kickWorker({
  rootDir,
  env = process.env,
  spawn = nodeSpawn,
  execPath = process.execPath,
}) {
  const child = spawn(execPath, [WORKER_SCRIPT], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env, [EXTRACT_ENV]: '1' },
  });
  // A worker that cannot start is retried by the next session's catch-up.
  child.on('error', () => {});
  child.unref();
}
