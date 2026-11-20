/**
 * Tests for utils/memory/store.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  CACHE_DIR,
  LIMITS,
  LOG_FILE,
  MemoryError,
  NOTES_CACHE_FILE,
  STALE_DAYS,
  USAGE_FILE,
  addNote,
  checkNote,
  deleteNote,
  isStale,
  loadNotes,
  memoryDir,
  noteHistory,
  readUsage,
  recordHits,
  replay,
  setPinned,
  updateNote,
} from '../store.js';

// Fake secret assembled at runtime so secret scanners don't flag this file.
const FAKE_GH_TOKEN = 'gh' + 'p_' + 'a'.repeat(36);

const NOW = new Date('2026-11-20T10:00:00.000Z');
const LATER = new Date('2026-11-25T10:00:00.000Z');

const PROXY =
  'The company proxy blocks GitHub GraphQL and the PR merge API; merge by fast-forwarding main and git push.';
const PROXY_EDIT =
  'The company proxy blocks GitHub GraphQL and the PR merge API; merge by fast-forwarding main, then git push.';

/** @param {Partial<import('../store.js').NoteInput>} [over] */
const input = (over = {}) => ({
  text: PROXY,
  scope: 'machine',
  type: 'howto',
  ...over,
});

/**
 * @param {unknown} fn
 * @returns {MemoryError}
 */
function caught(fn) {
  try {
    /** @type {() => unknown} */ (fn)();
  } catch (error) {
    if (error instanceof MemoryError) return error;
    throw error;
  }
  throw new Error('expected a MemoryError');
}

