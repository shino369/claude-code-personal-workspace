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
  clearSession,
  currentTask,
  listTaskNames,
  loadTask,
  pruneSessions,
  readActive,
  readIfExists,
  readSession,
  resolveTaskName,
  saveState,
  scaffoldTask,
  sessionFromEnv,
  sessionTask,
  tasksRoot,
  touchSession,
  updateState,
  withLock,
  writeActive,
  writeFileAtomic,
  writeSession,
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

describe('sessionFromEnv', () => {
  test('should prefer TASK_SESSION over Claude Code session id', () => {
    expect(
      sessionFromEnv({ TASK_SESSION: 'mine', CLAUDE_CODE_SESSION_ID: 'cc-1' })
    ).toBe('mine');
  });

  test('should use the Claude Code session id when TASK_SESSION is unset or empty', () => {
    expect(
      sessionFromEnv({ TASK_SESSION: '', CLAUDE_CODE_SESSION_ID: 'cc-1' })
    ).toBe('cc-1');
  });

  test('should return null when no id is set', () => {
    expect(sessionFromEnv({})).toBeNull();
  });

  test('should return null for an id that is not a safe file name', () => {
    expect(sessionFromEnv({ TASK_SESSION: '../etc' })).toBeNull();
  });
});

describe('session bindings', () => {
  beforeEach(() => {
    makeTaskDir('a-task', { 'plan.md': '' });
    makeTaskDir('b-task', { 'plan.md': '' });
  });

  test('should round-trip a binding and clear it', () => {
    expect(
      writeSession(root, 'sess-1', { task: 'a-task', engaged: true, now: NOW })
    ).toBe(true);
    expect(readSession(root, 'sess-1')).toEqual({
      task: 'a-task',
      engaged: true,
      updatedAt: NOW.toISOString(),
    });
    clearSession(root, 'sess-1');
    expect(readSession(root, 'sess-1')).toBeNull();
  });

  test('should keep a binding without a task', () => {
    writeSession(root, 'sess-1', { task: null, engaged: false });
    expect(readSession(root, 'sess-1')).toMatchObject({
      task: null,
      engaged: false,
    });
  });

  test('should refuse or ignore an unsafe session id', () => {
    expect(writeSession(root, '../x', { task: 'a-task', engaged: true })).toBe(
      false
    );
    expect(writeSession(root, null, { task: 'a-task', engaged: true })).toBe(
      false
    );
    expect(readSession(root, '../x')).toBeNull();
    expect(readSession(root, null)).toBeNull();
    expect(() => clearSession(root, '../x')).not.toThrow();
  });

  test('should treat a corrupt or invalid binding as no binding', () => {
    const dir = path.join(tasksRoot(root), '.sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad-json.json'), '{');
    fs.writeFileSync(
      path.join(dir, 'bad-task.json'),
      JSON.stringify({ task: '../etc', engaged: true })
    );
    fs.writeFileSync(
      path.join(dir, 'bad-flag.json'),
      JSON.stringify({ task: 'a-task', engaged: 'yes' })
    );
    fs.writeFileSync(path.join(dir, 'not-object.json'), '[]');
    for (const id of ['bad-json', 'bad-task', 'bad-flag', 'not-object']) {
      expect(readSession(root, id)).toBeNull();
    }
  });

  test('should resolve the current task from the binding, else the default', () => {
    writeActive(root, 'a-task');
    expect(currentTask(root, null)).toBe('a-task');
    expect(currentTask(root, 'unbound')).toBe('a-task');
    writeSession(root, 'sess-1', { task: 'b-task', engaged: false });
    expect(currentTask(root, 'sess-1')).toBe('b-task');
  });

  test('should fall back to the default when the bound task is gone or unset', () => {
    writeActive(root, 'a-task');
    writeSession(root, 'gone', { task: 'gone-task', engaged: true });
    writeSession(root, 'empty', { task: null, engaged: false });
    expect(currentTask(root, 'gone')).toBe('a-task');
    expect(currentTask(root, 'empty')).toBe('a-task');
  });

  test('should read the session from the environment by default', () => {
    writeSession(root, 'env-sess', { task: 'b-task', engaged: true });
    vi.stubEnv('TASK_SESSION', 'env-sess');
    expect(currentTask(root)).toBe('b-task');
    expect(resolveTaskName(root, undefined)).toBe('b-task');
    vi.unstubAllEnvs();
  });

  test('should give hooks the bound task and whether the session engaged it', () => {
    writeActive(root, 'a-task');
    writeSession(root, 'dormant', { task: 'b-task', engaged: false });
    writeSession(root, 'engaged', { task: 'b-task', engaged: true });
    expect(sessionTask(root, 'dormant')).toEqual({
      name: 'b-task',
      engaged: false,
    });
    expect(sessionTask(root, 'engaged')).toEqual({
      name: 'b-task',
      engaged: true,
    });
  });

  test('should give hooks nothing for a session bound to no task or a gone task', () => {
    writeActive(root, 'a-task');
    writeSession(root, 'empty', { task: null, engaged: false });
    writeSession(root, 'gone', { task: 'gone-task', engaged: true });
    expect(sessionTask(root, 'empty')).toBeNull();
    expect(sessionTask(root, 'gone')).toBeNull();
  });

  test('should give hooks the default task, engaged, for a session without a binding', () => {
    expect(sessionTask(root, 'unbound')).toBeNull();
    writeActive(root, 'a-task');
    expect(sessionTask(root, 'unbound')).toEqual({
      name: 'a-task',
      engaged: true,
    });
    expect(sessionTask(root, undefined)).toEqual({
      name: 'a-task',
      engaged: true,
    });
  });

  test('should prune bindings older than the age limit', () => {
    writeSession(root, 'old', { task: 'a-task', engaged: true });
    writeSession(root, 'new', { task: 'a-task', engaged: true });
    const dir = path.join(tasksRoot(root), '.sessions');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a binding');
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(dir, 'old.json'), old, old);
    expect(pruneSessions(root)).toBe(1);
    expect(readSession(root, 'old')).toBeNull();
    expect(readSession(root, 'new')).not.toBeNull();
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });

  test('should refresh the time of an existing binding only', () => {
    writeSession(root, 'live', { task: 'a-task', engaged: true });
    const file = path.join(tasksRoot(root), '.sessions', 'live.json');
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    expect(touchSession(root, 'live')).toBe(true);
    expect(pruneSessions(root)).toBe(0);
    expect(touchSession(root, 'missing')).toBe(false);
    expect(touchSession(root, '../x')).toBe(false);
  });

  test('should prune nothing without a sessions folder', () => {
    expect(pruneSessions(root, { now: Date.now(), maxAgeMs: 0 })).toBe(0);
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
