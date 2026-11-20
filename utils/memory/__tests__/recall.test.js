/**
 * Tests for utils/memory/recall.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  BOOSTS,
  INDEX_CACHE_FILE,
  INJECTION_BUDGET,
  NOTE_CHARS,
  RECALL_HEADER,
  buildIndex,
  formatRecall,
  loadIndex,
  matchTriggers,
  noteLabels,
  recall,
  scoreTerms,
} from '../recall.js';
import { CACHE_DIR, LOG_FILE, addNote, memoryDir } from '../store.js';

/** @typedef {import('../store.js').Note} Note */

const NOW = new Date('2026-11-20T12:00:00.000Z');

/**
 * @param {string} id
 * @param {Partial<Note>} [over]
 * @returns {Note}
 */
const note = (id, over = {}) => ({
  id,
  scope: 'user',
  repo: null,
  type: 'fact',
  text: `placeholder ${id}`,
  tags: [],
  triggers: [],
  source: { via: 'agent' },
  pinned: false,
  supersedes: null,
  created: '2026-11-20',
  updated: '2026-11-20',
  checked: '2026-11-20',
  status: 'active',
  ...over,
});

/** Unrelated notes, so a term in one or two notes is rare. */
const FILLERS = [
  note('f1', { text: 'alpha bravo charlie' }),
  note('f2', { text: 'delta echo foxtrot' }),
  note('f3', { text: 'golf hotel india' }),
  note('f4', { text: 'juliet kilo lima' }),
];

/**
 * @param {Note[]} notes
 * @param {string} query
 * @param {Parameters<typeof recall>[2]} [options]
 */
const ids = (notes, query, options = {}) =>
  recall(notes, query, { now: NOW, ...options }).map((r) => r.note.id);

/**
 * Score ratio of note `a` to note `b` for a query both match equally.
 *
 * @param {Note[]} notes
 * @param {string} query
 * @param {Parameters<typeof recall>[2]} options
 */
function ratio(notes, query, options) {
  const results = recall(notes, query, { now: NOW, ...options });
  const score = (/** @type {string} */ id) =>
    /** @type {{ score: number }} */ (results.find((r) => r.note.id === id))
      .score;
  return score('a') / score('b');
}

describe('buildIndex', () => {
  test('should index active, unpinned notes only', () => {
    const index = buildIndex([
      note('m1', { text: 'kubectl cluster' }),
      note('m2', { text: 'kubectl', status: 'deleted' }),
      note('m3', { text: 'kubectl', pinned: true }),
    ]);

    expect(index.N).toBe(1);
    expect(Object.keys(index.docs)).toEqual(['m1']);
  });

  test('should count field lengths, averages, and document frequency', () => {
    const index = buildIndex([
      note('m1', { text: 'kubectl cluster upgrade', tags: ['kubectl'] }),
      note('m2', { text: 'kubectl', tags: ['k8s', 'helm chart'] }),
    ]);

    expect(index.docs.m1.len).toEqual({ text: 3, tags: 1 });
    expect(index.docs.m2.len).toEqual({ text: 1, tags: 3 });
    expect(index.avg).toEqual({ text: 2, tags: 2 });
    expect(index.df.kubectl).toBe(2);
    expect(index.df.helm).toBe(1);
  });

  test('should be empty for no notes', () => {
    expect(buildIndex([])).toMatchObject({
      N: 0,
      avg: { text: 0, tags: 0 },
    });
  });

  test('should keep prototype-named tokens as plain terms', () => {
    const index = JSON.parse(
      JSON.stringify(
        buildIndex([note('m1', { text: 'constructor __proto__' })])
      )
    );

    expect(scoreTerms(index, 'm1', ['constructor']).matched).toEqual([
      'constructor',
    ]);
    expect(scoreTerms(index, 'm1', ['__proto__']).matched).toEqual([
      '__proto__',
    ]);
    expect(scoreTerms(index, 'm1', ['tostring']).score).toBe(0);
  });
});

