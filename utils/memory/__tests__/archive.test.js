/**
 * Tests for utils/memory/archive.js (pnpm memory export / import)
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {
  ARCHIVE_FORMAT,
  DEFAULT_PARTS,
  MANIFEST_FILE,
  applyImport,
  checkPath,
  collectExport,
  exportArchive,
  formatExport,
  formatImport,
  parseParts,
  planImport,
  readArchive,
  userInstructions,
} from '../archive.js';
import { readPersonalization, writePersonalization } from '../personalize.js';
import {
  AGENTS_LOCAL_FILE,
  CORE_END,
  CORE_START,
  initLocal,
} from '../render.js';
import { listSnapshots } from '../snapshot.js';
import {
  LOG_FILE,
  addNote,
  deleteNote,
  loadNotes,
  memoryDir,
} from '../store.js';
import { packTar } from '../tar.js';

/** @type {string} */
let tmp;
/** @type {string} */
let source;
/** @type {string} */
let target;

const NOW = new Date(2026, 10, 20, 14, 3);
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

/** @param {string} root @param {any} input */
const add = (root, input) =>
  addNote(
    memoryDir(root),
    { scope: 'machine', type: 'howto', ...input },
    { now: NOW }
  ).note;

/** @param {string} root @param {string} rel @param {string} text */
function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** A checkout with notes, settings, instructions, two tasks, resources. */
function seedSource() {
  initLocal(source);
  add(source, {
    scope: 'user',
    type: 'preference',
    text: 'The user prefers design first, then review.',
    tags: ['design'],
  });
  add(source, {
    text: 'The proxy blocks GitHub GraphQL; merge by fast-forwarding main.',
    tags: ['proxy'],
  });
  add(source, {
    scope: 'repo',
    repo: 'web',
    text: 'web deploys when a tag is pushed.',
    tags: ['deploy'],
  });
  deleteNote(
    memoryDir(source),
    add(source, { text: 'An old wrong fact about builds.' }).id,
    'wrong'
  );
  writePersonalization(memoryDir(source), { callMe: 'Sam', tone: 'calm' });
  const agents = fs.readFileSync(path.join(source, AGENTS_LOCAL_FILE), 'utf-8');
  fs.writeFileSync(
    path.join(source, AGENTS_LOCAL_FILE),
    agents.replace(
      '## Instructions\n',
      '## Instructions\n\nAlways run the tests twice.\n'
    )
  );
  write(source, 'tasks/alpha-261120/plan.md', '# alpha\n');
  write(
    source,
    'tasks/alpha-261120/state.json',
    JSON.stringify({ repo: '/nowhere/repo' })
  );
  write(source, 'tasks/beta-261120/NOTES.md', 'notes\n');
  write(source, 'tasks/.trash/x.md', 'trash\n');
  write(source, 'tasks/.active', 'alpha-261120\n');
  write(source, 'resources/img/logo.txt', 'logo\n');
  fs.symlinkSync('/etc/hosts', path.join(source, 'resources', 'hosts'));
}

beforeEach(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-archive-'))
  );
  source = path.join(tmp, 'source');
  target = path.join(tmp, 'target');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ALL = ['memory', 'personalization', 'tasks', 'resources'];

/** @param {Partial<Parameters<typeof exportArchive>[1]>} [options] */
const exportAll = (options = {}) =>
  exportArchive(source, {
    parts: ALL,
    tasks: [],
    out: path.join(tmp, 'export.tar.gz'),
    allowSecrets: false,
    now: NOW,
    machine: 'old-laptop',
    ...options,
  });

/**
 * Write an archive by hand (for archives export never makes).
 *
 * @param {{ path: string, type?: 'file' | 'dir', data?: string }[]} entries
 * @param {any} [manifest] defaults to one that lists every file
 */
function craft(entries, manifest) {
  const files = entries.map((entry) => ({
    path: entry.path,
    type: entry.type ?? 'file',
    data: Buffer.from(entry.data ?? ''),
  }));
  const sums = Object.fromEntries(
    files
      .filter((file) => file.type === 'file')
      .map((file) => [
        file.path,
        crypto.createHash('sha256').update(file.data).digest('hex'),
      ])
  );
  const body = manifest ?? {
    format: ARCHIVE_FORMAT,
    created: NOW.toISOString(),
    machine: 'x',
    parts: ALL,
    counts: {},
    files: sums,
  };
  const file = path.join(tmp, `crafted-${Math.random()}.tar.gz`);
  fs.writeFileSync(
    file,
    zlib.gzipSync(
      packTar([
        {
          path: MANIFEST_FILE,
          type: 'file',
          data: Buffer.from(JSON.stringify(body)),
        },
        ...files,
      ])
    )
  );
  return file;
}

