import fs from 'fs';
import os from 'os';
import path from 'path';
import { queueFiles, queuePath, takeQueue } from '../format.js';

/** @type {string} */
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-safety-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * @param {{ link?: boolean, dir?: boolean, uid?: number }} [over]
 */
const fakeStat = ({ link = false, dir = true, uid = 7 } = {}) => ({
  isSymbolicLink: () => link,
  isDirectory: () => dir,
  uid,
});

/** A queue environment for user 7 whose lstat is scripted per path. */
const as = (
  /** @type {Record<string, ReturnType<typeof fakeStat> | 'missing' | 'error'>} */ stats = {},
  /** @type {Record<string, unknown>} */ more = {}
) => ({
  tmpDir,
  getuid: () => 7,
  lstat: (/** @type {string} */ file) => {
    const found = stats[path.basename(file) === 's-1.txt' ? 'file' : 'dir'];
    if (found === 'missing') {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    if (found === 'error') {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return found ?? fakeStat();
  },
  ...more,
});

describe('queue directory', () => {
  test('should be per user, by uid', () => {
    expect(queuePath('s-1', { tmpDir, getuid: () => 7 })).toBe(
      path.join(tmpDir, 'workspace-format-queue-7', 's-1.txt')
    );
  });

  test('should be per user, by user name when there is no uid', () => {
    expect(queuePath('s-1', { tmpDir, getuid: null, username: 'a b\\c' })).toBe(
      path.join(tmpDir, 'workspace-format-queue-a_b_c', 's-1.txt')
    );
    // Falls back to the real user name (process.getuid is absent on Windows).
    expect(queuePath('s-1', { tmpDir, getuid: null })).toContain(
      'workspace-format-queue-'
    );
  });

  test('should default to the OS temp dir', () => {
    expect(queuePath('s-1')?.startsWith(os.tmpdir())).toBe(true);
  });

  test('should be created private (0700) where the OS has modes', () => {
    queueFiles('s-1', ['/p/a.js'], { tmpDir });
    const dir = path.dirname(/** @type {string} */ (queuePath('s-1', tmpDir)));
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(takeQueue('s-1', { tmpDir })).toEqual(['/p/a.js']);
  });
});

describe('queue refuses an untrusted directory or file', () => {
  test('should use a queue it owns', () => {
    const options = as({ dir: fakeStat(), file: 'missing' });
    queueFiles('s-1', ['/p/a.js'], options);
    expect(
      takeQueue('s-1', as({ dir: fakeStat(), file: fakeStat({ dir: false }) }))
    ).toEqual(['/p/a.js']);
  });

  test.each([
    ['a symlinked directory', { dir: fakeStat({ link: true }) }],
    ['a directory that is not one', { dir: fakeStat({ dir: false }) }],
    ['a directory of another uid', { dir: fakeStat({ uid: 8 }) }],
    ['a symlinked file', { dir: fakeStat(), file: fakeStat({ link: true }) }],
    ['a file of another uid', { dir: fakeStat(), file: fakeStat({ uid: 8 }) }],
    ['an unreadable file', { dir: fakeStat(), file: 'error' }],
    ['a directory that vanished', { dir: 'missing' }],
  ])('should not write or read %s', (_name, stats) => {
    const options = as(/** @type {any} */ (stats));
    expect(() => queueFiles('s-1', ['/p/a.js'], options)).not.toThrow();
    const dir = path.dirname(/** @type {string} */ (queuePath('s-1', tmpDir)));
    const file = path.join(dir, 's-1.txt');
    expect(fs.existsSync(file)).toBe(false);
    // Reading refuses too, even with a queue file in place.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '/p/x.js\n');
    expect(takeQueue('s-1', options)).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  test('should skip the owner check where there is no uid', () => {
    const options = as(
      { dir: fakeStat({ uid: 99 }), file: 'missing' },
      { getuid: null, username: 'win-user' }
    );
    queueFiles('s-1', ['/p/a.js'], options);
    expect(takeQueue('s-1', options)).toEqual(['/p/a.js']);
  });

  test('should not throw when the queue cannot be created', () => {
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() =>
      queueFiles('s-1', ['/p/a.js'], { tmpDir: blocker })
    ).not.toThrow();
  });
});

describe('queue file opening', () => {
  test('should work on a platform without O_NOFOLLOW', () => {
    const { O_APPEND, O_CREAT, O_WRONLY } = fs.constants;
    queueFiles('s-1', ['/p/a.js'], {
      tmpDir,
      constants: { O_APPEND, O_CREAT, O_WRONLY },
    });
    expect(takeQueue('s-1', { tmpDir })).toEqual(['/p/a.js']);
  });
});
