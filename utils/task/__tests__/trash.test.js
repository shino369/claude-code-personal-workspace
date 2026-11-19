import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  TRASH_KEEP_MS,
  planRemoval,
  pruneTrash,
  trashPaths,
} from '../trash.js';

/** @type {string} */
let root;
/** @type {string} */
let repo;
const NOW = new Date(2026, 10, 19, 15, 4, 5);

/** @param {string} file */
const touch = (file, content = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-root-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trash-repo-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('planRemoval', () => {
  const plan = (/** @type {string} */ target, cwd = root) =>
    planRemoval({ rootDir: root, scopes: [root, repo], target, cwd });

  test('should place a workspace file under its relative path', () => {
    touch(path.join(root, 'old', 'a.js'));
    expect(plan('old/a.js')).toEqual({
      from: path.join(root, 'old', 'a.js'),
      label: 'workspace',
      rel: path.join('old', 'a.js'),
    });
  });

  test("should place a file in the task's repository under its name", () => {
    touch(path.join(repo, 'src', 'b.js'));
    expect(plan(path.join(repo, 'src', 'b.js'))).toMatchObject({
      label: `repo-${path.basename(repo)}`,
      rel: path.join('src', 'b.js'),
    });
  });

  test('should file a path under the innermost scope when scopes nest', () => {
    const nested = path.join(root, 'vendor', 'lib');
    touch(path.join(nested, 'x.js'));
    expect(
      planRemoval({
        rootDir: root,
        scopes: [root, nested],
        target: 'vendor/lib/x.js',
        cwd: root,
      })
    ).toMatchObject({ label: 'repo-lib', rel: 'x.js' });
  });

  test('should resolve ~ and paths relative to where the command ran', () => {
    touch(path.join(repo, 'c.js'));
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(repo));
    expect(plan(`~/${path.basename(repo)}/c.js`).from).toBe(
      path.join(repo, 'c.js')
    );
    expect(plan('c.js', repo).from).toBe(path.join(repo, 'c.js'));
  });

  test('should ignore a scope folder that no longer exists', () => {
    touch(path.join(root, 'stale.txt'));
    expect(
      planRemoval({
        rootDir: root,
        scopes: [root, path.join(repo, 'moved-away')],
        target: 'stale.txt',
        cwd: root,
      }).label
    ).toBe('workspace');
  });

  test('should refuse a path that does not exist', () => {
    expect(() => plan('nope.js')).toThrow(/nope\.js: no such file or folder/);
  });

  test('should refuse a path outside the workspace and the task repository', () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'trash-out-'))
    );
    try {
      touch(path.join(outside, 'x.js'));
      expect(() => plan(path.join(outside, 'x.js'))).toThrow(
        /outside this workspace and the task's repository/
      );
      expect(() =>
        plan(path.join(root, '..', path.basename(outside), 'x.js'))
      ).toThrow(/outside/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test.each([
    ['the workspace itself', '.', /is the workspace or the repository itself/],
    ['git internals', '.git/config', /inside \.git/],
    ['the tasks folder', 'tasks', /task records/],
    ['a whole task', 'tasks/demo-261117', /task records/],
    ['task bookkeeping', 'tasks/demo-261117/state.json', /task records/],
    ['the notes', 'tasks/demo-261117/NOTES.md', /task records/],
    ['the trash', 'tasks/.trash/x', /task records/],
    ['session bindings', 'tasks/.sessions/s.json', /task records/],
    ['an env file', '.env.local', /secrets/],
    ['a key', 'deploy/id.pem', /secrets/],
    ['a secrets folder', 'secrets/token.txt', /secrets/],
  ])('should refuse %s', (_label, target, message) => {
    touch(path.join(root, target === '.' ? 'keep.txt' : target));
    expect(() => plan(target)).toThrow(message);
  });

  test.each([
    [
      'an env file deep inside',
      'app/deep/.env',
      /app.deep.\.env, which looks like secrets/,
    ],
    [
      'a key file',
      'app/server.key',
      /app.server\.key, which looks like secrets/,
    ],
    [
      'a secrets folder',
      'app/secrets/token.txt',
      /app.secrets, which looks like secrets/,
    ],
    [
      'a nested repository',
      'app/vendor/.git/HEAD',
      /app.vendor.\.git, a git repository/,
    ],
    ['a worktree link', 'app/wt/.git', /app.wt.\.git, a git repository/],
  ])('should refuse a folder that holds %s', (_label, inner, message) => {
    touch(path.join(root, 'app', 'ok.js'));
    touch(path.join(root, inner));
    expect(() => plan('app')).toThrow(message);
  });

  test('should name the fix when a folder holds something it never moves', () => {
    touch(path.join(root, 'app', '.env'));
    expect(() => plan('app')).toThrow(/Fix: .*one by one/);
  });

  test('should not search node_modules for secrets', () => {
    touch(path.join(root, 'app', 'node_modules', 'pkg', 'test', 'fixture.pem'));
    expect(plan('app').rel).toBe('app');
  });

  test('should not follow a symlinked folder inside the folder', () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'trash-inner-link-'))
    );
    try {
      touch(path.join(outside, '.env'));
      touch(path.join(root, 'app', 'ok.js'));
      fs.symlinkSync(outside, path.join(root, 'app', 'link'), 'junction');
      expect(plan('app').rel).toBe('app');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('should allow scratch files inside a task folder', () => {
    touch(path.join(root, 'tasks', 'demo-261117', 'tmp', 'scratch.txt'));
    expect(plan('tasks/demo-261117/tmp/scratch.txt').label).toBe('workspace');
  });

  test("should keep another repository's tasks/ folder deletable", () => {
    touch(path.join(repo, 'tasks', 'job.js'));
    expect(plan(path.join(repo, 'tasks', 'job.js')).label).toMatch(/^repo-/);
  });

  test('should move a symlink, not refuse it for where it points', () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'trash-link-'))
    );
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
      expect(plan('link').from).toBe(path.join(root, 'link'));
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('trashPaths', () => {
  test('should move every path into one dated batch and say how to restore', () => {
    touch(path.join(root, 'a.txt'), 'A');
    touch(path.join(repo, 'dir', 'b.txt'), 'B');

    const result = trashPaths({
      rootDir: root,
      scopes: [root, repo],
      paths: ['a.txt', path.join(repo, 'dir')],
      cwd: root,
      now: NOW,
    });

    const batch = path.join(root, 'tasks', '.trash', '20261119-150405');
    expect(result.batch).toBe(batch);
    expect(result.moved).toEqual([
      {
        from: path.join(root, 'a.txt'),
        to: path.join(batch, 'workspace', 'a.txt'),
      },
      {
        from: path.join(repo, 'dir'),
        to: path.join(batch, `repo-${path.basename(repo)}`, 'dir'),
      },
    ]);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
    expect(
      fs.readFileSync(path.join(batch, 'workspace', 'a.txt'), 'utf-8')
    ).toBe('A');
  });

  test('should move a folder once when a path inside it is also given', () => {
    touch(path.join(root, 'dir', 'a.txt'));
    const { moved } = trashPaths({
      rootDir: root,
      scopes: [root],
      paths: ['dir', 'dir/a.txt'],
      cwd: root,
      now: NOW,
    });
    expect(moved.map((m) => m.from)).toEqual([path.join(root, 'dir')]);
  });

  test('should move nothing when any path is refused', () => {
    touch(path.join(root, 'a.txt'));
    expect(() =>
      trashPaths({
        rootDir: root,
        scopes: [root],
        paths: ['a.txt', '.git/config'],
        cwd: root,
        now: NOW,
      })
    ).toThrow();
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);
  });

  test('should use a new batch folder when the second already exists', () => {
    touch(path.join(root, 'a.txt'));
    touch(path.join(root, 'b.txt'));
    const first = trashPaths({
      rootDir: root,
      scopes: [root],
      paths: ['a.txt'],
      cwd: root,
      now: NOW,
    });
    const second = trashPaths({
      rootDir: root,
      scopes: [root],
      paths: ['b.txt'],
      cwd: root,
      now: NOW,
    });
    expect(second.batch).toBe(`${first.batch}-2`);
  });

  test('should copy then delete when the trash is on another device', () => {
    touch(path.join(root, 'a.txt'), 'A');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('a.txt')) {
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      }
      return rename(from, to);
    });

    const { moved } = trashPaths({
      rootDir: root,
      scopes: [root],
      paths: ['a.txt'],
      cwd: root,
      now: NOW,
    });

    expect(fs.readFileSync(moved[0].to, 'utf-8')).toBe('A');
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });

  test('should rethrow other move errors', () => {
    touch(path.join(root, 'a.txt'));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() =>
      trashPaths({
        rootDir: root,
        scopes: [root],
        paths: ['a.txt'],
        cwd: root,
        now: NOW,
      })
    ).toThrow('denied');
  });

  test('should refuse an empty list', () => {
    expect(() =>
      trashPaths({
        rootDir: root,
        scopes: [root],
        paths: [],
        cwd: root,
        now: NOW,
      })
    ).toThrow(/Usage: pnpm task rm <path>/);
  });
});

describe('pruneTrash', () => {
  test('should delete batches older than the keep time and nothing else', () => {
    const trash = path.join(root, 'tasks', '.trash');
    touch(path.join(trash, 'old', 'f'));
    touch(path.join(trash, 'new', 'f'));
    touch(path.join(trash, 'loose.txt'));
    const old = new Date(NOW.getTime() - TRASH_KEEP_MS - 1000);
    fs.utimesSync(path.join(trash, 'old'), old, old);

    expect(pruneTrash(root, NOW.getTime())).toBe(1);
    expect(fs.existsSync(path.join(trash, 'old'))).toBe(false);
    expect(fs.existsSync(path.join(trash, 'new'))).toBe(true);
    expect(fs.existsSync(path.join(trash, 'loose.txt'))).toBe(true);
  });

  test('should do nothing without a trash folder', () => {
    expect(pruneTrash(root, NOW.getTime())).toBe(0);
  });
});