describe('scoreTerms', () => {
  const notes = [
    note('tag', { text: 'cluster notes', tags: ['kubectl'] }),
    note('text', { text: 'kubectl cluster notes' }),
    note('long', {
      text: 'kubectl and many other words about nothing in particular at all',
    }),
    ...FILLERS,
  ];
  const index = buildIndex(notes);

  test('should score a tag match above a text match', () => {
    const tag = scoreTerms(index, 'tag', ['kubectl']);
    const text = scoreTerms(index, 'text', ['kubectl']);

    expect(tag.score).toBeGreaterThan(text.score);
  });

  test('should count a tag match as full evidence and a text match as half', () => {
    const solo = buildIndex([
      note('a', { tags: ['zebra'] }),
      note('b', { text: 'yak' }),
    ]);

    expect(scoreTerms(solo, 'a', ['zebra']).evidence).toBeCloseTo(1);
    expect(scoreTerms(solo, 'b', ['yak']).evidence).toBeCloseTo(0.5);
  });

  test('should score the same term lower in a longer text', () => {
    expect(scoreTerms(index, 'text', ['kubectl']).score).toBeGreaterThan(
      scoreTerms(index, 'long', ['kubectl']).score
    );
  });

  test('should give a common term less evidence than a rare one', () => {
    const common = scoreTerms(index, 'text', ['kubectl']).evidence;
    const rare = scoreTerms(index, 'long', ['particular']).evidence;

    expect(common).toBeLessThan(rare);
  });

  test('should give each word of a multi-word tag a share of its evidence', () => {
    const solo = buildIndex([
      note('a', { tags: ['design doc'] }),
      note('b', { text: 'other words' }),
    ]);

    expect(scoreTerms(solo, 'a', ['doc']).evidence).toBeCloseTo(0.5);
    expect(scoreTerms(solo, 'a', ['design', 'doc']).evidence).toBeCloseTo(1);
  });

  test('should take the strongest tag for a word in several tags', () => {
    const solo = buildIndex([
      note('a', { tags: ['design doc', 'doc'] }),
      note('b', { text: 'other words' }),
    ]);

    expect(scoreTerms(solo, 'a', ['doc']).evidence).toBeCloseTo(1);
  });

  test('should count a word in a phrase tag and the text as half', () => {
    const solo = buildIndex([
      note('a', {
        text: 'the doc',
        tags: ['design doc', 'release plan notes'],
      }),
      note('b', { text: 'other words' }),
    ]);

    expect(scoreTerms(solo, 'a', ['doc']).evidence).toBeCloseTo(0.5);
    expect(scoreTerms(solo, 'a', ['plan']).evidence).toBeCloseTo(1 / 3);
  });

  test('should list the matched terms and ignore the others', () => {
    const result = scoreTerms(index, 'text', ['kubectl', 'zebra', 'cluster']);

    expect(result.matched).toEqual(['kubectl', 'cluster']);
  });

  test('should be zero for a note that is not indexed', () => {
    expect(scoreTerms(index, 'm99', ['kubectl'])).toEqual({
      score: 0,
      evidence: 0,
      matched: [],
    });
  });
});

