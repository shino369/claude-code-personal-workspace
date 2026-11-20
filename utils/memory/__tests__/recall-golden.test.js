/**
 * Golden retrieval tests: a realistic store and EN/JA/zh queries
 * (fixtures/recall-golden.json). The bar: the expected note is in the top 3
 * for at least 90% of the queries, in each language group, and unrelated
 * prompts recall nothing.
 */
import fs from 'fs';
import { buildIndex, recall } from '../recall.js';

/** @typedef {import('../store.js').Note} Note */
/** @typedef {{ q: string, expect?: string[], repo?: string, failure?: boolean }} Query */

const fixture = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/recall-golden.json', import.meta.url),
    'utf-8'
  )
);
const NOW = new Date('2026-11-20T12:00:00.000Z');
const BAR = 0.9;

/** @type {Note[]} */
const notes = fixture.notes.map((/** @type {Partial<Note>} */ n) => ({
  repo: null,
  tags: [],
  triggers: [],
  source: { via: 'agent' },
  pinned: false,
  supersedes: null,
  created: '2026-11-20',
  updated: '2026-11-20',
  checked: '2026-11-20',
  status: 'active',
  ...n,
}));
const index = buildIndex(notes);

/** @param {Query} query */
const run = (query) =>
  recall(notes, query.q, {
    index,
    repo: query.repo ?? 'workspace',
    failure: query.failure === true,
    now: NOW,
  }).map((result) => result.note.id);

/**
 * @param {Query[]} queries
 * @returns {{ recallAt3: number, misses: string[] }}
 */
function measure(queries) {
  const misses = queries
    .map((query) => ({ query, got: run(query) }))
    .filter(
      ({ query, got }) =>
        !got.slice(0, 3).some((id) => query.expect?.includes(id))
    )
    .map(
      ({ query, got }) =>
        `${JSON.stringify(query.q)} → [${got.join(', ')}], want ${query.expect}`
    );
  return { recallAt3: 1 - misses.length / queries.length, misses };
}

/** @type {Query[]} */
const queries = fixture.queries;
const isAscii = (/** @type {Query} */ query) => /^[\x00-\x7f]*$/.test(query.q);

describe('recall golden set', () => {
  test('should have queries in English and in Japanese or Chinese', () => {
    expect(queries.filter(isAscii).length).toBeGreaterThanOrEqual(10);
    expect(queries.filter((q) => !isAscii(q)).length).toBeGreaterThanOrEqual(
      10
    );
  });

  test.each([
    ['all queries', queries],
    ['English queries', queries.filter(isAscii)],
    ['Japanese and Chinese queries', queries.filter((q) => !isAscii(q))],
  ])('should reach recall@3 >= 0.9 for %s', (_label, group) => {
    const { recallAt3, misses } = measure(group);

    expect(recallAt3, misses.join('\n')).toBeGreaterThanOrEqual(BAR);
  });

  test.each(/** @type {Query[]} */ (fixture.unrelated))(
    'should recall nothing for the unrelated prompt $q',
    (query) => {
      expect(run(query)).toEqual([]);
    }
  );
});
