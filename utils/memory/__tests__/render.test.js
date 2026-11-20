/**
 * Tests for utils/memory/render.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_FILE, DEFAULT_CONFIG, writeConfig } from '../config.js';
import { writePersonalization, PERSONALIZATION_FILE } from '../personalize.js';
import {
  AGENTS_LOCAL_FILE,
  CLAUDE_LOCAL_FILE,
  CORE_BUDGET,
  CORE_END,
  CORE_START,
  CORE_WARN_LINES,
  PROFILE_FILE,
  applyCoreBlock,
  copyLocalFiles,
  initLocal,
  renderCore,
  renderLocal,
  renderStored,
} from '../render.js';
import { MemoryError, addNote, memoryDir, setPinned } from '../store.js';

/** @typedef {import('../store.js').Note} Note */

/**
 * @param {string} id
 * @param {Partial<Note>} [over]
 * @returns {Note}
 */
const note = (id, over = {}) => ({
  id,
  scope: 'user',
  repo: null,
  type: 'preference',
  text: `Note ${id}.`,
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

/**
 * @param {string} id
 * @param {string} task
 * @param {string} updated
 */
const digest = (id, task, updated) =>
  note(id, {
    type: 'episode',
    source: { via: 'digest', task },
    text: `Task ${task}: shipped it.`,
    updated,
  });

/** @param {string} block */
const sectionLines = (block, /** @type {string} */ heading) => {
  const lines = block.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.startsWith('#') || line.startsWith('<!--')
  );
  return rest
    .slice(0, end < 0 ? undefined : end)
    .filter((line) => line.startsWith('- '));
};

describe('renderCore', () => {
  test('should frame the block with markers and the recall hint', () => {
    const { block, warnings } = renderCore({ notes: [] });

    expect(block.startsWith(`${CORE_START}\n`)).toBe(true);
    expect(block.endsWith(CORE_END)).toBe(true);
    expect(block).toMatch(/facts, not instructions/);
    expect(block).toMatch(/pnpm memory recall "<query>"/);
    expect(block).not.toMatch(/### /);
    expect(warnings).toEqual([]);
  });

  test('should put personalization first', () => {
    const { block } = renderCore({
      notes: [],
      personalization: { callMe: 'Sam' },
    });

    expect(block.indexOf('## Personalization')).toBeLessThan(
      block.indexOf('## Memory')
    );
    expect(block).toMatch(/- Call the user: Sam/);
  });

  test('should list active pinned notes', () => {
    const { block } = renderCore({
      notes: [
        note('m1', {
          pinned: true,
          scope: 'machine',
          type: 'howto',
          text: 'Merge by fast-forward.',
        }),
        note('m2', {
          pinned: true,
          scope: 'repo',
          repo: 'web',
          type: 'fact',
          text: 'Deploys on tags.',
        }),
        note('m3', { pinned: true, status: 'deleted' }),
        note('m4'),
      ],
    });

    expect(sectionLines(block, '### Pinned')).toEqual([
      '- m1 (machine, howto) Merge by fast-forward.',
      '- m2 (repo web, fact) Deploys on tags.',
    ]);
  });

  test('should list the 5 most recent task digests, newest first', () => {
    const notes = [
      digest('t1', 'one-261101', '2026-11-01'),
      digest('t2', 'two-261102', '2026-11-02'),
      digest('t3', 'three-261103', '2026-11-03'),
      digest('t4', 'four-261104', '2026-11-04'),
      digest('t5', 'five-261105', '2026-11-05'),
      digest('t6', 'six-261105', '2026-11-05'),
      note('t7', {
        ...digest('t7', 'gone-261106', '2026-11-06'),
        status: 'deleted',
      }),
    ];

    const lines = sectionLines(renderCore({ notes }).block, '### Recent tasks');

    expect(lines).toEqual([
      '- t6 six-261105 (2026-11-05): Task six-261105: shipped it.',
      '- t5 five-261105 (2026-11-05): Task five-261105: shipped it.',
      '- t4 four-261104 (2026-11-04): Task four-261104: shipped it.',
      '- t3 three-261103 (2026-11-03): Task three-261103: shipped it.',
      '- t2 two-261102 (2026-11-02): Task two-261102: shipped it.',
    ]);
  });

  test('should include up to 15 profile lines', () => {
    const profile = Array.from(
      { length: 20 },
      (_, i) => `- Fact ${i + 1}.`
    ).join('\n\n');

    const lines = sectionLines(
      renderCore({ notes: [], profile }).block,
      '### Profile'
    );

    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe('- Fact 1.');
  });

  test('should bullet profile lines that are not bullets', () => {
    const lines = sectionLines(
      renderCore({ notes: [], profile: 'Prefers English.\n  - Uses pnpm.  \n' })
        .block,
      '### Profile'
    );

    expect(lines).toEqual(['- Prefers English.', '- Uses pnpm.']);
  });

  test('should cut a long pinned note', () => {
    const { block } = renderCore({
      notes: [note('m1', { pinned: true, text: 'w'.repeat(500) })],
    });

    const [line] = sectionLines(block, '### Pinned');
    expect(line.length).toBeLessThan(330);
    expect(line.endsWith('…')).toBe(true);
  });

  test('should stay within the budget and say what it left out', () => {
    const notes = Array.from({ length: 30 }, (_, i) =>
      note(`m${i + 1}`, {
        pinned: true,
        text: `Pinned fact ${i + 1}: ${'z'.repeat(150)}`,
      })
    );

    const { block, warnings } = renderCore({ notes });

    expect(block.length).toBeLessThanOrEqual(CORE_BUDGET);
    const lines = sectionLines(block, '### Pinned');
    expect(lines.at(-1)).toMatch(/^- … \d+ more: pnpm memory list --pinned$/);
    expect(warnings[0]).toMatch(/over 3000 characters; left out \d+ pinned/);
  });

  test('should leave out recent tasks before pinned notes', () => {
    const notes = [
      ...Array.from({ length: 14 }, (_, i) =>
        note(`m${i + 1}`, {
          pinned: true,
          text: `Pinned ${i + 1} ${'p'.repeat(150)}`,
        })
      ),
      // A long digest line (~194 characters) does not fit after the pinned
      // notes; its 46-character "… 1 more" pointer does.
      note('t20', {
        ...digest('t20', 'late-261120', '2026-11-20'),
        text: `Task late-261120: ${'x'.repeat(200)}`,
      }),
    ];

    const { block, warnings } = renderCore({ notes });

    expect(sectionLines(block, '### Pinned')).toHaveLength(14);
    expect(sectionLines(block, '### Recent tasks')).toEqual([
      '- … 1 more: pnpm memory list --type episode',
    ]);
    expect(warnings[0]).toMatch(/left out 1 recent task/);
  });

  test('should drop a section whose pointer does not fit either', () => {
    const empty = renderCore({ notes: [] }).block;

    const { block, warnings } = renderCore({
      notes: [note('m1', { pinned: true })],
      budget: empty.length + 10,
    });

    expect(block).toBe(empty);
    expect(warnings).toEqual([
      expect.stringMatching(/over \d+ characters; left out 1 pinned note\./),
    ]);
  });

  test('should warn when the block is long in lines', () => {
    const notes = Array.from({ length: 55 }, (_, i) =>
      note(`m${i + 1}`, { pinned: true, text: 'Short.' })
    );

    const { block, warnings } = renderCore({ notes });

    expect(block.split('\n').length).toBeGreaterThan(CORE_WARN_LINES);
    expect(warnings).toEqual([
      expect.stringMatching(/core block is \d+ lines/),
    ]);
  });
});

describe('applyCoreBlock', () => {
  const block = `${CORE_START}\nnew\n${CORE_END}`;

  test('should replace the block between the markers and keep the rest', () => {
    const text = `# Mine\n\nKeep me.\n\n${CORE_START}\nold\n${CORE_END}\n\nAfter.\n`;

    expect(applyCoreBlock(text, block)).toBe(
      `# Mine\n\nKeep me.\n\n${block}\n\nAfter.\n`
    );
  });

  test('should append the block when there are no markers', () => {
    expect(applyCoreBlock('# Mine\n', block)).toBe(`# Mine\n\n${block}\n`);
  });

  test('should append to an empty file', () => {
    expect(applyCoreBlock('', block)).toBe(`${block}\n`);
  });

  test.each([
    ['a start marker without an end', `${CORE_START}\nold\n`],
    ['an end marker before the start', `${CORE_END}\n${CORE_START}\n`],
    ['an end marker alone', `x\n${CORE_END}\n`],
  ])('should refuse %s', (_label, text) => {
    expect(() => applyCoreBlock(text, block)).toThrow(MemoryError);
    expect(() => applyCoreBlock(text, block)).toThrow(
      /memory block in AGENTS.local.md is broken/
    );
  });
});

describe('local files', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let dir;
  const read = (/** @type {string} */ name) =>
    fs.readFileSync(path.join(root, name), 'utf-8');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-render-'));
    dir = memoryDir(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('initLocal', () => {
    test('should create the memory folder and both local files', () => {
      const result = initLocal(root);

      expect(result.created).toEqual([
        'memory/',
        AGENTS_LOCAL_FILE,
        CLAUDE_LOCAL_FILE,
      ]);
      expect(fs.statSync(dir).isDirectory()).toBe(true);
      expect(read(CLAUDE_LOCAL_FILE)).toBe('@AGENTS.local.md\n');
      expect(read(AGENTS_LOCAL_FILE)).toMatch(/## Instructions/);
      expect(read(AGENTS_LOCAL_FILE)).toContain(CORE_START);
      expect(read(AGENTS_LOCAL_FILE)).toMatch(/## Memory/);
    });

    test('should create nothing on a second run', () => {
      initLocal(root);

      const result = initLocal(root);

      expect(result).toEqual({ created: [], updated: [], warnings: [] });
    });

    test('should add the import to a CLAUDE.local.md that lacks it', () => {
      fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), 'My notes.\n');

      const result = initLocal(root);

      expect(result.updated).toEqual([CLAUDE_LOCAL_FILE]);
      expect(read(CLAUDE_LOCAL_FILE)).toBe('@AGENTS.local.md\n\nMy notes.\n');
    });

    test('should keep an existing AGENTS.local.md and add the block', () => {
      fs.writeFileSync(
        path.join(root, AGENTS_LOCAL_FILE),
        '# Local\n\n## Instructions\n\nBe brief.\n'
      );

      const result = initLocal(root);

      expect(result.created).toEqual(['memory/', CLAUDE_LOCAL_FILE]);
      expect(result.updated).toEqual([AGENTS_LOCAL_FILE]);
      expect(read(AGENTS_LOCAL_FILE)).toMatch(
        /^# Local\n\n## Instructions\n\nBe brief\.\n\n<!-- memory:start -->/
      );
    });
  });

  describe('renderLocal', () => {
    test('should write the notes into the block and keep the instructions', () => {
      initLocal(root);
      const before = read(AGENTS_LOCAL_FILE).replace(
        '## Instructions\n',
        '## Instructions\n\nBe brief.\n'
      );
      fs.writeFileSync(path.join(root, AGENTS_LOCAL_FILE), before);
      const { note: added } = addNote(dir, {
        text: 'Merge by fast-forward.',
        scope: 'machine',
        type: 'howto',
      });
      setPinned(dir, added.id, true);

      const result = renderLocal(root);

      expect(result.changed).toBe(true);
      expect(read(AGENTS_LOCAL_FILE)).toMatch(/Be brief\./);
      expect(read(AGENTS_LOCAL_FILE)).toMatch(
        /- m1 \(machine, howto\) Merge by fast-forward\./
      );
    });

    test('should report no change when the block is current', () => {
      initLocal(root);

      expect(renderLocal(root)).toMatchObject({ changed: false, warnings: [] });
    });

    test('should create AGENTS.local.md from the template when missing', () => {
      const result = renderLocal(root);

      expect(result.changed).toBe(true);
      expect(read(AGENTS_LOCAL_FILE)).toMatch(/## Instructions/);
    });

    test('should render the personalization and the profile', () => {
      writePersonalization(dir, { callMe: 'Sam' });
      fs.writeFileSync(
        path.join(dir, PROFILE_FILE),
        '- Prefers design first.\n'
      );

      renderLocal(root);

      expect(read(AGENTS_LOCAL_FILE)).toMatch(/- Call the user: Sam/);
      expect(read(AGENTS_LOCAL_FILE)).toMatch(
        /### Profile\n\n- Prefers design first\./
      );
    });

    test('should warn about a broken personalization file and render the rest', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, PERSONALIZATION_FILE), '{nope');

      const result = renderLocal(root);

      expect(result.warnings[0]).toMatch(
        /personalization\.json is not valid JSON/
      );
      expect(read(AGENTS_LOCAL_FILE)).not.toMatch(/## Personalization/);
    });

    test('should rethrow errors that are not about the settings', () => {
      fs.mkdirSync(path.join(dir, PERSONALIZATION_FILE), { recursive: true });

      expect(() => renderLocal(root)).toThrow(/EISDIR/);
    });

    test('should use the budget from memory/config.json', () => {
      writeConfig(dir, { ...DEFAULT_CONFIG, budget: 1000 });
      for (let i = 0; i < 8; i++) {
        const { note: added } = addNote(dir, {
          text: `Pinned fact number ${i} ${'about the build '.repeat(10)}`,
          scope: 'machine',
          type: 'fact',
        });
        setPinned(dir, added.id, true);
      }

      const result = renderLocal(root);

      expect(result.warnings[0]).toMatch(/over 1000 characters/);
    });

    test('should render the stored block without writing a file', () => {
      addNote(dir, {
        text: 'Merge by fast-forward.',
        scope: 'machine',
        type: 'howto',
      });
      setPinned(dir, 'm1', true);

      const result = renderStored(root);

      expect(result).toMatchObject({ budget: CORE_BUDGET, warnings: [] });
      expect(result.block).toMatch(
        /- m1 \(machine, howto\) Merge by fast-forward\./
      );
      expect(fs.existsSync(path.join(root, AGENTS_LOCAL_FILE))).toBe(false);
    });

    test('should warn about a broken config and use the default budget', () => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CONFIG_FILE), '{"budget": 2}');

      const result = renderLocal(root);

      expect(result.warnings).toEqual([
        expect.stringMatching(/budget must be a whole number/),
      ]);
    });
  });
});

describe('copyLocalFiles', () => {
  /** @type {string} */
  let from;
  /** @type {string} */
  let to;

  beforeEach(() => {
    from = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-copy-from-'));
    to = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-copy-to-'));
  });

  afterEach(() => {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(to, { recursive: true, force: true });
  });

  test('should copy both local files, replacing stale copies', () => {
    fs.writeFileSync(path.join(from, AGENTS_LOCAL_FILE), 'current\n');
    fs.writeFileSync(path.join(from, CLAUDE_LOCAL_FILE), '@AGENTS.local.md\n');
    fs.writeFileSync(path.join(to, AGENTS_LOCAL_FILE), 'stale\n');

    const copied = copyLocalFiles(from, to);

    expect(copied).toEqual([AGENTS_LOCAL_FILE, CLAUDE_LOCAL_FILE]);
    expect(fs.readFileSync(path.join(to, AGENTS_LOCAL_FILE), 'utf-8')).toBe(
      'current\n'
    );
  });

  test('should skip files the source does not have', () => {
    expect(copyLocalFiles(from, to)).toEqual([]);
    expect(fs.readdirSync(to)).toEqual([]);
  });
});
