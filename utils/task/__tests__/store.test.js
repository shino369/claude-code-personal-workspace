import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { appendSeparator } from '../markdown.js';
import { createState, makeSteps } from '../state.js';
import {
  TASK_SUBDIRS,
  TEMPLATES_DIR,
  appendNotes,
  listTaskNames,
  loadTask,
  readActive,
  readIfExists,
  resolveTaskName,
  saveState,
  scaffoldTask,
  tasksRoot,
  updateState,
  withLock,
  writeActive,
  writeFileAtomic,
} from '../store.js';

/** @type {string} */
let root;

const NOW = new Date(2026, 10, 17, 10, 0);

/** @param {string} name */
const taskDir = (name) => path.join(tasksRoot(root), name);

/**
 * @param {string} name
 * @param {Record<string, string>} files
 */
function makeTaskDir(name, files) {
  fs.mkdirSync(taskDir(name), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(taskDir(name), file), content);
  }
}

/** @param {string} name */
const state = (name) =>
  createState({ name, goal: 'G', steps: makeSteps(['A']), now: NOW });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readIfExists', () => {
  test('should return null for a missing file', () => {
    expect(readIfExists(path.join(root, 'nope'))).toBeNull();
  });

  test('should rethrow errors other than ENOENT', () => {
    expect(() => readIfExists(root)).toThrow(/EISDIR/);
  });
});

describe('writeFileAtomic', () => {
  test('should write the content and leave no temp file', () => {
    const file = path.join(root, 'a.txt');
    writeFileAtomic(file, 'hello');
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello');
    expect(fs.readdirSync(root)).toEqual(['a.txt']);
  });

  test('should remove the temp file when the rename fails', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('rename failed');
    });
    expect(() => writeFileAtomic(path.join(root, 'a.txt'), 'x')).toThrow(
      'rename failed'
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test('should retry a rename Windows refuses while the file is in use', () => {
    const realRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('in use'), { code: 'EPERM' });
      })
      .mockImplementation(realRename);
    const file = path.join(root, 'a.txt');
    writeFileAtomic(file, 'hello', { platform: 'win32' });
    expect(fs.readFileSync(file, 'utf-8')).toBe('hello');
    expect(fs.readdirSync(root)).toEqual(['a.txt']);
  });

  test('should give up on a busy rename after the retry time, and not retry elsewhere', () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('in use'), { code: 'EBUSY' });
    });
    const file = path.join(root, 'a.txt');
    expect(() =>
      writeFileAtomic(file, 'x', { platform: 'win32', retryMs: 30 })
    ).toThrow('in use');
    expect(rename.mock.calls.length).toBeGreaterThan(1);
    rename.mockClear();
    expect(() => writeFileAtomic(file, 'x', { platform: 'linux' })).toThrow(
      'in use'
    );
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('withLock', () => {
  test('should return the result and release the lock', () => {
    expect(withLock(root, () => 42)).toBe(42);
    expect(fs.existsSync(path.join(root, '.lock'))).toBe(false);
  });

  test('should release the lock when the callback throws', () => {
    expect(() =>
      withLock(root, () => {
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(fs.existsSync(path.join(root, '.lock'))).toBe(false);
  });

  test('should take over a stale lock', () => {
    fs.writeFileSync(path.join(root, '.lock'), '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(root, '.lock'), old, old);
    expect(withLock(root, () => 'ok')).toBe('ok');
  });

  test('should retry when the lock disappears between checks', () => {
    fs.writeFileSync(path.join(root, '.lock'), '');
    const realStat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      fs.rmSync(path.join(root, '.lock'));
      return undefined;
    });
    expect(withLock(root, () => 'ok')).toBe('ok');
    expect(realStat).toBeDefined();
  });

  test('should wait and then time out on a fresh lock', () => {
    fs.writeFileSync(path.join(root, '.lock'), '');
    let clock = Date.now();
    const now = () => (clock += 60);
    expect(() =>
      withLock(root, () => 'never', { timeoutMs: 100, now })
    ).toThrow(/locked by another process/);
    expect(fs.existsSync(path.join(root, '.lock'))).toBe(true);
  });

  test('should wait out a lock Windows is still deleting (EPERM)', () => {
    const realOpen = fs.openSync;
    const open = vi
      .spyOn(fs, 'openSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('delete pending'), { code: 'EPERM' });
      })
      .mockImplementation(realOpen);
    expect(withLock(root, () => 'ok', { platform: 'win32' })).toBe('ok');
    expect(open).toHaveBeenCalledTimes(2);
  });

  test('should rethrow EPERM off Windows', () => {
    vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => withLock(root, () => 1, { platform: 'linux' })).toThrow(
      'denied'
    );
  });

  test('should rethrow errors other than EEXIST', () => {
    expect(() => withLock(path.join(root, 'missing'), () => 1)).toThrow(
      /ENOENT/
    );
  });
});

