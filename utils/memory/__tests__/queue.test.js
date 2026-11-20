/**
 * Tests for utils/memory/queue.js (extraction queue, offsets, journal, lock)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  EXTRACT_DIR,
  EXTRACT_ENV,
  IDLE_MS,
  JOURNAL_FILE,
  LOCK_FILE,
  MAX_ATTEMPTS,
  OFFSETS_FILE,
  OFFSET_MAX_AGE_MS,
  OPEN_DIR,
  QUEUE_DIR,
  WORKER_SCRIPT,
  WORKER_STALE_MS,
  appendInbox,
  appendJournal,
  catchUp,
  clearInbox,
  enqueue,
  finishEntry,
  kickWorker,
  normalizeEntry,
  processAlive,
  readAnnounced,
  readInbox,
  readJournal,
  readOffsets,
  readOpen,
  readQueue,
  registerOpen,
  retryEntry,
  tryLock,
  workerRunning,
  writeAnnounced,
  writeOffset,
} from '../queue.js';

/** @type {string} */
let dir;
/** @type {string} */
let transcript;

const NOW = new Date('2026-11-20T12:00:00.000Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-queue-'));
  transcript = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(transcript, '{}\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** @param {object} [extra] */
const entry = (extra = {}) => ({
  session: 'sess-1',
  harness: 'claude',
  transcript,
  cwd: '/work/web',
  at: NOW.toISOString(),
  ...extra,
});

/** @param {string} sub @param {string} session */
const fileOf = (sub, session) =>
  path.join(dir, EXTRACT_DIR, sub, `${session}.json`);

describe('normalizeEntry', () => {
  test('should keep a valid entry', () => {
    expect(normalizeEntry(entry())).toEqual({ ...entry(), attempts: 0 });
  });

  test('should keep attempts and the last error', () => {
    expect(normalizeEntry(entry({ attempts: 2, error: 'timeout' }))).toEqual({
      ...entry(),
      attempts: 2,
      error: 'timeout',
    });
  });

  test('should default a missing working directory to null', () => {
    expect(normalizeEntry(entry({ cwd: 7 }))?.cwd).toBeNull();
  });

  test.each([
    ['not an object', null],
    ['a bad session id', entry({ session: '../evil' })],
    ['a harness without a transcript adapter', entry({ harness: 'codex' })],
    ['a relative transcript path', entry({ transcript: 'x.jsonl' })],
    ['a transcript that is not JSONL', entry({ transcript: '/tmp/x.txt' })],
    ['no time', entry({ at: 5 })],
  ])('should refuse %s', (_label, input) => {
    expect(normalizeEntry(input)).toBeNull();
  });
});

describe('registerOpen and enqueue', () => {
  test('should record an open session', () => {
    expect(registerOpen(dir, entry())).toBe(true);

    expect(readOpen(dir)).toEqual([{ ...entry(), attempts: 0 }]);
  });

  test('should refuse an invalid entry', () => {
    expect(registerOpen(dir, entry({ session: '' }))).toBe(false);
    expect(enqueue(dir, entry({ session: '' }))).toBe(false);
    expect(fs.existsSync(path.join(dir, EXTRACT_DIR))).toBe(false);
  });

  test('should move an open session to the queue', () => {
    registerOpen(dir, entry());

    expect(enqueue(dir, entry({ at: '2026-11-20T13:00:00.000Z' }))).toBe(true);

    expect(readOpen(dir)).toEqual([]);
    expect(readQueue(dir)).toEqual([
      { ...entry({ at: '2026-11-20T13:00:00.000Z' }), attempts: 0 },
    ]);
  });

  test('should list entries oldest first and remove broken files', () => {
    enqueue(dir, entry({ session: 'b', at: '2026-11-20T13:00:00.000Z' }));
    enqueue(dir, entry({ session: 'a', at: '2026-11-20T11:00:00.000Z' }));
    fs.writeFileSync(fileOf(QUEUE_DIR, 'broken'), '{nope');
    fs.writeFileSync(path.join(dir, EXTRACT_DIR, QUEUE_DIR, 'note.txt'), '');

    expect(readQueue(dir).map((e) => e.session)).toEqual(['a', 'b']);
    expect(fs.existsSync(fileOf(QUEUE_DIR, 'broken'))).toBe(false);
  });

  test('should read an empty queue before anything was queued', () => {
    expect(readQueue(dir)).toEqual([]);
  });
});

describe('catchUp', () => {
  test('should queue open sessions idle for a while, not the current one', () => {
    const old = new Date(NOW.getTime() - IDLE_MS - 1000);
    const other = path.join(dir, 'other.jsonl');
    fs.writeFileSync(other, '{}\n');
    fs.utimesSync(other, old, old);
    fs.utimesSync(transcript, old, old);
    registerOpen(dir, entry({ session: 'other', transcript: other }));
    registerOpen(dir, entry());

    const queued = catchUp(dir, { current: 'sess-1', now: NOW });

    expect(queued).toBe(1);
    expect(readQueue(dir).map((e) => e.session)).toEqual(['other']);
    expect(readQueue(dir)[0].at).toBe(NOW.toISOString());
    expect(readOpen(dir).map((e) => e.session)).toEqual(['sess-1']);
  });

  test('should leave a session that is still active', () => {
    registerOpen(dir, entry({ session: 'other' }));

    expect(catchUp(dir, { current: null, now: new Date() })).toBe(0);
    expect(readOpen(dir)).toHaveLength(1);
  });

  test('should forget an open session whose transcript is gone', () => {
    registerOpen(dir, entry({ session: 'gone', transcript: '/nope/x.jsonl' }));

    expect(catchUp(dir, { current: null, now: NOW })).toBe(0);
    expect(readOpen(dir)).toEqual([]);
  });

  test('should use the current time by default', () => {
    expect(catchUp(dir, { current: null })).toBe(0);
  });
});

describe('finishEntry and retryEntry', () => {
  test('should remove a finished entry', () => {
    enqueue(dir, entry());

    finishEntry(dir, readQueue(dir)[0]);

    expect(readQueue(dir)).toEqual([]);
  });

  test('should keep an entry queued again while it was processed', () => {
    enqueue(dir, entry());
    const [first] = readQueue(dir);
    enqueue(dir, entry({ at: '2026-11-20T14:00:00.000Z' }));

    finishEntry(dir, first);
    const retry = retryEntry(dir, first, 'boom');

    expect(readQueue(dir)).toEqual([
      { ...entry({ at: '2026-11-20T14:00:00.000Z' }), attempts: 0 },
    ]);
    expect(retry).toEqual({ attempts: 1, gaveUp: false });
  });

  test('should count a failed attempt and keep the error', () => {
    enqueue(dir, entry());

    const retry = retryEntry(dir, readQueue(dir)[0], 'timeout');

    expect(retry).toEqual({ attempts: 1, gaveUp: false });
    expect(readQueue(dir)[0]).toMatchObject({ attempts: 1, error: 'timeout' });
  });

  test('should give up after the last attempt', () => {
    enqueue(dir, entry());
    const [queued] = readQueue(dir);

    const retry = retryEntry(
      dir,
      { ...queued, attempts: MAX_ATTEMPTS - 1 },
      'timeout'
    );

    expect(retry).toEqual({ attempts: MAX_ATTEMPTS, gaveUp: true });
    expect(readQueue(dir)).toEqual([]);
  });
});

describe('offsets', () => {
  test('should read no offsets before any run', () => {
    expect(readOffsets(dir)).toEqual({});
  });

  test('should store an offset per session', () => {
    writeOffset(dir, 'sess-1', 120, NOW);
    writeOffset(dir, 'sess-2', 7, NOW);

    expect(readOffsets(dir)).toEqual({
      'sess-1': { offset: 120, at: NOW.toISOString() },
      'sess-2': { offset: 7, at: NOW.toISOString() },
    });
  });

  test('should prune offsets of sessions long gone', () => {
    const old = new Date(NOW.getTime() - OFFSET_MAX_AGE_MS - 1000);
    writeOffset(dir, 'old', 5, old);

    writeOffset(dir, 'sess-1', 10, NOW);

    expect(Object.keys(readOffsets(dir))).toEqual(['sess-1']);
  });

  test('should ignore a broken offsets file', () => {
    fs.mkdirSync(path.join(dir, EXTRACT_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, EXTRACT_DIR, OFFSETS_FILE), '[1]');

    expect(readOffsets(dir)).toEqual({});
  });
});

describe('journal, inbox, and announcements', () => {
  test('should append runs and read them back, skipping bad lines', () => {
    appendJournal(dir, { at: 'a', status: 'applied' });
    fs.appendFileSync(path.join(dir, EXTRACT_DIR, JOURNAL_FILE), 'nope\n7\n');
    appendJournal(dir, { at: 'b', status: 'failed' });

    expect(readJournal(dir)).toEqual([
      { at: 'a', status: 'applied' },
      { at: 'b', status: 'failed' },
    ]);
  });

  test('should read an empty journal and inbox before any run', () => {
    expect(readJournal(dir)).toEqual([]);
    expect(readInbox(dir)).toEqual([]);
  });

  test('should append quarantined ops to the inbox', () => {
    appendInbox(dir, [{ reason: 'x' }, { reason: 'y' }]);
    appendInbox(dir, []);

    expect(readInbox(dir)).toEqual([{ reason: 'x' }, { reason: 'y' }]);
  });

  test('should clear the inbox', () => {
    appendInbox(dir, [{ reason: 'x' }]);

    clearInbox(dir);
    clearInbox(dir);

    expect(readInbox(dir)).toEqual([]);
  });

  test('should remember the last announced run', () => {
    expect(readAnnounced(dir)).toBeNull();

    writeAnnounced(dir, NOW.toISOString());

    expect(readAnnounced(dir)).toBe(NOW.toISOString());
  });
});

describe('tryLock', () => {
  const lockFile = () => path.join(dir, EXTRACT_DIR, LOCK_FILE);
  const alive = () => true;

  test('should take a free lock and release it', () => {
    const lock = tryLock(dir, { pid: 11, isAlive: alive });

    expect(lock).not.toBeNull();
    expect(workerRunning(dir, { isAlive: alive })).toBe(true);
    lock?.release();
    expect(fs.existsSync(lockFile())).toBe(false);
    expect(workerRunning(dir)).toBe(false);
  });

  test('should refuse a lock another live worker holds', () => {
    tryLock(dir, { pid: 11, isAlive: alive });

    expect(tryLock(dir, { pid: 12, isAlive: alive })).toBeNull();
  });

  test('should take over the lock of a dead worker', () => {
    tryLock(dir, { pid: 11, isAlive: alive });

    const lock = tryLock(dir, { pid: 12, isAlive: (pid) => pid !== 11 });

    expect(lock).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf-8')).pid).toBe(12);
  });

  test('should take over a stale lock', () => {
    tryLock(dir, { pid: 11, isAlive: alive });
    const later = Date.now() + WORKER_STALE_MS + 1000;

    expect(
      tryLock(dir, { pid: 12, isAlive: alive, now: () => later })
    ).not.toBeNull();
  });

  test('should take over a lock without a readable owner when it is stale', () => {
    fs.mkdirSync(path.join(dir, EXTRACT_DIR), { recursive: true });
    fs.writeFileSync(lockFile(), 'garbage');

    expect(tryLock(dir, { pid: 12, isAlive: alive })).toBeNull();
    expect(
      tryLock(dir, {
        pid: 12,
        isAlive: alive,
        now: () => Date.now() + WORKER_STALE_MS + 1000,
      })
    ).not.toBeNull();
  });

  test('should keep the lock fresh while working', () => {
    const lock = tryLock(dir, { pid: 11, isAlive: alive });
    const old = new Date(Date.now() - WORKER_STALE_MS);
    fs.utimesSync(lockFile(), old, old);

    lock?.refresh();

    expect(Date.now() - fs.statSync(lockFile()).mtimeMs).toBeLessThan(60_000);
  });

  test('should not release a lock another worker took over', () => {
    const lock = tryLock(dir, { pid: 11, isAlive: alive });
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 12 }));

    lock?.release();

    expect(fs.existsSync(lockFile())).toBe(true);
  });

  test('should rethrow errors other than an existing lock', () => {
    const create = () => {
      throw Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
    };

    expect(() => tryLock(dir, { create })).toThrow(/EACCES/);
  });
});

describe('processAlive', () => {
  test('should see this process as alive', () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  test('should see a process that does not exist as dead', () => {
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });

  test('should count a process it may not signal as alive', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });

    expect(processAlive(1)).toBe(true);
    kill.mockRestore();
  });
});

describe('kickWorker', () => {
  test('should start the worker detached, with the hooks silenced', () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);

    kickWorker({
      rootDir: '/work',
      env: { PATH: '/bin' },
      spawn: /** @type {any} */ (spawn),
      execPath: '/usr/bin/node',
    });

    expect(spawn).toHaveBeenCalledWith('/usr/bin/node', [WORKER_SCRIPT], {
      cwd: '/work',
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { PATH: '/bin', [EXTRACT_ENV]: '1' },
    });
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalled();
    // A spawn error must not crash the hook.
    expect(() => child.on.mock.calls[0][1]()).not.toThrow();
  });

  test('should point at the worker script', () => {
    expect(fs.existsSync(WORKER_SCRIPT)).toBe(true);
    expect(path.basename(WORKER_SCRIPT)).toBe('worker.js');
  });

  test('should name the open and queue folders', () => {
    expect([OPEN_DIR, QUEUE_DIR]).toEqual(['open', 'queue']);
  });
});