describe('parseParts', () => {
  test('should default to memory and personalization', () => {
    expect(parseParts(undefined)).toEqual(DEFAULT_PARTS);
  });

  test('should read a comma list in the standard order', () => {
    expect(parseParts('resources, memory,memory')).toEqual([
      'memory',
      'resources',
    ]);
  });

  test('should refuse an unknown or empty part', () => {
    expect(() => parseParts('memory,photos')).toThrow(/Unknown part "photos"/);
    expect(() => parseParts(' , ')).toThrow(/at least one part/);
  });
});

describe('userInstructions', () => {
  test('should keep the text before the core block', () => {
    expect(
      userInstructions(`# A\n\nmine\n\n${CORE_START}\nx\n${CORE_END}\n`)
    ).toBe('# A\n\nmine\n');
  });

  test('should keep a file without a block whole', () => {
    expect(userInstructions('# A\nmine')).toBe('# A\nmine\n');
  });
});

describe('collectExport', () => {
  test('should collect each part, leaving out hidden task folders and links', () => {
    seedSource();

    const { files, skipped, counts } = collectExport(source, {
      parts: ALL,
      tasks: [],
    });

    expect(files.map((file) => file.path)).toEqual([
      'memory/log.jsonl',
      'personalization/personalization.json',
      'personalization/instructions.md',
      'tasks/alpha-261120/plan.md',
      'tasks/alpha-261120/state.json',
      'tasks/beta-261120/NOTES.md',
      'resources/img/logo.txt',
    ]);
    expect(skipped).toEqual(['resources/hosts']);
    expect(counts).toEqual({ notes: 3, tasks: 2, files: 7 });
    expect(files[2].data.toString()).toContain('Always run the tests twice.');
    expect(files[2].data.toString()).not.toContain(CORE_START);
  });

  test('should collect only the named tasks', () => {
    seedSource();

    const { files } = collectExport(source, {
      parts: ['tasks'],
      tasks: ['beta-261120'],
    });

    expect(files.map((file) => file.path)).toEqual([
      'tasks/beta-261120/NOTES.md',
    ]);
  });

  test('should refuse a task that is not here', () => {
    seedSource();

    expect(() =>
      collectExport(source, { parts: ['tasks'], tasks: ['nope'] })
    ).toThrow(/No task folder tasks\/nope/);
    expect(() =>
      collectExport(source, { parts: ['tasks'], tasks: ['../x'] })
    ).toThrow(/No task folder/);
  });

  test('should collect nothing from a checkout without memory', () => {
    expect(collectExport(source, { parts: ALL, tasks: [] })).toEqual({
      files: [],
      skipped: [],
      counts: { notes: 0, tasks: 0, files: 0 },
    });
  });
});

describe('exportArchive', () => {
  test('should write a gzip tar with a manifest of checksums', () => {
    seedSource();

    const result = exportAll();
    const archive = readArchive(result.file);

    expect(result.bytes).toBe(fs.statSync(result.file).size);
    expect(archive.manifest).toMatchObject({
      format: ARCHIVE_FORMAT,
      created: NOW.toISOString(),
      machine: 'old-laptop',
      parts: ALL,
      counts: { notes: 3, tasks: 2, files: 7 },
    });
    expect(Object.keys(archive.manifest.files)).toHaveLength(7);
    expect(archive.files.get('resources/img/logo.txt')?.toString()).toBe(
      'logo\n'
    );
  });

  test('should refuse to overwrite a file', () => {
    seedSource();
    exportAll();

    expect(() => exportAll()).toThrow(/already exists/);
  });

  test('should refuse files that look like they hold secrets', () => {
    seedSource();
    write(source, 'tasks/beta-261120/tmp/agent.md', `token ${TOKEN}\n`);

    expect(() => exportAll()).toThrow(
      /1 file looks like it holds a secret: tasks\/beta-261120\/tmp\/agent\.md \(github-token\)/
    );
    expect(fs.existsSync(path.join(tmp, 'export.tar.gz'))).toBe(false);
  });

  test('should export secrets only when allowed, and say so', () => {
    seedSource();
    write(source, 'tasks/beta-261120/a.md', `token ${TOKEN}\n`);
    write(source, 'tasks/beta-261120/b.md', `token ${TOKEN}\n`);

    const result = exportAll({ allowSecrets: true });

    expect(result.secrets.map((hit) => hit.path)).toEqual([
      'tasks/beta-261120/a.md',
      'tasks/beta-261120/b.md',
    ]);
  });

  test('should name several files with secrets in the refusal', () => {
    seedSource();
    write(source, 'tasks/beta-261120/a.md', `token ${TOKEN}\n`);
    write(source, 'tasks/beta-261120/b.md', `token ${TOKEN}\n`);

    expect(() => exportAll()).toThrow(/2 files look like they hold secrets/);
  });
});

