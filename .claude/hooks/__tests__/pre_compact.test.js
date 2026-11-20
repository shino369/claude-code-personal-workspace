/**
 * Tests for pre_compact.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createState } from '#utils/task/state.js';
import { saveState, writeSession } from '#utils/task/store.js';
import { processHookInput } from '../pre_compact.js';

/** @type {string} */
let root;
const now = new Date(2026, 10, 17, 9, 30);

/** @param {string | null} diffStat */
const fakeGit = (diffStat) => () => ({
  branch: 'feat/x',
  changed: 2,
  diffStat,
});

/** @param {string} name */
function makeActiveTask(name) {
  const dir = path.join(root, 'tasks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'NOTES.md'), '# NOTES\n');
  fs.writeFileSync(path.join(root, 'tasks', '.active'), `${name}\n`);
  return path.join(dir, 'NOTES.md');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-compact-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('pre_compact processHookInput', () => {
  test('should do nothing when no task is active', () => {
    expect(
      processHookInput({ trigger: 'manual' }, { rootDir: root })
    ).toBeNull();
  });

  test('should append a checkpoint with git state and diff size', () => {
    const notes = makeActiveTask('demo-261117');

    const result = processHookInput(
      { trigger: 'manual' },
      { rootDir: root, now, git: fakeGit('3 files changed, 10 insertions(+)') }
    );
    const text = fs.readFileSync(notes, 'utf-8');

    expect(result).toBe('demo-261117');
    expect(text).toContain(
      '## 2026-11-17 09:30 — claude (auto: pre-compact, manual)'
    );
    expect(text).toContain(
      'State: branch feat/x; uncommitted yes (2 files); verify not run; diff 3 files changed, 10 insertions(+)'
    );
  });

  test('should sign the checkpoint with the harness that compacted', () => {
    const notes = makeActiveTask('demo-261117');
    processHookInput(
      { trigger: 'auto' },
      { rootDir: root, now, git: fakeGit(null), agent: 'codex' }
    );
    expect(fs.readFileSync(notes, 'utf-8')).toContain(
      '## 2026-11-17 09:30 — codex (auto: pre-compact, auto)'
    );
  });

  test('should omit the diff and name an unknown trigger when input is missing', () => {
    const notes = makeActiveTask('demo-261117');

    processHookInput(undefined, { rootDir: root, now, git: fakeGit(null) });
    const text = fs.readFileSync(notes, 'utf-8');

    expect(text).toContain('(auto: pre-compact, unknown)');
    expect(text).not.toContain('; diff');
  });

  test('should fail open when the task cannot be read', () => {
    makeActiveTask('demo-261117');
    fs.writeFileSync(
      path.join(root, 'tasks', 'demo-261117', 'state.json'),
      '{bad'
    );

    expect(
      processHookInput(
        { trigger: 'auto' },
        { rootDir: root, now, git: fakeGit(null) }
      )
    ).toBeNull();
  });

  test('should write only to a task the session engaged', () => {
    const notes = makeActiveTask('demo-261117');
    writeSession(root, 'dormant', { task: 'demo-261117', engaged: false });
    writeSession(root, 'engaged', { task: 'demo-261117', engaged: true });

    expect(
      processHookInput(
        { trigger: 'auto', session_id: 'dormant' },
        { rootDir: root, now, git: fakeGit(null) }
      )
    ).toBeNull();
    expect(fs.readFileSync(notes, 'utf-8')).toBe('# NOTES\n');
    expect(
      processHookInput(
        { trigger: 'auto', session_id: 'engaged' },
        { rootDir: root, now, git: fakeGit(null) }
      )
    ).toBe('demo-261117');
  });

  test("should take the git state from the task's repository", () => {
    makeActiveTask('demo-261117');
    const dir = path.join(root, 'tasks', 'demo-261117');
    const repo = path.resolve(root, '..', 'other-repo');
    saveState(dir, createState({ name: 'demo-261117', goal: 'G', now, repo }));
    /** @type {string[]} */
    const asked = [];
    const git = (/** @type {string} */ cwd) => {
      asked.push(cwd);
      return { branch: 'feat/r', changed: 0, diffStat: null };
    };

    processHookInput({ trigger: 'auto' }, { rootDir: root, now, git });

    expect(asked).toEqual([repo, repo]);
  });

  test('should use real git and the current time by default', () => {
    makeActiveTask('demo-261117');

    expect(processHookInput({ trigger: 'auto' }, { rootDir: root })).toBe(
      'demo-261117'
    );
  });
});
