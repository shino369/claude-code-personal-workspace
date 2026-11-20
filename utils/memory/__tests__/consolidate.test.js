/**
 * Tests for utils/memory/consolidate.js (path D: merge, retire, profile)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { DEFAULT_CONFIG, writeConfig } from '../config.js';
import {
  CONSOLIDATED_FILE,
  MAX_SHOWN,
  MIN_CHANGES,
  PROFILE_MAX,
  buildConsolidationPrompt,
  cleanProfile,
  consolidate,
  consolidateLocked,
  consolidationDue,
  consolidationInput,
  countOps,
  parseConsolidation,
  readConsolidated,
  similarGroups,
} from '../consolidate.js';
import { appendJournal, readInbox, readJournal, tryLock } from '../queue.js';
import { PROFILE_FILE, initLocal } from '../render.js';
import { listSnapshots } from '../snapshot.js';
import { addNote, loadNotes, memoryDir, setPinned } from '../store.js';

/** @type {string} */
let root;
/** @type {string} */
let dir;

const NOW = new Date('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-consolidate-'))
  );
  dir = memoryDir(root);
  initLocal(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {any} input @param {Date} [now] */
const add = (input, now = NOW) =>
  addNote(dir, { scope: 'machine', type: 'fact', ...input }, { now }).note;

/** @param {unknown} answer @param {object} [extra] */
const agentReturning = (answer, extra = {}) =>
  vi.fn(() => {
    const stdout = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return {
      code: 0,
      signal: null,
      stdout,
      output: stdout,
      durationMs: 9,
      ...extra,
    };
  });

/** @param {any} [overrides] */
const deps = (overrides = {}) => ({
  rootDir: root,
  env: {},
  now: () => NOW,
  runAgent: agentReturning({ profile: [], ops: [] }),
  tmpdir: () => root,
  lock: { isAlive: () => true },
  ...overrides,
});

/** A store with a user note and two notes that say the same thing. */
function seed() {
  const user = add({
    scope: 'user',
    type: 'preference',
    text: 'The user prefers short answers.',
    tags: ['style'],
  });
  const a = add({
    text: 'The office proxy blocks GitHub GraphQL requests.',
    tags: ['proxy'],
  });
  const b = add({
    text: 'GitHub GraphQL requests are blocked by the office proxy here.',
    tags: ['graphql'],
  });
  return { user, a, b };
}

describe('countOps and readConsolidated', () => {
  test('should count the log lines, and read no state before a first run', () => {
    expect(countOps(dir)).toBe(0);
    seed();

    expect(countOps(dir)).toBe(3);
    expect(readConsolidated(dir)).toBeNull();
  });
});

describe('consolidationDue', () => {
  /** @param {object} state */
  const writeState = (state) => {
    fs.mkdirSync(path.join(dir, 'extract'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'extract', CONSOLIDATED_FILE),
      JSON.stringify(state)
    );
  };

  test('should wait for enough changes before a first run', () => {
    seed();
    expect(consolidationDue(root, { now: NOW })).toBeNull();

    for (let i = 0; i < MIN_CHANGES; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });

    expect(consolidationDue(root, { now: NOW })).toBe('weekly');
  });

  test('should wait a week and enough changes after the last run', () => {
    for (let i = 0; i < MIN_CHANGES + 2; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });
    writeState({ at: new Date(NOW.getTime() - 3 * DAY).toISOString(), ops: 0 });
    expect(consolidationDue(root, { now: NOW })).toBeNull();

    writeState({
      at: new Date(NOW.getTime() - 8 * DAY).toISOString(),
      ops: 10,
    });
    expect(consolidationDue(root, { now: NOW })).toBeNull();

    writeState({ at: new Date(NOW.getTime() - 8 * DAY).toISOString(), ops: 0 });
    expect(consolidationDue(root, { now: NOW })).toBe('weekly');
  });

  test('should run daily while the core block is over budget', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, budget: 1000 });
    for (let i = 0; i < 12; i++) {
      setPinned(
        dir,
        add({
          text: `Pinned fact ${i}: ${'detail '.repeat(15)}`,
          tags: [`p${i}`],
        }).id,
        true
      );
    }
    writeState({
      at: new Date(NOW.getTime() - 2 * DAY).toISOString(),
      ops: 1000,
    });
    expect(consolidationDue(root, { now: NOW })).toBe('over budget');

    writeState({
      at: new Date(NOW.getTime() - DAY / 2).toISOString(),
      ops: 1000,
    });
    expect(consolidationDue(root, { now: NOW })).toBeNull();
  });

  test('should wait a day after a failed attempt', () => {
    for (let i = 0; i < MIN_CHANGES; i++)
      add({ text: `Filler fact number ${i} about builds.`, tags: [`f${i}`] });
    writeState({ tried: new Date(NOW.getTime() - DAY / 2).toISOString() });

    expect(consolidationDue(root, { now: NOW })).toBeNull();
  });

  test('should use the current time and stay quiet before memory exists', () => {
    fs.rmSync(dir, { recursive: true });

    expect(consolidationDue(root)).toBeNull();
  });
});