describe('formatExport', () => {
  test('should summarize the export and warn about what it holds', () => {
    seedSource();
    write(source, 'tasks/beta-261120/a.md', `token ${TOKEN}\n`);
    const result = exportAll({ allowSecrets: true });

    const lines = formatExport(result, tmp);

    expect(lines[0]).toMatch(
      /^Exported memory, personalization, tasks, resources to export\.tar\.gz \(3 notes, 2 tasks, 8 files, [\d.]+ KB\)\.$/
    );
    expect(lines).toContain('Skipped 1 link or special file: resources/hosts');
    expect(lines).toContain(
      'Warning: it holds possible secrets (--allow-secrets): tasks/beta-261120/a.md'
    );
    expect(lines.at(-1)).toBe(
      'It holds your personal notes and settings: keep it private.'
    );
  });

  test('should leave out skips and secrets when there are none', () => {
    const lines = formatExport(
      {
        file: path.join(tmp, 'a.tar.gz'),
        bytes: 2048,
        manifest: /** @type {any} */ ({
          parts: ['memory'],
          counts: { notes: 2, tasks: 1, files: 3 },
        }),
        skipped: [],
        secrets: [],
      },
      tmp
    );

    expect(lines).toEqual([
      'Exported memory to a.tar.gz (2 notes, 1 task, 3 files, 2.0 KB).',
      'It holds your personal notes and settings: keep it private.',
    ]);
  });

  test('should show bytes for a small export, with plural skips', () => {
    const lines = formatExport(
      {
        file: path.join(tmp, 'a.tar.gz'),
        bytes: 500,
        manifest: /** @type {any} */ ({
          parts: ['memory'],
          counts: { notes: 1, tasks: 0, files: 1 },
        }),
        skipped: ['a', 'b'],
        secrets: [],
      },
      tmp
    );

    expect(lines[0]).toBe(
      'Exported memory to a.tar.gz (1 note, 0 tasks, 1 file, 500 B).'
    );
    expect(lines[1]).toBe('Skipped 2 links or special files: a, b');
  });
});

describe('checkPath', () => {
  test.each([
    [MANIFEST_FILE],
    ['memory/log.jsonl'],
    ['tasks/alpha-261120/plan.md'],
    ['resources/a/b.png'],
    ['tasks'],
  ])('should accept %s', (entry) => {
    expect(() => checkPath(entry)).not.toThrow();
  });

  test.each([
    ['', /has no path/],
    ['/etc/passwd', /absolute/],
    ['C:/Windows/x', /absolute/],
    ['memory/../../x', /climbs out/],
    ['memory\\x', /backslash/],
    ['memory//x', /empty or "\." segment/],
    ['memory/./x', /empty or "\." segment/],
    ['etc/passwd', /outside the parts/],
    ['tasks/.trash/x', /hidden/],
  ])('should refuse %j', (entry, why) => {
    expect(() => checkPath(entry)).toThrow(why);
  });
});