describe('listTaskNames', () => {
  test('should return an empty list without a tasks directory', () => {
    expect(listTaskNames(root)).toEqual([]);
  });

  test('should list only task directories, sorted', () => {
    makeTaskDir('b-task', { 'NOTES.md': '' });
    makeTaskDir('a-task', { 'plan.md': '' });
    makeTaskDir('c-task', { 'state.json': '{}' });
    makeTaskDir('empty', {});
    makeTaskDir('.hidden', { 'plan.md': '' });
    fs.writeFileSync(path.join(tasksRoot(root), 'file.md'), '');
    expect(listTaskNames(root)).toEqual(['a-task', 'b-task', 'c-task']);
  });
});

describe('active task pointer', () => {
  test('should return null when unset', () => {
    expect(readActive(root)).toBeNull();
  });

  test('should round-trip a name and clear it', () => {
    makeTaskDir('a-task', { 'plan.md': '' });
    writeActive(root, 'a-task');
    expect(readActive(root)).toBe('a-task');
    writeActive(root, null);
    expect(readActive(root)).toBeNull();
  });

  test('should ignore an invalid or vanished name', () => {
    fs.mkdirSync(tasksRoot(root));
    fs.writeFileSync(path.join(tasksRoot(root), '.active'), '../etc\n');
    expect(readActive(root)).toBeNull();
    fs.writeFileSync(path.join(tasksRoot(root), '.active'), 'gone-task\n');
    expect(readActive(root)).toBeNull();
    fs.writeFileSync(path.join(tasksRoot(root), '.active'), '\n');
    expect(readActive(root)).toBeNull();
  });
});

describe('resolveTaskName', () => {
  beforeEach(() => {
    makeTaskDir('alpha-261117', { 'plan.md': '' });
    makeTaskDir('alpha-two-261117', { 'plan.md': '' });
    makeTaskDir('beta-261117', { 'plan.md': '' });
  });

  test('should use the active task when no query is given', () => {
    writeActive(root, 'beta-261117');
    expect(resolveTaskName(root, undefined)).toBe('beta-261117');
  });

  test('should explain how to pick a task when none is active', () => {
    expect(() => resolveTaskName(root, '')).toThrow(/No active task\.\nFix:/);
  });

  test('should reject an unsafe query', () => {
    expect(() => resolveTaskName(root, '../x')).toThrow(/Invalid task name/);
  });

  test.each([
    ['alpha-261117', 'alpha-261117'],
    ['alpha', 'alpha-261117'],
    ['bet', 'beta-261117'],
  ])('should resolve %s', (query, expected) => {
    expect(resolveTaskName(root, query)).toBe(expected);
  });

  test('should report no match with a fix', () => {
    expect(() => resolveTaskName(root, 'gamma')).toThrow(
      /No task matches "gamma"[\s\S]*pnpm task new gamma/
    );
  });

  test('should report an ambiguous prefix', () => {
    expect(() => resolveTaskName(root, 'al')).toThrow(
      /matches several tasks: alpha-261117, alpha-two-261117/
    );
  });
});

describe('loadTask', () => {
  test('should load a hand-written task without state', () => {
    makeTaskDir('a-task', { 'plan.md': 'P', 'NOTES.md': 'N' });
    expect(loadTask(root, 'a-task')).toEqual({
      name: 'a-task',
      dir: taskDir('a-task'),
      state: null,
      plan: 'P',
      notes: 'N',
    });
  });

  test('should load and validate state.json', () => {
    makeTaskDir('a-task', { 'state.json': JSON.stringify(state('a-task')) });
    expect(loadTask(root, 'a-task').state?.goal).toBe('G');
  });

  test('should explain invalid JSON', () => {
    makeTaskDir('a-task', { 'state.json': '{' });
    expect(() => loadTask(root, 'a-task')).toThrow(
      /a-task\/state\.json is not valid JSON/
    );
  });

  test('should report schema problems', () => {
    makeTaskDir('a-task', { 'state.json': '{"version":1}' });
    expect(() => loadTask(root, 'a-task')).toThrow(
      /Invalid a-task\/state\.json/
    );
  });
});

