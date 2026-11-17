import {
  STEPS_END,
  STEPS_START,
  appendSeparator,
  formatLocal,
  formatNoteEntry,
  parseNotes,
  parsePlan,
  renderSteps,
  renderTemplate,
  replaceStepsBlock,
} from '../markdown.js';

/** @returns {import('../state.js').Step} */
const step = (/** @type {Partial<import('../state.js').Step>} */ o) => ({
  id: 's1',
  title: 'Do it',
  status: 'todo',
  deps: [],
  owner: null,
  ...o,
});

describe('renderTemplate', () => {
  test('should replace known keys and keep unknown placeholders', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}');
  });
});

describe('formatLocal', () => {
  const date = new Date(2026, 0, 2, 3, 4);

  test('should format the date only by default', () => {
    expect(formatLocal(date)).toBe('2026-01-02');
  });

  test('should include hours and minutes with withTime', () => {
    expect(formatLocal(date, { withTime: true })).toBe('2026-01-02 03:04');
  });
});

describe('renderSteps', () => {
  test('should render a placeholder for no steps', () => {
    expect(renderSteps([])).toMatch(/no steps yet/);
  });

  test('should render each status, deps, owner, and note', () => {
    const text = renderSteps([
      step({ status: 'done' }),
      step({ id: 's2', status: 'in_progress', owner: 'claude', deps: ['s1'] }),
      step({ id: 's3', status: 'in_progress' }),
      step({ id: 's4', status: 'blocked', note: 'waiting' }),
      step({ id: 's5', status: 'blocked' }),
      step({ id: 's6' }),
    ]);
    expect(text.split('\n')).toEqual([
      '- [x] s1. Do it',
      '- [ ] s2. Do it (after s1) — _in progress (claude)_',
      '- [ ] s3. Do it — _in progress_',
      '- [ ] s4. Do it — _blocked: waiting_',
      '- [ ] s5. Do it — _blocked_',
      '- [ ] s6. Do it',
    ]);
  });
});

describe('replaceStepsBlock', () => {
  const plan = `# Plan\n\n${STEPS_START} — generated -->\n\nold\n\n${STEPS_END}\n\n## Decisions\n`;

  test('should replace the content between the markers', () => {
    expect(replaceStepsBlock(plan, [step({})])).toBe(
      `# Plan\n\n${STEPS_START} — generated -->\n\n- [ ] s1. Do it\n\n${STEPS_END}\n\n## Decisions\n`
    );
  });

  test('should return null without markers', () => {
    expect(replaceStepsBlock('# Plan\n- [ ] x\n', [])).toBeNull();
  });

  test('should return null when the markers are out of order', () => {
    expect(
      replaceStepsBlock(`${STEPS_END}\n${STEPS_START} -->\n`, [])
    ).toBeNull();
  });

  test('should return null when only the end marker exists', () => {
    expect(replaceStepsBlock(`${STEPS_END}\n`, [])).toBeNull();
  });
});

describe('parsePlan', () => {
  test('should read the Goal line and checkboxes', () => {
    const result = parsePlan(
      '# Plan — x\n\nGoal: Ship it \n\n- [ ] one\n  * [X] two\n- [x] three\n- plain\n'
    );
    expect(result).toEqual({
      goal: 'Ship it',
      steps: [
        { title: 'one', done: false },
        { title: 'two', done: true },
        { title: 'three', done: true },
      ],
    });
  });

  test('should fall back to the heading without the Plan prefix', () => {
    expect(parsePlan('# Plan — workspace upgrade\n').goal).toBe(
      'workspace upgrade'
    );
  });

  test('should return an empty goal for an empty plan', () => {
    expect(parsePlan('')).toEqual({ goal: '', steps: [] });
  });
});

describe('parseNotes', () => {
  test('should split entries and ignore the title and fenced headings', () => {
    const notes = [
      '# NOTES',
      'preamble',
      '## first',
      '',
      'Done: a',
      '```md',
      '## not a heading',
      '```',
      '## second',
      'Next: b',
      '',
    ].join('\r\n');
    expect(parseNotes(notes)).toEqual([
      { heading: 'first', body: 'Done: a\n```md\n## not a heading\n```' },
      { heading: 'second', body: 'Next: b' },
    ]);
  });
});

describe('formatNoteEntry', () => {
  const at = new Date(2026, 10, 17, 14, 30);

  test('should render every field in order', () => {
    expect(
      formatNoteEntry({
        at,
        agent: 'codex',
        label: 'auto',
        message: 'msg',
        done: 'd',
        state: 's',
        next: 'n',
        open: 'o',
      })
    ).toBe(
      '## 2026-11-17 14:30 — codex (auto)\n\nmsg\nDone: d\nState: s\nNext: n\nOpen: o\n'
    );
  });

  test('should omit missing fields and the label', () => {
    expect(formatNoteEntry({ at, agent: 'a', done: 'd' })).toBe(
      '## 2026-11-17 14:30 — a\n\nDone: d\n'
    );
  });
});

describe('appendSeparator', () => {
  test.each([
    ['', 'E'],
    ['x\n\n', 'E'],
    ['x\n', '\nE'],
    ['x', '\n\nE'],
  ])('should separate %j correctly', (existing, expected) => {
    expect(appendSeparator(existing, 'E')).toBe(expected);
  });
});
