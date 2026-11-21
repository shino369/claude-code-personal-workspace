/**
 * Tests for utils/memory/undo.js (pnpm memory undo)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyCompaction } from '../compact.js';
import { readPersonalization, writePersonalization } from '../personalize.js';
import { AGENTS_LOCAL_FILE, initLocal } from '../render.js';
import { listSnapshots, takeSnapshot } from '../snapshot.js';
import {
  LOG_FILE,
  addNote,
  loadNotes,
  memoryDir,
  updateNote,
} from '../store.js';
import { formatUndo, planUndo, undoLast } from '../undo.js';

/** @type {string} */
let root;
/** @type {string} */
let dir;

const T0 = new Date('2026-11-20T10:00:00.000Z');
const JOB = new Date('2026-11-20T11:00:00.000Z');
const LATER = new Date('2026-11-20T12:00:00.000Z');
const SOURCE = { via: 'extract', harness: 'claude', session: 's1' };

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-undo-'))
  );
  dir = memoryDir(root);
  initLocal(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string} text @param {Date} now @param {any} [extra] */
const add = (text, now, extra = {}) =>
  addNote(dir, { text, scope: 'machine', type: 'fact', ...extra }, { now })
    .note;

const texts = () =>
  loadNotes(dir)
    .notes.filter((note) => note.status === 'active')
    .map((note) => note.text);

/** A note, a job that adds one and edits it, then a later save and edit. */
function history() {
  const kept = add('Docker needs 8 GB of memory here.', T0);
  takeSnapshot(root, { reason: 'extract', now: JOB, detail: 's1' });
  const created = add('The proxy blocks GraphQL on this machine.', JOB, {
    source: SOURCE,
  });
  updateNote(
    dir,
    kept.id,
    { text: 'Docker needs 16 GB of memory here.' },
    {
      now: JOB,
      source: SOURCE,
    }
  );
  add('pnpm needs versions 7 days old.', LATER);
  updateNote(
    dir,
    created.id,
    { text: 'The proxy blocks GitHub GraphQL.' },
    {
      now: LATER,
    }
  );
}

describe('planUndo', () => {
  test('should have nothing to undo without a snapshot', () => {
    expect(planUndo(root)).toBeNull();
  });

  test('should drop the job and what touched its notes, keeping later saves', () => {
    history();

    const plan = planUndo(root);

    expect(plan).toMatchObject({ undone: 2, kept: 1, lost: 1 });
    expect(plan?.snapshot.reason).toBe('extract');
  });

  test('should keep nothing later when the log was replaced', () => {
    add('Old note.', T0);
    takeSnapshot(root, { reason: 'import', now: JOB });
    fs.writeFileSync(path.join(dir, LOG_FILE), '');
    add('Imported note.', JOB, { source: { via: 'import' } });
    add('A note saved after the import.', LATER);

    expect(planUndo(root)).toMatchObject({ undone: 1, kept: 0, lost: 1 });
  });

  test('should undo a job from an empty store', () => {
    takeSnapshot(root, { reason: 'extract', now: JOB });
    add('Only note.', JOB, { source: SOURCE });

    expect(planUndo(root)).toMatchObject({
      undone: 1,
      kept: 0,
      lost: 0,
      log: '',
    });
  });
});