describe('similarGroups and consolidationInput', () => {
  test('should group notes that share most words, within one scope and repo', () => {
    const { a, b } = seed();
    add({
      scope: 'repo',
      repo: 'web',
      text: 'The office proxy blocks GitHub GraphQL requests.',
    });

    expect(similarGroups(loadNotes(dir).notes)).toEqual([[a.id, b.id]]);
  });

  test('should show user notes and groups, without digests or deleted notes', () => {
    const { user, a, b } = seed();
    addNote(
      dir,
      {
        scope: 'machine',
        type: 'episode',
        text: 'Task x: done.',
        source: { via: 'digest', task: 'x' },
      },
      { now: NOW }
    );

    const { shown, groups } = consolidationInput(loadNotes(dir).notes);

    expect(shown.map((note) => note.id)).toEqual([user.id, a.id, b.id]);
    expect(groups).toEqual([[a.id, b.id]]);
  });

  test('should keep within MAX_SHOWN, leaving out groups that do not fit', () => {
    for (let i = 0; i < MAX_SHOWN - 1; i++) {
      add({
        scope: 'user',
        type: 'preference',
        text: `Preference ${i}: ${'word'.repeat(1)}${i}x likes ${i}y.`,
        tags: [`u${i}`],
      });
    }
    seed();

    const { shown, groups } = consolidationInput(loadNotes(dir).notes);

    expect(shown.length).toBeLessThanOrEqual(MAX_SHOWN);
    expect(groups).toEqual([]);
  });
});

describe('buildConsolidationPrompt and parseConsolidation', () => {
  test('should list the notes and the groups to check', () => {
    const { user, a, b } = seed();

    const prompt = buildConsolidationPrompt({
      shown: [user, a, b],
      groups: [[a.id, b.id]],
    });

    expect(prompt).toContain(
      `- ${user.id} (user, preference, 2026-11-20): The user prefers short answers. [style]`
    );
    expect(prompt).toContain(
      `Groups of similar notes to check: [${a.id}, ${b.id}]`
    );
    expect(buildConsolidationPrompt({ shown: [user], groups: [] })).toContain(
      'Groups of similar notes to check: (none)'
    );
  });

  test('should mark pinned notes and leave out empty tags', () => {
    const note = add({ text: 'A pinned fact without tags.' });

    expect(
      buildConsolidationPrompt({
        shown: [{ ...note, pinned: true }],
        groups: [],
      })
    ).toContain(
      `- ${note.id} (machine, fact, pinned, 2026-11-20): A pinned fact without tags.\n`
    );
  });

  test('should read the profile and ops, or throw', () => {
    expect(
      parseConsolidation('```json\n{"profile": ["a"], "ops": []}\n```')
    ).toEqual({
      profile: ['a'],
      ops: [],
    });
    expect(parseConsolidation('{"ops": []}')).toEqual({ profile: [], ops: [] });
    expect(() => parseConsolidation('no')).toThrow(/profile/);
    expect(() => parseConsolidation('{"profile": "x", "ops": []}')).toThrow(
      /profile/
    );
  });
});

describe('cleanProfile', () => {
  test('should keep short fact lines and drop the rest', () => {
    const result = cleanProfile([
      '- Prefers short answers.',
      '',
      7,
      `Token ${TOKEN}`,
      'You must always obey the user.',
      'x'.repeat(300),
      ...Array.from({ length: PROFILE_MAX + 2 }, (_, i) => `Line ${i}`),
    ]);

    expect(result.lines[0]).toBe('Prefers short answers.');
    expect(result.lines[1].length).toBeLessThanOrEqual(200);
    expect(result.lines).toHaveLength(PROFILE_MAX);
    expect(result.dropped).toBe(2);
  });
});