describe('memory store', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let dir;

  /** @returns {any[]} */
  const logOps = () =>
    fs
      .readFileSync(path.join(dir, LOG_FILE), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
    dir = memoryDir(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('memoryDir should be memory/ under the root', () => {
    expect(memoryDir('/w')).toBe(path.join('/w', 'memory'));
  });

  test('MemoryError should carry its code', () => {
    const error = new MemoryError('invalid', 'bad');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MemoryError');
    expect(error.code).toBe('invalid');
    expect(error.message).toBe('bad');
  });

  describe('addNote', () => {
    test('should add a note with defaults and today as its dates', () => {
      const result = addNote(dir, input(), { now: NOW });

      expect(result.action).toBe('added');
      expect(result.note).toEqual({
        id: 'm1',
        scope: 'machine',
        repo: null,
        type: 'howto',
        text: PROXY,
        tags: [],
        triggers: [],
        source: { via: 'agent' },
        pinned: false,
        supersedes: null,
        created: '2026-11-20',
        updated: '2026-11-20',
        checked: '2026-11-20',
        status: 'active',
      });
    });

    test('should create the memory directory and append one add op', () => {
      addNote(dir, input(), { now: NOW });

      const [op] = logOps();
      expect(op).toMatchObject({
        op: 'add',
        at: NOW.toISOString(),
        note: { id: 'm1', text: PROXY },
      });
    });

    test('should number ids in sequence', () => {
      addNote(dir, input(), { now: NOW });

      const second = addNote(dir, input({ text: 'Prefers design first.' }));

      expect(second.note.id).toBe('m2');
    });

    test('should give a task digest a t id from the same sequence', () => {
      addNote(dir, input(), { now: NOW });

      const digest = addNote(
        dir,
        input({
          text: 'Task cws-auto-publish: release runs submit to the Chrome Web Store.',
          type: 'episode',
          scope: 'user',
          source: { via: 'digest', task: 'cws-auto-publish-261120' },
        })
      );

      expect(digest.note.id).toBe('t2');
      expect(digest.note.source).toEqual({
        via: 'digest',
        task: 'cws-auto-publish-261120',
      });
    });

    test('should trim text and tags, and drop duplicate and empty tags', () => {
      const { note } = addNote(
        dir,
        input({
          text: `  ${PROXY}  `,
          tags: [' GitHub ', 'github', 'ＰＲ', 'PR', ''],
          triggers: ['gh pr', ' gh pr '],
        })
      );

      expect(note.text).toBe(PROXY);
      expect(note.tags).toEqual(['GitHub', 'ＰＲ']);
      expect(note.triggers).toEqual(['gh pr']);
    });

    test('should keep a repo note with its repo', () => {
      const { note } = addNote(
        dir,
        input({ scope: 'repo', repo: ' jp-live-notifier ', type: 'fact' })
      );

      expect(note.repo).toBe('jp-live-notifier');
    });

    test('should store an imported note as unchecked', () => {
      const { note } = addNote(dir, input({ unchecked: true }), { now: NOW });

      expect(note.checked).toBeNull();
      expect(logOps()[0].note.checked).toBeNull();
    });

    test('should keep pinned, supersedes, and the full source', () => {
      const source = {
        via: 'extract',
        harness: 'claude',
        session: 's1',
        task: 't',
      };

      const { note } = addNote(
        dir,
        input({ pinned: true, supersedes: 'm9', source })
      );

      expect(note).toMatchObject({ pinned: true, supersedes: 'm9', source });
    });

    test.each([
      ['the text', { text: `Use GH_TOKEN=${FAKE_GH_TOKEN} for pushes.` }],
      ['a tag', { tags: [FAKE_GH_TOKEN] }],
      ['a trigger', { triggers: [`curl ${FAKE_GH_TOKEN}`] }],
    ])('should refuse a secret in %s and write nothing', (_label, over) => {
      const error = caught(() => addNote(dir, input(over)));

      expect(error.code).toBe('secret');
      expect(error.message).toMatch(/github-token/);
      expect(fs.existsSync(path.join(dir, LOG_FILE))).toBe(false);
    });

    test.each([
      ['not an object', null, /must be an object/],
      ['empty text', { text: '   ' }, /text is empty/],
      ['text that is not a string', { text: 42 }, /text is empty/],
      [
        'text over the limit',
        { text: 'word '.repeat(LIMITS.text) },
        /limit is 1000/,
      ],
      ['text without words', { text: '--- !!! ---' }, /no searchable words/],
      ['an unknown scope', { scope: 'global' }, /Unknown scope "global"/],
      ['a repo note without a repo', { scope: 'repo' }, /needs a repo/],
      [
        'a repo note with a blank repo',
        { scope: 'repo', repo: ' ' },
        /needs a repo/,
      ],
      [
        'a repo on a machine note',
        { repo: 'x' },
        /Only repo notes take a repo/,
      ],
      ['an unknown type', { type: 'rumor' }, /Unknown type "rumor"/],
      ['tags that are not a list', { tags: 'a,b' }, /tags must be a list/],
      ['a tag that is not text', { tags: [1] }, /every tag must be text/],
      [
        'too many tags',
        { tags: Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`) },
        /at most 30 tags/,
      ],
      [
        'a tag over the limit',
        { tags: ['x'.repeat(LIMITS.tag + 1)] },
        /tag is over 50/,
      ],
      [
        'too many triggers',
        {
          triggers: Array.from(
            { length: LIMITS.triggers + 1 },
            (_, i) => `c${i}`
          ),
        },
        /at most 10 triggers/,
      ],
      [
        'a source that is not an object',
        { source: 'agent' },
        /source must be an object/,
      ],
      ['an unknown source', { source: { via: 'web' } }, /Unknown source "web"/],
      [
        'a source field that is not text',
        { source: { via: 'agent', session: 3 } },
        /source\.session must be text/,
      ],
      [
        'pinned that is not a boolean',
        { pinned: 'yes' },
        /pinned field must be true or false/,
      ],
      [
        'supersedes that is not an id',
        { supersedes: 7 },
        /supersedes field must be a note id/,
      ],
    ])('should refuse %s', (_label, over, message) => {
      const value = over === null ? null : input(/** @type {any} */ (over));

      const error = caught(() => addNote(dir, /** @type {any} */ (value)));

      expect(error.code).toBe('invalid');
      expect(error.message).toMatch(message);
    });
  });

  describe('addNote near-duplicates', () => {
    test('should leave the store unchanged for the same note', () => {
      const first = addNote(dir, input({ tags: ['proxy'] }), { now: NOW });

      const again = addNote(dir, input({ tags: ['Proxy'] }), { now: LATER });

      expect(again.action).toBe('unchanged');
      expect(again.note).toEqual(first.note);
      expect(logOps()).toHaveLength(1);
    });

    test('should merge a near-duplicate: new text, tags joined, same id', () => {
      addNote(dir, input({ tags: ['proxy', 'github'] }), { now: NOW });

      const merged = addNote(
        dir,
        input({ text: PROXY_EDIT, tags: ['GitHub', 'merge'] }),
        { now: LATER }
      );

      expect(merged.action).toBe('merged');
      expect(merged.note).toMatchObject({
        id: 'm1',
        text: PROXY_EDIT,
        tags: ['proxy', 'github', 'merge'],
        created: '2026-11-20',
        updated: '2026-11-25',
        checked: '2026-11-25',
      });
      expect(logOps()[1]).toEqual({
        op: 'update',
        id: 'm1',
        at: LATER.toISOString(),
        set: { text: PROXY_EDIT, tags: ['proxy', 'github', 'merge'] },
        source: { via: 'agent' },
      });
    });

    test('should merge new triggers and a new type into the same text', () => {
      addNote(dir, input({ triggers: ['gh pr'] }));

      const merged = addNote(
        dir,
        input({ type: 'fact', triggers: ['graphql'] })
      );

      expect(merged.action).toBe('merged');
      expect(merged.note.type).toBe('fact');
      expect(merged.note.triggers).toEqual(['gh pr', 'graphql']);
    });

    test('should pin the existing note when the duplicate asks for it', () => {
      addNote(dir, input());

      const merged = addNote(dir, input({ pinned: true }));

      expect(merged.action).toBe('merged');
      expect(merged.note.pinned).toBe(true);
      expect(logOps().map((op) => op.op)).toEqual(['add', 'pin']);
    });

    test('should keep at most the tag limit when joining tags', () => {
      const many = (/** @type {string} */ p) =>
        Array.from({ length: LIMITS.tags }, (_, i) => `${p}${i}`);
      addNote(dir, input({ tags: many('a') }));

      const merged = addNote(dir, input({ tags: many('b') }));

      expect(merged.note.tags).toEqual(many('a'));
      expect(merged.action).toBe('unchanged');
    });

    test('should merge into the most similar of several notes', () => {
      addNote(dir, input({ text: `${PROXY} Ask before using a VPN.` }));
      addNote(dir, input());

      const merged = addNote(dir, input({ text: PROXY_EDIT }));

      expect(merged.note.id).toBe('m2');
    });

    test.each([
      ['another scope', { scope: 'user' }],
      ['another repo', { scope: 'repo', repo: 'other' }],
    ])('should add a new note in %s', (_label, over) => {
      addNote(dir, input({ scope: 'repo', repo: 'one' }));

      const result = addNote(dir, input(/** @type {any} */ (over)));

      expect(result.action).toBe('added');
      expect(result.note.id).toBe('m2');
    });

    test('should add a new note when the old one is deleted', () => {
      addNote(dir, input());
      deleteNote(dir, 'm1', 'wrong');

      const result = addNote(dir, input());

      expect(result).toMatchObject({ action: 'added', note: { id: 'm2' } });
    });

    test('should add a new note for an unrelated text', () => {
      addNote(dir, input());

      const result = addNote(
        dir,
        input({ text: 'The office Wi-Fi drops VPN at 6pm.' })
      );

      expect(result.action).toBe('added');
    });

    test('should refuse a secret before looking for duplicates', () => {
      addNote(dir, input());

      const error = caught(() =>
        addNote(dir, input({ text: `${PROXY} token ${FAKE_GH_TOKEN}` }))
      );

      expect(error.code).toBe('secret');
      expect(logOps()).toHaveLength(1);
    });
  });

  describe('updateNote', () => {
    test('should change fields and mark the note updated and checked', () => {
      addNote(dir, input(), { now: NOW });

      const note = updateNote(
        dir,
        'm1',
        { text: 'GraphQL is blocked by the proxy.', tags: ['graphql'] },
        { now: LATER, source: { via: 'user' } }
      );

      expect(note).toMatchObject({
        text: 'GraphQL is blocked by the proxy.',
        tags: ['graphql'],
        updated: '2026-11-25',
        checked: '2026-11-25',
        created: '2026-11-20',
      });
      expect(logOps()[1]).toEqual({
        op: 'update',
        id: 'm1',
        at: LATER.toISOString(),
        set: { text: 'GraphQL is blocked by the proxy.', tags: ['graphql'] },
        source: { via: 'user' },
      });
    });

    test('should move a note to repo scope', () => {
      addNote(dir, input());

      const note = updateNote(dir, 'm1', { scope: 'repo', repo: 'ws' });

      expect(note).toMatchObject({ scope: 'repo', repo: 'ws' });
    });

    test('should write nothing when nothing changes', () => {
      addNote(dir, input({ tags: ['proxy'] }), { now: NOW });

      const note = updateNote(
        dir,
        'm1',
        { text: PROXY, tags: ['proxy'] },
        { now: LATER }
      );

      expect(note.updated).toBe('2026-11-20');
      expect(logOps()).toHaveLength(1);
    });

    test('should refuse a secret', () => {
      addNote(dir, input());

      const error = caught(() =>
        updateNote(dir, 'm1', { text: `token ${FAKE_GH_TOKEN}` })
      );

      expect(error.code).toBe('secret');
    });

    test('should refuse an invalid value', () => {
      addNote(dir, input());

      const error = caught(() =>
        updateNote(dir, 'm1', /** @type {any} */ ({ type: 'rumor' }))
      );

      expect(error.code).toBe('invalid');
    });

    test('should refuse a field that cannot be changed', () => {
      addNote(dir, input());

      const error = caught(() =>
        updateNote(dir, 'm1', /** @type {any} */ ({ created: '2020-01-01' }))
      );

      expect(error.code).toBe('invalid');
      expect(error.message).toMatch(/Cannot change "created"/);
    });

    test('should refuse changes that are not an object', () => {
      addNote(dir, input());

      const error = caught(() =>
        updateNote(dir, 'm1', /** @type {any} */ (null))
      );

      expect(error.code).toBe('invalid');
    });

    test('should report an unknown id', () => {
      const error = caught(() => updateNote(dir, 'm7', { text: 'x y' }));

      expect(error.code).toBe('not-found');
      expect(error.message).toMatch(/No note m7/);
    });

    test('should refuse a deleted note', () => {
      addNote(dir, input());
      deleteNote(dir, 'm1', 'outdated');

      const error = caught(() => updateNote(dir, 'm1', { text: 'x y' }));

      expect(error.code).toBe('deleted');
    });
  });

  describe('deleteNote', () => {
    test('should mark the note deleted with the reason and keep it', () => {
      addNote(dir, input(), { now: NOW });

      const note = deleteNote(dir, 'm1', ' outdated ', { now: LATER });

      expect(note).toMatchObject({
        status: 'deleted',
        deleted: '2026-11-25',
        why: 'outdated',
      });
      expect(loadNotes(dir).notes).toHaveLength(1);
      expect(logOps()[1]).toEqual({
        op: 'delete',
        id: 'm1',
        at: LATER.toISOString(),
        why: 'outdated',
        source: { via: 'agent' },
      });
    });

    test('should require a reason', () => {
      addNote(dir, input());

      const error = caught(() => deleteNote(dir, 'm1', ' '));

      expect(error.code).toBe('invalid');
      expect(error.message).toMatch(/reason/);
    });

    test('should refuse a note that is already deleted', () => {
      addNote(dir, input());
      deleteNote(dir, 'm1', 'once');

      const error = caught(() => deleteNote(dir, 'm1', 'twice'));

      expect(error.code).toBe('deleted');
    });
  });

  describe('setPinned and checkNote', () => {
    test('should pin and unpin a note', () => {
      addNote(dir, input());

      expect(setPinned(dir, 'm1', true).pinned).toBe(true);
      expect(setPinned(dir, 'm1', false).pinned).toBe(false);
      expect(logOps().map((op) => [op.op, op.pinned])).toEqual([
        ['add', undefined],
        ['pin', true],
        ['pin', false],
      ]);
    });

    test('should not write when the note is already pinned that way', () => {
      addNote(dir, input());

      setPinned(dir, 'm1', false);

      expect(logOps()).toHaveLength(1);
    });

    test('should mark an unchecked note checked today', () => {
      addNote(dir, input({ unchecked: true }), { now: NOW });

      const note = checkNote(dir, 'm1', { now: LATER });

      expect(note.checked).toBe('2026-11-25');
      expect(logOps()[1]).toEqual({
        op: 'check',
        id: 'm1',
        at: LATER.toISOString(),
      });
    });

    test('should use the current time by default', () => {
      addNote(dir, input({ unchecked: true }));

      const note = checkNote(dir, 'm1');

      expect(note.checked).toBe(new Date().toISOString().slice(0, 10));
    });
  });

  describe('loadNotes', () => {
    const cacheFile = () => path.join(dir, CACHE_DIR, NOTES_CACHE_FILE);

    test('should be empty without a log', () => {
      expect(loadNotes(dir)).toEqual({ notes: [], problems: [], stamp: null });
    });

    test('should return the same stamp from the log and from the cache', () => {
      addNote(dir, input());

      const built = loadNotes(dir);
      const cached = loadNotes(dir);

      expect(built.stamp).toMatch(/^\d+:[\d.]+$/);
      expect(cached.stamp).toBe(built.stamp);
    });

    test('should serve the cache while the log is unchanged', () => {
      addNote(dir, input());
      loadNotes(dir);
      const cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'));
      cache.notes[0].text = 'from the cache';
      fs.writeFileSync(cacheFile(), JSON.stringify(cache));

      const { notes } = loadNotes(dir);

      expect(notes[0].text).toBe('from the cache');
    });

    test('should rebuild when another writer appended to the log', () => {
      addNote(dir, input());
      loadNotes(dir);
      const op = { op: 'pin', id: 'm1', at: LATER.toISOString(), pinned: true };
      fs.appendFileSync(path.join(dir, LOG_FILE), `${JSON.stringify(op)}\n`);

      const { notes } = loadNotes(dir);

      expect(notes[0].pinned).toBe(true);
    });

    test('should rebuild when the log was rewritten at the same size', () => {
      addNote(dir, input());
      loadNotes(dir);
      const logFile = path.join(dir, LOG_FILE);
      const rewritten = fs
        .readFileSync(logFile, 'utf-8')
        .replace('"pinned":false', '"pinned":true '); // same length
      fs.writeFileSync(logFile, rewritten);
      fs.utimesSync(logFile, LATER, LATER);

      const { notes } = loadNotes(dir);

      expect(notes[0].pinned).toBe(true);
    });

    test.each([
      ['of another version', JSON.stringify({ version: 0 })],
      ['that is corrupt', '{not json'],
    ])('should rebuild from a cache %s', (_label, content) => {
      addNote(dir, input());
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      fs.writeFileSync(cacheFile(), content);

      const { notes } = loadNotes(dir);

      expect(notes.map((note) => note.id)).toEqual(['m1']);
      expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf-8')).version).toBe(1);
    });

    test('should not cache a log that grew while it was read', () => {
      addNote(dir, input());
      const realRead = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(
        /** @type {any} */ (
          (/** @type {any} */ file, /** @type {any} */ options) => {
            const out = realRead(file, options);
            return String(file).endsWith(LOG_FILE)
              ? Buffer.concat([/** @type {Buffer} */ (out), Buffer.from('\n')])
              : out;
          }
        )
      );

      const { notes, stamp } = loadNotes(dir);

      expect(notes).toHaveLength(1);
      expect(stamp).toBeNull();
      expect(fs.existsSync(cacheFile())).toBe(false);
    });

    test('should report a malformed line and keep the other notes', () => {
      addNote(dir, input());
      fs.appendFileSync(path.join(dir, LOG_FILE), '{"op":"add"\n\n');

      const { notes, problems } = loadNotes(dir);

      expect(notes).toHaveLength(1);
      expect(problems).toEqual(['line 2: not JSON']);
    });
  });

  describe('replay', () => {
    const at = NOW.toISOString();
    const add = (/** @type {string} */ id, over = {}) => ({
      op: 'add',
      at,
      note: { id, ...input(), ...over },
    });

    test('should apply ops in order', () => {
      const { notes, problems } = replay([
        add('m1'),
        { op: 'pin', id: 'm1', at, pinned: true },
        { op: 'delete', id: 'm1', at, why: 'old' },
      ]);

      expect(problems).toEqual([]);
      expect(notes[0]).toMatchObject({
        pinned: true,
        status: 'deleted',
        why: 'old',
      });
    });

    test.each([
      ['an op that is not an object', 'x', /an op without a time/],
      ['an op without a time', { op: 'add', note: {} }, /an op without a time/],
      [
        'an unknown op',
        { op: 'merge', id: 'm1', at },
        /merge m1 at .*: unknown op/,
      ],
      [
        'an add without a valid id',
        { op: 'add', at, note: { id: 'x1' } },
        /add x1 .*: no valid id/,
      ],
      ['an add without a note', { op: 'add', at }, /add \? .*: no valid id/],
      [
        'an op on an unknown note',
        { op: 'check', id: 'm9', at },
        /check m9 .*: unknown note/,
      ],
    ])('should report %s', (_label, op, message) => {
      const { notes, problems } = replay([/** @type {any} */ (op)]);

      expect(notes).toEqual([]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(message);
    });

    test('should report a reused id and keep the first note', () => {
      const { notes, problems } = replay([
        add('m1'),
        add('m1', { text: 'Other words here.' }),
      ]);

      expect(notes[0].text).toBe(PROXY);
      expect(problems[0]).toMatch(/the id is already used/);
    });

    test('should report an add whose note is invalid', () => {
      const { problems } = replay([add('m1', { scope: 'global' })]);

      expect(problems[0]).toMatch(/add m1 .*: Unknown scope/);
    });

    test.each([
      [
        'a set that is not an object',
        { set: 'text' },
        /changes must be an object/,
      ],
      ['an invalid value', { set: { type: 'rumor' } }, /Unknown type/],
    ])(
      'should report an update with %s and keep the note',
      (_label, over, message) => {
        const { notes, problems } = replay([
          add('m1'),
          /** @type {any} */ ({ op: 'update', id: 'm1', at, ...over }),
        ]);

        expect(notes[0].type).toBe('howto');
        expect(problems[0]).toMatch(message);
      }
    );

    test('should report an op on a deleted note', () => {
      const { problems } = replay([
        add('m1'),
        { op: 'delete', id: 'm1', at, why: 'old' },
        { op: 'pin', id: 'm1', at, pinned: true },
      ]);

      expect(problems).toEqual([`pin m1 at ${at}: the note is deleted`]);
    });

    test('should treat a pin without pinned: true as an unpin', () => {
      const { notes } = replay([
        add('m1', { pinned: true }),
        /** @type {any} */ ({ op: 'pin', id: 'm1', at }),
      ]);

      expect(notes[0].pinned).toBe(false);
    });

    test('should record an empty reason for a delete without one', () => {
      const { notes } = replay([
        add('m1'),
        /** @type {any} */ ({ op: 'delete', id: 'm1', at }),
      ]);

      expect(notes[0].why).toBe('');
    });
  });

  describe('noteHistory', () => {
    test('should list the ops of one note in order', () => {
      addNote(dir, input());
      addNote(
        dir,
        input({
          text: 'Prefers design first, then review.',
          scope: 'user',
          type: 'preference',
        })
      );
      setPinned(dir, 'm1', true);
      checkNote(dir, 'm1');

      const history = noteHistory(dir, 'm1');

      expect(history.map((op) => op.op)).toEqual(['add', 'pin', 'check']);
    });

    test('should skip lines that are not ops', () => {
      addNote(dir, input());
      fs.appendFileSync(path.join(dir, LOG_FILE), 'null\n{broken\n"text"\n');

      const history = noteHistory(dir, 'm1');

      expect(history.map((op) => op.op)).toEqual(['add']);
    });

    test('should be empty without a log', () => {
      expect(noteHistory(dir, 'm1')).toEqual([]);
    });
  });

  describe('isStale', () => {
    /** @param {Partial<import('../store.js').Note>} over */
    const note = (over) =>
      /** @type {import('../store.js').Note} */ ({
        type: 'fact',
        checked: '2026-01-01',
        ...over,
      });
    const day = (/** @type {number} */ n) =>
      new Date(Date.parse('2026-01-01T00:00:00Z') + n * 86_400_000);

    test.each(['preference', 'episode'])(
      'should never mark a %s stale',
      (type) => {
        expect(
          isStale(
            note({ type: /** @type {any} */ (type), checked: null }),
            day(999)
          )
        ).toBe(false);
      }
    );

    test('should mark a fact stale after the limit', () => {
      expect(isStale(note({}), day(STALE_DAYS + 1))).toBe(true);
    });

    test('should keep a fact fresh within the limit', () => {
      expect(isStale(note({}), day(STALE_DAYS - 1))).toBe(false);
    });

    test('should mark an unchecked how-to stale', () => {
      expect(isStale(note({ type: 'howto', checked: null }))).toBe(true);
    });

    test('should accept another limit', () => {
      expect(isStale(note({}), day(10), 7)).toBe(true);
    });
  });

  describe('usage', () => {
    const usageFile = () => path.join(dir, CACHE_DIR, USAGE_FILE);

    test('should be empty without a usage file', () => {
      expect(readUsage(dir)).toEqual({});
    });

    test('should count hits and keep the last hit time', () => {
      recordHits(dir, ['m1', 'm2'], NOW);

      recordHits(dir, ['m1'], LATER);

      expect(readUsage(dir)).toEqual({
        m1: { hits: 2, lastHit: LATER.toISOString() },
        m2: { hits: 1, lastHit: NOW.toISOString() },
      });
    });

    test('should use the current time by default', () => {
      recordHits(dir, ['m1']);

      expect(readUsage(dir).m1.hits).toBe(1);
    });

    test('should write nothing for no hits', () => {
      recordHits(dir, []);

      expect(fs.existsSync(usageFile())).toBe(false);
    });

    test.each([
      ['corrupt', '{nope'],
      ['not an object', '[1,2]'],
      ['null', 'null'],
    ])('should start over from a usage file that is %s', (_label, content) => {
      fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
      fs.writeFileSync(usageFile(), content);

      recordHits(dir, ['m1'], NOW);

      expect(readUsage(dir)).toEqual({
        m1: { hits: 1, lastHit: NOW.toISOString() },
      });
    });

    test('should restart a count that is not a number', () => {
      fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
      fs.writeFileSync(
        usageFile(),
        JSON.stringify({ m1: { hits: 'many' }, m2: null })
      );

      recordHits(dir, ['m1', 'm2'], NOW);

      expect(readUsage(dir).m1.hits).toBe(1);
      expect(readUsage(dir).m2.hits).toBe(1);
    });
  });
});