describe('saveState', () => {
  test('should write state.json without a plan', () => {
    makeTaskDir('a-task', {});
    saveState(taskDir('a-task'), state('a-task'));
    expect(loadTask(root, 'a-task').state?.name).toBe('a-task');
  });

  test('should refresh the steps block and skip identical rewrites', () => {
    const plan = '# P\n\n<!-- task:steps -->\n\nold\n\n<!-- /task:steps -->\n';
    makeTaskDir('a-task', { 'plan.md': plan });
    saveState(taskDir('a-task'), state('a-task'));
    const planFile = path.join(taskDir('a-task'), 'plan.md');
    expect(fs.readFileSync(planFile, 'utf-8')).toContain('- [ ] s1. A');

    const spy = vi.spyOn(fs, 'renameSync');
    saveState(taskDir('a-task'), state('a-task'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('should leave a plan without markers alone', () => {
    makeTaskDir('a-task', { 'plan.md': '- [ ] hand\n' });
    saveState(taskDir('a-task'), state('a-task'));
    expect(
      fs.readFileSync(path.join(taskDir('a-task'), 'plan.md'), 'utf-8')
    ).toBe('- [ ] hand\n');
  });

  test('should refuse to write invalid state', () => {
    makeTaskDir('a-task', {});
    expect(() =>
      saveState(taskDir('a-task'), {
        ...state('a-task'),
        goal: /** @type {any} */ (1),
      })
    ).toThrow(/Invalid state\.json/);
  });
});

describe('updateState', () => {
  test('should apply the change and stamp time and agent', () => {
    makeTaskDir('a-task', { 'state.json': JSON.stringify(state('a-task')) });
    const later = new Date(2026, 10, 18);
    const next = updateState(root, 'a-task', (s) => ({ ...s, next: 'n' }), {
      now: later,
      agent: 'codex',
    });
    expect(next).toMatchObject({
      next: 'n',
      updatedAt: later.toISOString(),
      lastAgent: 'codex',
    });
    expect(loadTask(root, 'a-task').state?.next).toBe('n');
  });

  test('should keep lastAgent and default the time when not given', () => {
    makeTaskDir('a-task', {
      'state.json': JSON.stringify({ ...state('a-task'), lastAgent: 'claude' }),
    });
    const next = updateState(root, 'a-task', (s) => s);
    expect(next.lastAgent).toBe('claude');
    expect(next.updatedAt).not.toBe(NOW.toISOString());
  });

  test('should point a hand-written task at init', () => {
    makeTaskDir('a-task', { 'plan.md': '' });
    expect(() => updateState(root, 'a-task', (s) => s)).toThrow(
      /Fix: pnpm task init a-task/
    );
  });
});

describe('appendNotes', () => {
  test('should create NOTES.md and append with one blank line', () => {
    makeTaskDir('a-task', {});
    appendNotes(taskDir('a-task'), '## one\n', appendSeparator);
    appendNotes(taskDir('a-task'), '## two\n', appendSeparator);
    expect(
      fs.readFileSync(path.join(taskDir('a-task'), 'NOTES.md'), 'utf-8')
    ).toBe('## one\n\n## two\n');
  });
});

describe('scaffoldTask', () => {
  test('should create the layout from the real templates', () => {
    const dir = scaffoldTask({
      rootDir: root,
      name: 'a-task',
      state: state('a-task'),
      acceptance: 'tests pass',
      date: '2026-11-17',
    });
    expect(fs.readdirSync(dir).sort()).toEqual(
      [...TASK_SUBDIRS, 'NOTES.md', 'plan.md', 'state.json'].sort()
    );
    const plan = fs.readFileSync(path.join(dir, 'plan.md'), 'utf-8');
    expect(plan).toContain('Goal: G');
    expect(plan).toContain('Acceptance: tests pass');
    expect(plan).toContain('- [ ] s1. A');
    expect(plan).not.toContain('{{');
    expect(TEMPLATES_DIR).toMatch(/templates[\\/]task$/);
  });

  test('should refuse to overwrite an existing task', () => {
    makeTaskDir('a-task', {});
    expect(() =>
      scaffoldTask({
        rootDir: root,
        name: 'a-task',
        state: state('a-task'),
        acceptance: '',
        date: '',
        templatesDir: TEMPLATES_DIR,
      })
    ).toThrow(/already exists\.\nFix: pnpm task switch a-task/);
  });
});