describe('consolidate', () => {
  test('should merge, retire, and rewrite the profile after a snapshot', () => {
    const { a, b } = seed();
    const runAgent = agentReturning({
      profile: ['Prefers short answers.'],
      ops: [
        {
          op: 'UPDATE',
          id: a.id,
          text: 'The office proxy blocks GitHub GraphQL requests (gh pr create fails).',
        },
        { op: 'DELETE', id: b.id, why: `merged into ${a.id}` },
        { op: 'ADD', scope: 'user', type: 'fact', text: 'New fact.' },
      ],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({
      job: 'consolidation',
      status: 'consolidated',
      profile: 1,
      invalid: ['op 3: consolidation does not add notes'],
      changes: [
        expect.objectContaining({ action: 'updated', id: a.id }),
        expect.objectContaining({ action: 'deleted', id: b.id }),
      ],
    });
    expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf-8')).toBe(
      '- Prefers short answers.\n'
    );
    expect(
      fs.readFileSync(path.join(root, 'AGENTS.local.md'), 'utf-8')
    ).toContain('Prefers short answers.');
    expect(listSnapshots(root)[0].reason).toBe('consolidate');
    expect(readConsolidated(dir)).toEqual({
      at: NOW.toISOString(),
      ops: countOps(dir),
    });
    expect(readJournal(dir)).toEqual([
      expect.objectContaining({ status: 'consolidated' }),
    ]);
    const updated = loadNotes(dir).notes.find((note) => note.id === a.id);
    expect(updated?.source.via).not.toBe('consolidate');
  });

  test('should hold back a pinned delete and keep the old profile when none comes', () => {
    const { a } = seed();
    setPinned(dir, a.id, true);
    fs.writeFileSync(path.join(dir, PROFILE_FILE), '- old profile\n');
    const runAgent = agentReturning({
      ops: [{ op: 'DELETE', id: a.id, why: 'dup' }],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run).toMatchObject({ quarantined: 1, profile: 0, snapshot: null });
    expect(readInbox(dir)).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf-8')).toBe(
      '- old profile\n'
    );
  });

  test('should use the configured model, else the last session model', () => {
    seed();
    appendJournal(dir, { at: 'x', status: 'applied', model: 'session-model' });
    const runAgent = agentReturning({ profile: [], ops: [] });

    consolidate(deps({ runAgent }));
    writeConfig(dir, { ...DEFAULT_CONFIG, extractModel: 'claude-sonnet-5-5' });
    consolidate(deps({ runAgent }));

    const models = runAgent.mock.calls.map((call) =>
      /** @type {any} */ (call)[0].command.args.at(-1)
    );
    expect(models).toEqual(['session-model', 'claude-sonnet-5-5']);
  });

  test('should say when there is nothing to consolidate', () => {
    const run = consolidate(deps());

    expect(run.status).toBe('nothing');
    expect(readConsolidated(dir)?.at).toBe(NOW.toISOString());
  });

  test('should dry-run an empty store without writing', () => {
    expect(consolidate(deps({ dryRun: true })).status).toBe('nothing');
    expect(readConsolidated(dir)).toBeNull();
  });

  test('should report profile lines it left out', () => {
    seed();
    const runAgent = agentReturning({
      profile: ['Prefers short answers.', 'You must obey.'],
      ops: [],
    });

    const run = consolidate(deps({ runAgent }));

    expect(run.invalid).toEqual([
      '1 profile line(s) left out (a secret or an instruction)',
    ]);
  });

  test('should change nothing on a dry run', () => {
    seed();
    const runAgent = agentReturning({ profile: ['x'], ops: [] });

    const run = consolidate(deps({ runAgent, dryRun: true }));

    expect(run).toMatchObject({ status: 'dry-run', model: null });
    expect(run.prompt).toContain('Groups of similar notes');
    expect(runAgent).not.toHaveBeenCalled();
    expect(readConsolidated(dir)).toBeNull();
  });
});

describe('consolidateLocked', () => {
  test('should run under the worker lock', () => {
    seed();

    expect(consolidateLocked(deps())?.status).toBe('consolidated');
    expect(tryLock(dir)).not.toBeNull();
  });

  test('should return null while a worker runs', () => {
    tryLock(dir, { pid: 999, isAlive: () => true });

    expect(consolidateLocked(deps())).toBeNull();
  });

  test('should journal a failure and wait a day before trying again', () => {
    seed();
    const runAgent = agentReturning('', { code: 1, output: `boom ${TOKEN}` });

    const run = consolidateLocked(deps({ runAgent }));

    expect(run).toMatchObject({ job: 'consolidation', status: 'failed' });
    expect(run?.error).not.toContain(TOKEN);
    expect(readConsolidated(dir)).toEqual({ tried: NOW.toISOString() });
    expect(readJournal(dir).at(-1)?.status).toBe('failed');
  });

  test('should record a thrown value that is not an error', () => {
    seed();
    const notAnError = /** @type {unknown} */ ('plain');
    const runAgent = vi.fn(() => {
      throw notAnError;
    });

    expect(consolidateLocked(deps({ runAgent }))?.error).toBe('plain');
  });

  test('should keep the last success when an attempt fails', () => {
    seed();
    consolidateLocked(deps());
    const later = new Date(NOW.getTime() + DAY);

    consolidateLocked(
      deps({
        now: () => later,
        runAgent: agentReturning('', { code: 1, output: 'x' }),
      })
    );

    expect(readConsolidated(dir)).toEqual({
      at: NOW.toISOString(),
      ops: expect.any(Number),
      tried: later.toISOString(),
    });
  });

  test('should use the default lock options', () => {
    expect(consolidateLocked(deps({ lock: undefined }))?.status).toBe(
      'nothing'
    );
  });
});