describe('undoLast', () => {
  test('should undo a persona compaction, restoring each file and preserving later notes', () => {
    const original = '<!-- My notes -->\n\nAn unpublished persona draft.\n';
    const file = path.join(dir, 'persona.md');
    writePersonalization(dir, { persona: 'Original voice.' });
    fs.writeFileSync(file, original);
    applyCompaction(root, {
      settings: { persona: 'Original voice.' },
      persona: 'Short voice.',
      before: 2000,
      agent: 'claude',
      now: JOB,
    });
    add('A note saved after the persona changed.', JOB);

    const result = undoLast(root, { now: LATER });

    expect(formatUndo(result)[0]).toMatch(/^Undid the persona compaction of /);
    expect(readPersonalization(dir)).toEqual({ persona: 'Original voice.' });
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    expect(
      fs.readFileSync(path.join(root, AGENTS_LOCAL_FILE), 'utf-8')
    ).toContain('Original voice.');
    expect(texts()).toEqual(['A note saved after the persona changed.']);
  });

  test('should revert the job and keep later saves', () => {
    history();

    const result = undoLast(root, { now: LATER });

    expect(texts()).toEqual([
      'Docker needs 8 GB of memory here.',
      'pnpm needs versions 7 days old.',
    ]);
    expect(result?.backup).toMatch(/-undo$/);
    expect(
      listSnapshots(root).find((s) => s.reason === 'extract')?.undone
    ).toBe(LATER.toISOString());
  });

  test('should remove a file created by compaction and preserve later local instructions', () => {
    const agents = path.join(root, AGENTS_LOCAL_FILE);
    applyCompaction(root, {
      settings: {},
      persona: 'Short voice.',
      before: 2000,
      agent: 'claude',
      now: JOB,
    });
    fs.appendFileSync(agents, '\nUser instructions added later.\n');

    undoLast(root, { now: LATER });
    initLocal(root);

    expect(fs.existsSync(path.join(dir, 'persona.md'))).toBe(false);
    expect(readPersonalization(dir)).toEqual({});
    expect(fs.readFileSync(agents, 'utf-8')).toContain(
      'User instructions added later.'
    );
  });

  test('should change nothing on a dry run', () => {
    history();
    const before = fs.readFileSync(path.join(dir, LOG_FILE), 'utf-8');

    const result = undoLast(root, { now: LATER, dryRun: true });

    expect(result).toMatchObject({ undone: 2, backup: null });
    expect(fs.readFileSync(path.join(dir, LOG_FILE), 'utf-8')).toBe(before);
  });

  test('should undo older jobs one by one, skipping its own backups', () => {
    add('First.', T0);
    takeSnapshot(root, { reason: 'extract', now: JOB });
    add('From job one.', JOB, { source: SOURCE });
    const second = new Date(JOB.getTime() + 1000);
    takeSnapshot(root, { reason: 'extract', now: second });
    add('From job two.', second, { source: SOURCE });

    undoLast(root, { now: LATER });
    expect(texts()).toEqual(['First.', 'From job one.']);
    undoLast(root, { now: new Date(LATER.getTime() + 1000) });
    expect(texts()).toEqual(['First.']);
    expect(undoLast(root, { now: LATER })).toBeNull();
  });

  test('should restore the profile after a consolidation, but not the settings', () => {
    fs.writeFileSync(
      path.join(dir, 'personalization.json'),
      '{"tone":"calm"}\n'
    );
    takeSnapshot(root, { reason: 'consolidate', now: JOB });
    fs.writeFileSync(
      path.join(dir, 'personalization.json'),
      '{"tone":"loud"}\n'
    );
    fs.writeFileSync(path.join(dir, 'profile.md'), '- new profile\n');

    undoLast(root, { now: LATER });

    expect(
      fs.readFileSync(path.join(dir, 'personalization.json'), 'utf-8')
    ).toBe('{"tone":"loud"}\n');
    expect(fs.existsSync(path.join(dir, 'profile.md'))).toBe(false);
  });

  test('should restore settings and persona.md after an import, never removing persona.md', () => {
    fs.writeFileSync(path.join(dir, 'persona.md'), 'Calm engineer.\n');
    takeSnapshot(root, { reason: 'import', now: JOB });
    fs.writeFileSync(
      path.join(dir, 'personalization.json'),
      '{"persona":"Cat"}\n'
    );
    fs.writeFileSync(path.join(dir, 'persona.md'), 'Cat\n');

    undoLast(root, { now: LATER });

    expect(fs.existsSync(path.join(dir, 'personalization.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'persona.md'), 'utf-8')).toBe(
      'Calm engineer.\n'
    );

    fs.rmSync(path.join(dir, 'persona.md'));
    takeSnapshot(root, {
      reason: 'import',
      now: new Date(LATER.getTime() + 5000),
    });
    fs.writeFileSync(path.join(dir, 'persona.md'), 'Written later.\n');
    undoLast(root, { now: new Date(LATER.getTime() + 9000) });

    expect(fs.readFileSync(path.join(dir, 'persona.md'), 'utf-8')).toBe(
      'Written later.\n'
    );
  });

  test('should change only notes when undoing an extraction', () => {
    takeSnapshot(root, { reason: 'extract', now: JOB });
    fs.writeFileSync(path.join(dir, 'profile.md'), '- profile\n');

    undoLast(root, { now: LATER });

    expect(fs.existsSync(path.join(dir, 'profile.md'))).toBe(true);
  });

  test('should restore the instructions only for an import', () => {
    const agents = path.join(root, AGENTS_LOCAL_FILE);
    const original = fs.readFileSync(agents, 'utf-8');
    takeSnapshot(root, { reason: 'extract', now: JOB });
    fs.writeFileSync(agents, `${original}\nEdited after.\n`);
    undoLast(root, { now: LATER });
    expect(fs.readFileSync(agents, 'utf-8')).toContain('Edited after.');

    takeSnapshot(root, {
      reason: 'import',
      now: new Date(LATER.getTime() + 5000),
    });
    fs.writeFileSync(agents, 'Imported instructions\n');
    undoLast(root, { now: new Date(LATER.getTime() + 9000) });

    expect(fs.readFileSync(agents, 'utf-8')).toContain('Edited after.');
  });

  test('should keep the instructions file of an import that had none', () => {
    fs.rmSync(path.join(root, AGENTS_LOCAL_FILE));
    takeSnapshot(root, { reason: 'import', now: JOB });
    fs.writeFileSync(path.join(root, AGENTS_LOCAL_FILE), 'Imported\n');

    undoLast(root, { now: LATER });

    expect(fs.existsSync(path.join(root, AGENTS_LOCAL_FILE))).toBe(true);
  });

  test('should do nothing before memory is set up', () => {
    fs.rmSync(dir, { recursive: true });

    expect(undoLast(root)).toBeNull();
  });
});

describe('formatUndo', () => {
  const snapshot = /** @type {any} */ ({
    id: '20261120-190000-extract',
    reason: 'extract',
    at: JOB.toISOString(),
    detail: 's1',
  });

  test('should describe an undo', () => {
    expect(
      formatUndo({
        snapshot,
        undone: 2,
        kept: 1,
        lost: 1,
        backup: 'b',
        log: '',
        warnings: ['w'],
      })
    ).toEqual([
      `Undid the extraction of ${new Date(JOB).toLocaleString('sv').slice(0, 16)} (s1): 2 changes reverted; 1 later change kept; 1 later change lost (it touched a note the job created, or the store was replaced).`,
      'The state before the undo: memory/snapshots/b',
      'Warning: w',
    ]);
  });

  test('should describe a dry run, and say when nothing can be undone', () => {
    expect(
      formatUndo({
        snapshot: { ...snapshot, reason: 'import', detail: '' },
        undone: 1,
        kept: 2,
        lost: 0,
        backup: null,
        log: '',
        warnings: [],
      })[0]
    ).toMatch(
      /^Would undo the import of .*: 1 change reverted; 2 later changes kept\. Nothing was changed\.$/
    );
    expect(formatUndo(null)).toEqual([
      'Nothing to undo: no extraction, consolidation, import, or persona compaction left to revert.',
    ]);
  });

  test('should name a job it does not know by its reason', () => {
    expect(
      formatUndo({
        snapshot: { ...snapshot, reason: 'rebuild', detail: '' },
        undone: 1,
        kept: 0,
        lost: 0,
        backup: 'b',
        log: '',
        warnings: [],
      })[0]
    ).toMatch(/^Undid the rebuild of /);
  });

  test('should name a consolidation, and plural losses', () => {
    expect(
      formatUndo({
        snapshot: { ...snapshot, reason: 'consolidate' },
        undone: 0,
        kept: 0,
        lost: 2,
        backup: 'b',
        log: '',
        warnings: [],
      })[0]
    ).toMatch(
      /^Undid the consolidation of .*: 0 changes reverted; 0 later changes kept; 2 later changes lost \(they touched/
    );
  });
});