describe('readArchive', () => {
  test('should refuse an archive whose files do not match the manifest', () => {
    const file = craft([{ path: 'memory/log.jsonl', data: 'x' }], {
      format: ARCHIVE_FORMAT,
      parts: ['memory'],
      files: { 'memory/log.jsonl': '0'.repeat(64) },
    });

    expect(() => readArchive(file)).toThrow(
      /"memory\/log\.jsonl" does not match its checksum/
    );
  });

  test('should refuse a file missing from the manifest or from the archive', () => {
    const extra = craft([{ path: 'memory/log.jsonl' }], {
      format: ARCHIVE_FORMAT,
      parts: ['memory'],
      files: {},
    });
    const missing = craft([], {
      format: ARCHIVE_FORMAT,
      parts: ['memory'],
      files: { 'memory/log.jsonl': '0'.repeat(64) },
    });

    expect(() => readArchive(extra)).toThrow(
      /"memory\/log\.jsonl" is not in the manifest/
    );
    expect(() => readArchive(missing)).toThrow(
      /listed in the manifest but missing/
    );
  });

  test.each([
    ['no manifest', null],
    ['another format', { format: 2, parts: [], files: {} }],
    ['unknown parts', { format: ARCHIVE_FORMAT, parts: ['photos'], files: {} }],
    [
      'parts that are not a list',
      { format: ARCHIVE_FORMAT, parts: 'memory', files: {} },
    ],
    ['no file list', { format: ARCHIVE_FORMAT, parts: [], files: [] }],
    [
      'a bad checksum value',
      { format: ARCHIVE_FORMAT, parts: [], files: { 'memory/x': 'zz' } },
    ],
  ])('should refuse a manifest with %s', (_label, manifest) => {
    const file =
      manifest === null
        ? (() => {
            const f = path.join(tmp, 'nomanifest.tar.gz');
            fs.writeFileSync(f, zlib.gzipSync(packTar([])));
            return f;
          })()
        : craft([], manifest);

    expect(() => readArchive(file)).toThrow(/Refused/);
  });

  test('should refuse a manifest that is not JSON', () => {
    const file = path.join(tmp, 'bad.tar.gz');
    fs.writeFileSync(
      file,
      zlib.gzipSync(
        packTar([{ path: MANIFEST_FILE, type: 'file', data: Buffer.from('{') }])
      )
    );

    expect(() => readArchive(file)).toThrow(/manifest\.json is not valid JSON/);
  });

  test('should refuse bad paths and duplicates before extracting anything', () => {
    expect(() =>
      readArchive(craft([{ path: 'tasks/../../evil.sh', data: 'x' }]))
    ).toThrow(/climbs out/);
    expect(() =>
      readArchive(craft([{ path: 'resources/a' }, { path: 'resources/a' }]))
    ).toThrow(/twice/);
  });

  test('should accept folder entries', () => {
    const archive = readArchive(
      craft([
        { path: 'resources/d', type: 'dir' },
        { path: 'resources/d/f', data: 'f' },
      ])
    );

    expect([...archive.files.keys()]).toEqual(['resources/d/f']);
  });

  test('should refuse a symlink inside the archive', () => {
    const header = Buffer.alloc(512);
    header.write('resources/link', 0);
    header.write('0000777\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write('00000000000\0', 124);
    header.write('00000000000\0', 136);
    header.write('2', 156);
    header.write('/etc/passwd', 157);
    header.write('ustar\0', 257);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const file = path.join(tmp, 'link.tar.gz');
    fs.writeFileSync(
      file,
      zlib.gzipSync(Buffer.concat([header, Buffer.alloc(1024)]))
    );

    expect(() => readArchive(file)).toThrow(
      /Refused: resources\/link is a symbolic link/
    );
  });

  test('should refuse a file that is not an archive', () => {
    const file = path.join(tmp, 'plain.txt');
    fs.writeFileSync(file, 'hello');

    expect(() => readArchive(file)).toThrow(
      /Refused: The file is not a gzip archive/
    );
  });

  test('should report a missing file plainly', () => {
    expect(() => readArchive(path.join(tmp, 'none.tar.gz'))).toThrow(/No file/);
  });
});

describe('planImport and applyImport', () => {
  /** @param {any} [options] */
  const plan = (options = {}) => {
    const archive = readArchive(exportAll().file);
    return {
      archive,
      plan: planImport(target, archive, {
        include: null,
        replace: false,
        ...options,
      }),
    };
  };

  test('should plan every part of a fresh import', () => {
    seedSource();

    const { plan: p } = plan();

    expect(p.parts).toEqual(ALL);
    expect(p.notes?.add).toHaveLength(3);
    expect(p.notes?.add.map((input) => input.unchecked)).toEqual([
      false,
      true,
      true,
    ]);
    expect(p.notes?.add[0].source).toEqual({ via: 'import' });
    expect(p.personalization?.set).toEqual(['callMe', 'tone']);
    expect(p.instructions).toBe('set');
    expect(p.tasks).toEqual({ add: ['alpha-261120', 'beta-261120'], skip: [] });
    expect(p.resources).toEqual({ add: ['img/logo.txt'], skip: [] });
    expect(p.warnings).toEqual([
      'Task alpha-261120 works in /nowhere/repo, which does not exist here.',
    ]);
  });

  test('should import notes with new ids, other machines unchecked', () => {
    seedSource();
    initLocal(target);
    add(target, {
      text: 'Docker needs 8 GB of memory here.',
      tags: ['docker'],
    });
    const { archive, plan: p } = plan();

    const result = applyImport(target, archive, p, {
      now: NOW,
      detail: 'export.tar.gz',
    });

    const notes = loadNotes(memoryDir(target)).notes;
    expect(notes.map((note) => note.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(notes.map((note) => note.checked)).toEqual([
      expect.any(String),
      expect.any(String),
      null,
      null,
    ]);
    expect(notes[1].source).toEqual({ via: 'import' });
    expect(result.added).toBe(3);
    expect(result.snapshot).toMatch(/-import$/);
    expect(listSnapshots(target)).toHaveLength(1);
  });

  test('should merge duplicates instead of adding them', () => {
    seedSource();
    initLocal(target);
    add(target, {
      scope: 'user',
      type: 'preference',
      text: 'The user prefers design first, then review.',
    });

    const { plan: p } = plan();

    expect(p.notes?.add).toHaveLength(2);
    expect(p.notes?.duplicates).toBe(1);
  });

  test('should keep the task of a digest as its source', () => {
    initLocal(source);
    addNote(
      memoryDir(source),
      {
        scope: 'machine',
        type: 'episode',
        text: 'Task alpha: shipped.',
        source: { via: 'digest', task: 'alpha-261120' },
      },
      { now: NOW }
    );

    const { plan: p } = plan({ include: ['memory'] });

    expect(p.notes?.add[0].source).toEqual({
      via: 'import',
      task: 'alpha-261120',
    });
  });

  test('should refuse imported notes with secrets and report bad log lines', () => {
    const log = [
      {
        op: 'add',
        at: NOW.toISOString(),
        note: {
          id: 'm1',
          text: `token ${TOKEN}`,
          scope: 'machine',
          type: 'fact',
        },
      },
      {
        op: 'add',
        at: NOW.toISOString(),
        note: {
          id: 'm2',
          text: 'A fine imported fact.',
          scope: 'machine',
          type: 'fact',
        },
      },
      {
        op: 'add',
        at: 'x',
        note: { id: 'm3', text: '', scope: 'machine', type: 'fact' },
      },
    ]
      .map((op) => JSON.stringify(op))
      .join('\n');
    const archive = readArchive(
      craft([{ path: 'memory/log.jsonl', data: `${log}\nnot json` }])
    );

    const p = planImport(target, archive, {
      include: ['memory'],
      replace: false,
    });

    expect(p.notes).toMatchObject({ refused: 1, duplicates: 0 });
    expect(p.notes?.add).toHaveLength(1);
    expect(p.notes?.invalid).toEqual([
      'log line 4: not JSON',
      'log: add m3 at x: The note text is empty.',
    ]);
  });

  test('should count a note the store refuses as a secret', () => {
    const archive = readArchive(
      craft([
        {
          path: 'memory/log.jsonl',
          data: JSON.stringify({
            op: 'add',
            at: NOW.toISOString(),
            note: {
              id: 'm1',
              text: 'A fact with a secret tag.',
              scope: 'machine',
              type: 'fact',
              tags: [TOKEN],
            },
          }),
        },
      ])
    );

    const p = planImport(target, archive, {
      include: ['memory'],
      replace: false,
    });

    expect(p.notes?.refused).toBe(1);
  });

  test('should keep local personalization and instructions unless replacing', () => {
    seedSource();
    initLocal(target);
    writePersonalization(memoryDir(target), { callMe: 'Alex' });
    const agents = fs.readFileSync(
      path.join(target, AGENTS_LOCAL_FILE),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(target, AGENTS_LOCAL_FILE),
      agents.replace('## Instructions\n', '## Instructions\n\nMy own rule.\n')
    );
    const { archive, plan: p } = plan();

    applyImport(target, archive, p, { now: NOW, detail: 'x' });

    expect(p.personalization).toMatchObject({
      set: ['tone'],
      kept: ['callMe'],
    });
    expect(readPersonalization(memoryDir(target))).toEqual({
      callMe: 'Alex',
      tone: 'calm',
    });
    expect(p.instructions).toBe('kept');
    expect(
      fs.readFileSync(path.join(target, AGENTS_LOCAL_FILE), 'utf-8')
    ).toContain('My own rule.');
  });

  test('should replace the store, settings, and instructions with --replace', () => {
    seedSource();
    initLocal(target);
    add(target, {
      text: 'Docker needs 8 GB of memory here.',
      tags: ['docker'],
    });
    writePersonalization(memoryDir(target), { callMe: 'Alex', persona: 'cat' });
    const archive = readArchive(exportAll().file);
    const p = planImport(target, archive, { include: null, replace: true });

    const result = applyImport(target, archive, p, {
      now: NOW,
      detail: 'x',
      replace: true,
    });

    expect(p.personalization).toMatchObject({
      set: ['callMe', 'tone'],
      kept: [],
    });
    const notes = loadNotes(memoryDir(target)).notes;
    expect(notes.map((note) => note.text)).not.toContain(
      'Docker needs 8 GB of memory here.'
    );
    expect(notes).toHaveLength(3);
    expect(readPersonalization(memoryDir(target))).toEqual({
      callMe: 'Sam',
      tone: 'calm',
    });
    const agents = fs.readFileSync(
      path.join(target, AGENTS_LOCAL_FILE),
      'utf-8'
    );
    expect(agents).toContain('Always run the tests twice.');
    expect(agents).toContain(CORE_START);
    expect(result.snapshot).not.toBeNull();
  });

  test('should say when the instructions are already the same', () => {
    seedSource();
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(
      path.join(source, AGENTS_LOCAL_FILE),
      path.join(target, AGENTS_LOCAL_FILE)
    );

    expect(plan().plan.instructions).toBe('same');
  });

  test('should add the core block to instructions taken over without one', () => {
    seedSource();
    const archive = readArchive(exportAll().file);
    const p = planImport(target, archive, {
      include: ['personalization'],
      replace: false,
    });

    applyImport(target, archive, p, { now: NOW, detail: 'x' });

    const agents = fs.readFileSync(
      path.join(target, AGENTS_LOCAL_FILE),
      'utf-8'
    );
    expect(agents).toContain('Always run the tests twice.');
    expect(agents).toMatch(
      /<!-- Your own instructions go here[^\n]*-->\n\n<!-- memory:start -->/
    );
  });

  test('should refuse imported instructions with markers or secrets', () => {
    const marked = readArchive(
      craft([
        { path: 'personalization/instructions.md', data: `x ${CORE_END}` },
      ])
    );
    const secret = readArchive(
      craft([
        { path: 'personalization/instructions.md', data: `token ${TOKEN}` },
      ])
    );

    const a = planImport(target, marked, { include: null, replace: false });
    const b = planImport(target, secret, { include: null, replace: false });

    expect(a.instructions).toBeNull();
    expect(a.warnings).toEqual([
      expect.stringMatching(/instructions .*memory block markers/),
    ]);
    expect(b.warnings).toEqual([
      expect.stringMatching(/instructions .*secret/),
    ]);
  });

  test('should skip broken imported settings with a warning', () => {
    const archive = readArchive(
      craft([
        {
          path: 'personalization/personalization.json',
          data: '{"color": "red"}',
        },
      ])
    );

    const p = planImport(target, archive, { include: null, replace: false });

    expect(p.personalization).toBeNull();
    expect(p.warnings[0]).toMatch(/^Personalization skipped: /);
  });

  test('should skip broken JSON settings, and read broken local ones as empty', () => {
    initLocal(target);
    fs.writeFileSync(
      path.join(memoryDir(target), 'personalization.json'),
      '{oops'
    );
    const broken = readArchive(
      craft([{ path: 'personalization/personalization.json', data: '{oops' }])
    );
    const good = readArchive(
      craft([
        {
          path: 'personalization/personalization.json',
          data: '{"tone": "calm"}',
        },
      ])
    );

    expect(
      planImport(target, broken, { include: null, replace: false }).warnings[0]
    ).toMatch(/Personalization skipped/);
    expect(
      planImport(target, good, { include: null, replace: false })
        .personalization
    ).toMatchObject({
      set: ['tone'],
    });
  });

  test('should skip tasks and resources that exist here', () => {
    seedSource();
    write(target, 'tasks/alpha-261120/plan.md', '# mine\n');
    write(target, 'resources/img/logo.txt', 'mine\n');
    const { archive, plan: p } = plan();

    applyImport(target, archive, p, { now: NOW, detail: 'x' });

    expect(p.tasks).toEqual({ add: ['beta-261120'], skip: ['alpha-261120'] });
    expect(p.resources).toEqual({ add: [], skip: ['img/logo.txt'] });
    expect(
      fs.readFileSync(path.join(target, 'tasks/alpha-261120/plan.md'), 'utf-8')
    ).toBe('# mine\n');
    expect(
      fs.readFileSync(path.join(target, 'tasks/beta-261120/NOTES.md'), 'utf-8')
    ).toBe('notes\n');
  });

  test('should not write through a link in the target', () => {
    seedSource();
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(target, 'resources'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, 'resources', 'img'));
    const { archive, plan: p } = plan({ include: ['resources'] });

    const result = applyImport(target, archive, p, { now: NOW, detail: 'x' });

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.warnings).toEqual([
      'Skipped resources/img/logo.txt: resources/img is a link here.',
    ]);
  });

  test('should not write a task through a linked tasks folder', () => {
    seedSource();
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(target, 'tasks'));
    const { archive, plan: p } = plan({ include: ['tasks'] });

    const result = applyImport(target, archive, p, { now: NOW, detail: 'x' });

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.warnings[0]).toBe(
      'Skipped tasks/alpha-261120/plan.md: tasks is a link here.'
    );
  });

  test('should take no snapshot on --replace without the memory part', () => {
    seedSource();
    const archive = readArchive(exportAll({ parts: ['resources'] }).file);
    const p = planImport(target, archive, { include: null, replace: true });

    const result = applyImport(target, archive, p, {
      now: NOW,
      detail: 'x',
      replace: true,
    });

    expect(result.snapshot).toBeNull();
  });

  test('should only import the parts asked for, and warn about missing ones', () => {
    seedSource();
    const archive = readArchive(exportAll({ parts: ['memory'] }).file);

    const p = planImport(target, archive, {
      include: ['memory', 'tasks'],
      replace: false,
    });

    expect(p.parts).toEqual(['memory']);
    expect(p.personalization).toBeNull();
    expect(p.warnings).toEqual(['The archive has no tasks part.']);
  });

  test('should take no snapshot when nothing in the store changes', () => {
    seedSource();
    const archive = readArchive(exportAll({ parts: ['resources'] }).file);
    const p = planImport(target, archive, { include: null, replace: false });

    const result = applyImport(target, archive, p, { now: NOW, detail: 'x' });

    expect(result.snapshot).toBeNull();
    expect(fs.existsSync(memoryDir(target))).toBe(false);
  });

  test('should import an archive without a note log', () => {
    const archive = readArchive(
      craft([], { format: ARCHIVE_FORMAT, parts: ['memory'], files: {} })
    );

    expect(
      planImport(target, archive, { include: null, replace: false }).notes?.add
    ).toEqual([]);
  });

  test('should read a task without a readable state', () => {
    const archive = readArchive(
      craft([
        { path: 'tasks/gamma-261120/state.json', data: '{broken' },
        { path: 'tasks/delta-261120/state.json', data: '{"repo": 7}' },
      ])
    );

    const p = planImport(target, archive, { include: null, replace: false });

    expect(p.tasks?.add).toEqual(['gamma-261120', 'delta-261120']);
    expect(p.warnings).toEqual([]);
  });

  test('should clear the old caches on --replace', () => {
    seedSource();
    initLocal(target);
    add(target, {
      text: 'Docker needs 8 GB of memory here.',
      tags: ['docker'],
    });
    fs.mkdirSync(path.join(memoryDir(target), 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir(target), 'cache', 'usage.json'),
      '{"m1":{"hits":9}}'
    );
    const archive = readArchive(exportAll({ parts: ['memory'] }).file);
    const p = planImport(target, archive, { include: null, replace: true });

    applyImport(target, archive, p, { now: NOW, detail: 'x', replace: true });

    expect(
      fs.existsSync(path.join(memoryDir(target), 'cache', 'usage.json'))
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(memoryDir(target), LOG_FILE), 'utf-8')
    ).not.toContain('Docker');
  });
});