describe('recall', () => {
  test('should return nothing for an empty store', () => {
    expect(ids([], 'kubectl')).toEqual([]);
  });

  test('should return nothing for a query without words', () => {
    expect(ids([note('a', { tags: ['kubectl'] }), ...FILLERS], ' ?! ')).toEqual(
      []
    );
  });

  test('should recall a note whose tag matches', () => {
    expect(
      ids([note('a', { tags: ['kubectl'] }), ...FILLERS], 'kubectl')
    ).toEqual(['a']);
  });

  test('should use a given index', () => {
    const notes = [note('a', { tags: ['kubectl'] }), ...FILLERS];
    const index = buildIndex(notes);

    expect(ids(notes, 'kubectl', { index })).toEqual(['a']);
  });

  test('should not recall a single text-only match (evidence floor)', () => {
    expect(
      ids([note('a', { text: 'the kubectl cluster' }), ...FILLERS], 'kubectl')
    ).toEqual([]);
  });

  test('should recall two text-only matches', () => {
    expect(
      ids(
        [note('a', { text: 'the kubectl cluster' }), ...FILLERS],
        'kubectl cluster'
      )
    ).toEqual(['a']);
  });

  test('should skip deleted and pinned notes', () => {
    const notes = [
      note('a', { tags: ['kubectl'], status: 'deleted' }),
      note('b', { tags: ['kubectl'], pinned: true }),
      note('c', { tags: ['kubectl'] }),
      ...FILLERS,
    ];

    expect(ids(notes, 'kubectl')).toEqual(['c']);
  });

  test('should drop matches under 40% of the top score', () => {
    const notes = [
      note('a', {
        text: 'kubectl cluster upgrade: drain the nodes first',
        tags: ['kubectl', 'cluster', 'upgrade'],
      }),
      note('b', { text: 'something else entirely', tags: ['rollback'] }),
      ...FILLERS,
    ];

    expect(ids(notes, 'rollback')).toEqual(['b']);
    expect(ids(notes, 'kubectl cluster upgrade rollback')).toEqual(['a']);
  });

  test('should rank the best match first', () => {
    const notes = [
      note('a', { text: 'cluster notes', tags: ['helm'] }),
      note('b', {
        text: 'kubectl cluster upgrade',
        tags: ['kubectl', 'upgrade'],
      }),
      ...FILLERS,
    ];

    expect(ids(notes, 'kubectl upgrade helm')).toEqual(['b', 'a']);
  });

  test('should return at most 4 notes, or the given limit', () => {
    const words = ['amber', 'birch', 'cedar', 'dune', 'elm', 'fern'];
    const notes = [...words.map((w) => note(w, { tags: [w] })), ...FILLERS];
    const query = words.join(' ');

    expect(ids(notes, query)).toHaveLength(4);
    expect(ids(notes, query, { limit: 2 })).toHaveLength(2);
  });

  test('should report the score and the matched terms', () => {
    const [result] = recall(
      [note('a', { tags: ['kubectl'] }), ...FILLERS],
      'kubectl pods',
      {
        now: NOW,
      }
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.matched).toEqual(['kubectl']);
  });

  describe('repo notes', () => {
    const notes = [
      note('r', { scope: 'repo', repo: 'web', tags: ['deploy'] }),
      ...FILLERS,
    ];

    test('should skip a note of another repo', () => {
      expect(ids(notes, 'deploy', { repo: 'api' })).toEqual([]);
    });

    test('should recall a note of the current repo', () => {
      expect(ids(notes, 'deploy', { repo: 'web' })).toEqual(['r']);
    });

    test('should recall a note of another repo the query names', () => {
      expect(ids(notes, 'deploy the Web app', { repo: 'api' })).toEqual(['r']);
    });

    test('should boost a note of the current repo', () => {
      const pair = [
        note('a', { scope: 'repo', repo: 'web', tags: ['deploy', 'release'] }),
        note('b', { tags: ['deploy', 'release'] }),
        ...FILLERS,
      ];

      expect(ratio(pair, 'deploy release', { repo: 'web' })).toBeCloseTo(
        BOOSTS.repo
      );
    });
  });

  describe('boosts', () => {
    test('should boost a machine note on a failure', () => {
      const pair = [
        note('a', { scope: 'machine', tags: ['docker', 'daemon'] }),
        note('b', { tags: ['docker', 'daemon'] }),
        ...FILLERS,
      ];

      expect(ratio(pair, 'docker daemon', { failure: true })).toBeCloseTo(
        BOOSTS.machineOnFailure
      );
      expect(ratio(pair, 'docker daemon', {})).toBeCloseTo(1);
    });

    test('should halve a fact checked one half-life ago', () => {
      const pair = [
        note('a', { tags: ['docker', 'daemon'], checked: '2026-05-24' }),
        note('b', { tags: ['docker', 'daemon'] }),
        ...FILLERS,
      ];

      expect(ratio(pair, 'docker daemon', {})).toBeCloseTo(0.5);
    });

    test('should age an unchecked note from its last update', () => {
      const pair = [
        note('a', {
          type: 'howto',
          tags: ['docker', 'daemon'],
          checked: null,
          updated: '2026-05-24',
        }),
        note('b', { type: 'howto', tags: ['docker', 'daemon'] }),
        ...FILLERS,
      ];

      expect(ratio(pair, 'docker daemon', {})).toBeCloseTo(0.5);
    });

    test('should not age a preference', () => {
      const pair = [
        note('a', {
          type: 'preference',
          tags: ['docker', 'daemon'],
          checked: '2020-01-01',
        }),
        note('b', { type: 'preference', tags: ['docker', 'daemon'] }),
        ...FILLERS,
      ];

      expect(ratio(pair, 'docker daemon', {})).toBeCloseTo(1);
    });

    test('should boost a note that was recalled before', () => {
      const pair = [
        note('a', { tags: ['docker', 'daemon'] }),
        note('b', { tags: ['docker', 'daemon'] }),
        ...FILLERS,
      ];
      const usage = { a: { hits: 9, lastHit: NOW.toISOString() } };

      expect(ratio(pair, 'docker daemon', { usage })).toBeCloseTo(
        1 + BOOSTS.usage * Math.log(10)
      );
    });

    test('should use the current time by default', () => {
      const notes = [note('a', { tags: ['docker'] }), ...FILLERS];

      expect(recall(notes, 'docker').map((r) => r.note.id)).toEqual(['a']);
    });
  });
});

describe('noteLabels', () => {
  test('should label a note by scope, type, and date', () => {
    expect(
      noteLabels(note('m1', { scope: 'machine', type: 'howto' }), NOW)
    ).toBe('machine, howto, 2026-11-20');
  });

  test('should judge staleness from today by default', () => {
    expect(
      noteLabels(note('m1', { type: 'fact', checked: '2000-01-01' }))
    ).toMatch(/, stale$/);
  });
});

describe('formatRecall', () => {
  /**
   * @param {Note} n
   * @returns {{ note: Note, score: number, matched: string[] }}
   */
  const result = (n) => ({ note: n, score: 1, matched: [] });

  test('should be empty for no results', () => {
    expect(formatRecall([])).toBe('');
  });

  test('should frame notes as facts and point to more', () => {
    const text = formatRecall(
      [
        result(
          note('m2', {
            scope: 'machine',
            type: 'howto',
            text: 'Merge by fast-forwarding main.',
          })
        ),
        result(
          note('m3', {
            scope: 'repo',
            repo: 'web',
            text: 'Deploys run on tags.',
          })
        ),
        result(
          note('t7', {
            type: 'episode',
            source: { via: 'digest', task: 'cws-auto-publish-261120' },
            text: 'Release runs submit to the store.',
          })
        ),
      ],
      { now: NOW }
    );

    expect(text.split('\n')).toEqual([
      RECALL_HEADER,
      '- m2 (machine, howto, 2026-11-20) Merge by fast-forwarding main.',
      '- m3 (repo web, fact, 2026-11-20) Deploys run on tags.',
      '- t7 (task cws-auto-publish-261120, 2026-11-20) Release runs submit to the store.',
      'More: pnpm memory recall "<query>" · full note: pnpm memory show <id>',
    ]);
  });

  test('should label unchecked and stale notes', () => {
    const lines = formatRecall(
      [
        result(
          note('m4', {
            scope: 'machine',
            checked: null,
            text: 'From another machine.',
          })
        ),
        result(
          note('m5', {
            scope: 'machine',
            updated: '2026-01-01',
            checked: '2026-01-01',
            text: 'Old fact.',
          })
        ),
      ],
      { now: NOW }
    ).split('\n');

    expect(lines[1]).toBe(
      '- m4 (machine, fact, 2026-11-20, unchecked) From another machine.'
    );
    expect(lines[2]).toBe('- m5 (machine, fact, 2026-01-01, stale) Old fact.');
  });

  test('should shorten a long note', () => {
    const lines = formatRecall(
      [result(note('m1', { text: 'x'.repeat(NOTE_CHARS + 100) }))],
      {
        now: NOW,
      }
    ).split('\n');

    const shown = lines[1].replace('- m1 (user, fact, 2026-11-20) ', '');
    expect(shown).toHaveLength(NOTE_CHARS);
    expect(shown.endsWith('…')).toBe(true);
  });

  test('should stop adding notes at the budget', () => {
    const many = ['a', 'b', 'c', 'd'].map((id) =>
      result(note(id, { text: 'y'.repeat(NOTE_CHARS) }))
    );

    const text = formatRecall(many, { now: NOW });

    expect(text.length).toBeLessThanOrEqual(INJECTION_BUDGET);
    expect(
      text.split('\n').filter((line) => line.startsWith('- '))
    ).toHaveLength(2);
  });

  test('should shorten the first note to fit a small budget', () => {
    const text = formatRecall(
      [result(note('a', { text: 'z'.repeat(NOTE_CHARS) }))],
      {
        now: NOW,
        budget: 300,
      }
    );

    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.split('\n')[1]).toMatch(/^- a \(user, fact, 2026-11-20\) z+…$/);
  });

  test('should be empty when not even one note fits', () => {
    expect(formatRecall([result(note('a'))], { now: NOW, budget: 150 })).toBe(
      ''
    );
  });

  test('should use the current time by default', () => {
    expect(
      formatRecall([result(note('a', { checked: '2000-01-01' }))])
    ).toMatch(/stale/);
  });
});