describe('formatImport', () => {
  const manifest = /** @type {any} */ ({
    machine: 'old-laptop',
    created: NOW.toISOString(),
  });

  test('should describe a dry run', () => {
    seedSource();
    const archive = readArchive(exportAll().file);
    const p = planImport(target, archive, { include: null, replace: false });

    const lines = formatImport({
      file: 'export.tar.gz',
      manifest: archive.manifest,
      plan: p,
      result: null,
    });

    expect(lines).toEqual([
      'Dry run: import of export.tar.gz (from old-laptop, 2026-11-20 14:03); nothing was changed.',
      '  Notes: 3 would be added (machine and repo notes start unchecked)',
      '  Personalization: would set callMe, tone',
      '  Instructions: would set from the archive',
      '  Tasks: would add alpha-261120, beta-261120',
      '  Resources: 1 file would be added',
      '  Warning: Task alpha-261120 works in /nowhere/repo, which does not exist here.',
    ]);
  });

  test('should describe an import with skips and a snapshot', () => {
    const lines = formatImport({
      file: 'e.tar.gz',
      manifest,
      plan: /** @type {any} */ ({
        parts: ALL,
        warnings: [],
        notes: { add: [{}], duplicates: 2, refused: 1, invalid: ['m4: bad'] },
        personalization: { set: [], kept: ['callMe'] },
        instructions: 'kept',
        tasks: { add: ['beta'], skip: ['alpha'] },
        resources: { add: ['a', 'b'], skip: ['c'] },
      }),
      result: { added: 1, snapshot: '20261120-140300-import', warnings: ['w'] },
    });

    expect(lines).toEqual([
      'Imported e.tar.gz (from old-laptop, 2026-11-20 14:03).',
      '  Notes: 1 added (machine and repo notes start unchecked); 2 already here; 1 refused (it held a secret); skipped m4: bad',
      '  Personalization: kept callMe (yours; --replace overwrites)',
      '  Instructions: kept yours (--replace overwrites)',
      '  Tasks: added beta; skipped alpha (already here)',
      '  Resources: 2 files added; 1 skipped (already here)',
      '  Warning: w',
      '  Snapshot: memory/snapshots/20261120-140300-import (pnpm memory undo restores it)',
    ]);
  });

  test('should leave out parts that were not imported', () => {
    const lines = formatImport({
      file: 'e.tar.gz',
      manifest,
      plan: /** @type {any} */ ({
        parts: ['personalization'],
        warnings: [],
        notes: null,
        personalization: { set: ['tone'], kept: [] },
        instructions: 'same',
        tasks: null,
        resources: null,
      }),
      result: { added: 0, snapshot: null, warnings: [] },
    });

    expect(lines).toEqual([
      'Imported e.tar.gz (from old-laptop, 2026-11-20 14:03).',
      '  Personalization: set tone',
      '  Instructions: already the same',
    ]);
  });

  test('should show only the notes of a memory-only import', () => {
    const lines = formatImport({
      file: 'e.tar.gz',
      manifest,
      plan: /** @type {any} */ ({
        parts: ['memory'],
        warnings: [],
        notes: { add: [{}, {}], duplicates: 0, refused: 0, invalid: [] },
        personalization: null,
        instructions: null,
        tasks: null,
        resources: null,
      }),
      result: { added: 2, snapshot: null, warnings: [] },
    });

    expect(lines).toEqual([
      'Imported e.tar.gz (from old-laptop, 2026-11-20 14:03).',
      '  Notes: 2 added (machine and repo notes start unchecked)',
    ]);
  });

  test('should say when a part brought nothing', () => {
    const lines = formatImport({
      file: 'e.tar.gz',
      manifest: /** @type {any} */ ({ machine: 7, created: 'later' }),
      plan: /** @type {any} */ ({
        parts: ALL,
        warnings: [],
        notes: { add: [], duplicates: 0, refused: 2, invalid: [] },
        personalization: { set: [], kept: [] },
        instructions: null,
        tasks: { add: [], skip: [] },
        resources: { add: [], skip: [] },
      }),
      result: { added: 0, snapshot: null, warnings: [] },
    });

    expect(lines).toEqual([
      'Imported e.tar.gz (from an unknown machine, later).',
      '  Notes: none added; 2 refused (they held a secret)',
      '  Personalization: nothing to set',
      '  Tasks: none',
      '  Resources: none',
    ]);
  });
});