describe('matchTriggers', () => {
  const notes = [
    note('m1', { triggers: ['gh pr', 'pulls/*/merge'] }),
    note('m2', { triggers: ['docker compose'] }),
    note('m3', { triggers: ['a+b (x)'] }),
    note('m4', { triggers: ['--force'] }),
    note('m5', { triggers: ['gh pr'], status: 'deleted' }),
    note('m6', { triggers: ['gh pr'], pinned: true }),
    note('m7'),
  ];
  /** @param {string} command */
  const matched = (command) => matchTriggers(notes, command).map((n) => n.id);

  test('should match a plain trigger in the command', () => {
    expect(matched('gh pr create --fill')).toEqual(['m1']);
  });

  test('should match a * wildcard', () => {
    expect(matched('gh api -X PUT repos/o/r/pulls/12/merge')).toEqual(['m1']);
  });

  test('should ignore case', () => {
    expect(matched('Docker Compose up')).toEqual(['m2']);
  });

  test('should not match inside a longer word', () => {
    expect(matched('gh prune && docker composer')).toEqual([]);
  });

  test('should treat regex characters literally', () => {
    expect(matched('echo a+b (x)')).toEqual(['m3']);
    expect(matched('echo aab x')).toEqual([]);
  });

  test('should match a trigger that starts with punctuation', () => {
    expect(matched('git push --force-with-lease')).toEqual(['m4']);
  });

  test('should match nothing for an empty command', () => {
    expect(matched('')).toEqual([]);
  });
});

describe('loadIndex', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let dir;
  const indexFile = () => path.join(dir, CACHE_DIR, INDEX_CACHE_FILE);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recall-'));
    dir = memoryDir(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const add = (/** @type {string} */ text) =>
    addNote(dir, { text, scope: 'user', type: 'fact', tags: ['kubectl'] });

  test('should be empty without a store, and write nothing', () => {
    const { notes, index } = loadIndex(dir);

    expect(notes).toEqual([]);
    expect(index.N).toBe(0);
    expect(fs.existsSync(indexFile())).toBe(false);
  });

  test('should build and cache the index for the notes', () => {
    add('The cluster runs on kubectl.');

    const { notes, index } = loadIndex(dir);

    expect(notes.map((n) => n.id)).toEqual(['m1']);
    expect(Object.keys(index.docs)).toEqual(['m1']);
    expect(fs.existsSync(indexFile())).toBe(true);
  });

  test('should serve the cached index while the store is unchanged', () => {
    add('The cluster runs on kubectl.');
    loadIndex(dir);
    const cached = JSON.parse(fs.readFileSync(indexFile(), 'utf-8'));
    cached.index.N = 42;
    fs.writeFileSync(indexFile(), JSON.stringify(cached));

    expect(loadIndex(dir).index.N).toBe(42);
  });

  test('should rebuild the index after the store changed', () => {
    add('The cluster runs on kubectl.');
    loadIndex(dir);

    add('Grafana dashboards live in the ops folder.');

    expect(loadIndex(dir).index.N).toBe(2);
  });

  test('should rebuild from an index cache of another version', () => {
    add('The cluster runs on kubectl.');
    fs.mkdirSync(path.dirname(indexFile()), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify({ version: 0 }));

    expect(loadIndex(dir).index.N).toBe(1);
  });

  test('should not cache an index for a log that changed while read', () => {
    add('The cluster runs on kubectl.');
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

    const { index } = loadIndex(dir);

    expect(index.N).toBe(1);
    expect(fs.existsSync(indexFile())).toBe(false);
  });
});
