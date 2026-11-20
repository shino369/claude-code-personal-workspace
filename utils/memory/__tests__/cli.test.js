/**
 * Tests for utils/memory/cli.js (`pnpm memory`)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { createState } from '../../task/state.js';
import { saveState, tasksRoot, writeActive } from '../../task/store.js';
import { HELP, defaultDeps, main, parseArgs } from '../cli.js';
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
} from '../config.js';
import { PERSONALIZATION_FILE, readPersonalization } from '../personalize.js';
import {
  appendInbox,
  appendJournal,
  readInbox,
  readOpen,
  readQueue,
  registerOpen,
  tryLock,
  enqueue,
} from '../queue.js';
import { INDEX_CACHE_FILE } from '../recall.js';
import { mainCheckout } from '../repo.js';
import { ROOT_DIR } from '../../workspace-config.js';
import { AGENTS_LOCAL_FILE, CLAUDE_LOCAL_FILE } from '../render.js';
import {
  CACHE_DIR,
  LOG_FILE,
  USAGE_FILE,
  addNote,
  deleteNote,
  loadNotes,
  memoryDir,
  setPinned,
} from '../store.js';

/** @type {string} */
let tmp;
/** @type {string} */
let root;
/** @type {string} */
let dir;
/** @type {string[]} */
let logs;

const NOW = new Date(2026, 10, 20, 14, 3);
const DAY = NOW.toISOString().slice(0, 10);
const ENV = { TASK_AGENT: 'claude', TASK_SESSION: 'sess-1' };
const TASK = 'demo-261120';
const SECRET = `ghp_${'a1B2'.repeat(8)}`;

/**
 * A git checkout at `folder` whose origin is `me/<name>`.
 *
 * @param {string} folder
 * @param {string} name
 */
function gitCheckout(folder, name) {
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.git', 'config'),
    `[remote "origin"]\n\turl = git@github.com:me/${name}.git\n`
  );
  return folder;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-cli-')));
  root = gitCheckout(path.join(tmp, 'ws'), 'workspace');
  dir = memoryDir(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {string[]} argv
 * @param {Partial<import('../cli.js').Deps>} [deps]
 */
function run(argv, deps = {}) {
  logs = [];
  const code = main({
    argv,
    deps: {
      rootDir: root,
      cwd: root,
      env: ENV,
      now: () => NOW,
      log: (message) => logs.push(message),
      ...deps,
    },
  });
  return { code, out: logs.join('\n') };
}

/** @param {string[]} argv */
const runJson = (argv) => JSON.parse(run([...argv, '--json']).out);

const notes = () => loadNotes(dir).notes;
const read = (/** @type {string} */ file) =>
  fs.readFileSync(path.join(root, file), 'utf-8');

/**
 * @param {Partial<import('../store.js').NoteInput>} [over]
 */
const save = (over = {}) =>
  addNote(
    dir,
    {
      text: 'Merge by fast-forwarding main and git push.',
      scope: 'machine',
      type: 'howto',
      tags: ['merge', 'pull request', 'PR'],
      ...over,
    },
    { now: NOW }
  ).note;

/** Tags two notes share, so recall needs both words to tell them apart. */
const SHARED = ['merge', 'squash'];

/**
 * Unrelated notes: a store of a few notes would make every word rare.
 */
function fillers() {
  for (const word of [
    'tea',
    'bikes',
    'plants',
    'music',
    'chess',
    'hiking',
    'cooking',
    'jazz',
  ]) {
    save({
      scope: 'user',
      type: 'preference',
      text: `Likes ${word} on weekends.`,
      tags: [word],
    });
  }
}

/** Make `repo` (absolute, or null) the active task's repository. */
function activeTask(repo = /** @type {string | null} */ (null)) {
  const taskDir = path.join(tasksRoot(root), TASK);
  fs.mkdirSync(taskDir, { recursive: true });
  saveState(
    taskDir,
    createState({ name: TASK, goal: 'Demo.', repo, now: NOW })
  );
  writeActive(root, TASK);
}

describe('parseArgs', () => {
  test('should collect positionals, values, and booleans', () => {
    const options = parseArgs(['add', 'Some text', '--scope', 'user', '--pin']);

    expect(options).toMatchObject({
      positionals: ['add', 'Some text'],
      scope: 'user',
      pin: true,
    });
  });

  test('should accept --flag=value and repeat --trigger', () => {
    const options = parseArgs([
      '--type=fact',
      '--trigger',
      'gh pr',
      '--trigger=git push',
    ]);

    expect(options).toMatchObject({
      type: 'fact',
      triggers: ['gh pr', 'git push'],
    });
  });

  test('should read -m as the message', () => {
    expect(parseArgs(['rm', 'm1', '-m', 'wrong']).message).toBe('wrong');
  });

  test('should refuse an unknown option', () => {
    expect(() => parseArgs(['--colour'])).toThrow(
      'Unknown option: --colour (see pnpm memory help)'
    );
  });

  test('should refuse a value flag without a value', () => {
    expect(() => parseArgs(['add', '--scope'])).toThrow(
      '--scope needs a value'
    );
  });
});

describe('defaultDeps', () => {
  test('should take the command folder from INIT_CWD', () => {
    expect(defaultDeps({ env: { INIT_CWD: '/somewhere' } }).cwd).toBe(
      '/somewhere'
    );
  });

  test('should fall back to the process folder', () => {
    expect(defaultDeps({ env: {} }).cwd).toBe(process.cwd());
  });

  test('should use the main checkout, so worktrees share one store', () => {
    expect(defaultDeps({ env: {} }).rootDir).toBe(mainCheckout(ROOT_DIR));
  });

  test('should take the time from the clock', () => {
    const before = Date.now();

    expect(defaultDeps({ env: {} }).now().getTime()).toBeGreaterThanOrEqual(
      before
    );
  });

  test('should keep overrides', () => {
    expect(defaultDeps({ rootDir: root, cwd: tmp })).toMatchObject({
      rootDir: root,
      cwd: tmp,
    });
  });
});

describe('main', () => {
  test('should print the help', () => {
    expect(run(['help']).out).toBe(HELP);
  });

  test('should print the help for --help after any command', () => {
    expect(run(['add', '--help']).out).toBe(HELP);
  });

  test('should refuse an unknown command', () => {
    expect(() => run(['nope'])).toThrow(
      'Unknown command "nope". Run: pnpm memory help'
    );
  });
});

describe('extract', () => {
  const SESSION = 'sess-9';
  /** @type {string} */
  let transcript;

  beforeEach(() => {
    run(['init']);
    transcript = path.join(tmp, `${SESSION}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        {
          type: 'user',
          origin: { kind: 'human' },
          cwd: root,
          message: {
            content:
              'Always answer me in English, even when I write in Japanese. I read English faster than Japanese for technical work.',
          },
        },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'Understood: I will answer in English from now on, whatever language your message is in.',
              },
            ],
          },
        },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join('')
    );
  });

  const entry = () => ({
    session: SESSION,
    harness: 'claude',
    transcript,
    cwd: root,
    at: NOW.toISOString(),
  });

  /** @param {unknown} answer */
  const agent = (answer) =>
    vi.fn(() => {
      const stdout = JSON.stringify(answer);
      return { code: 0, signal: null, stdout, output: stdout, durationMs: 3 };
    });

  const ADD = {
    op: 'ADD',
    scope: 'user',
    type: 'preference',
    text: 'The user wants answers in English, even to Japanese messages.',
    tags: ['language', 'English', '英語'],
  };

  test('should extract the queued sessions and announce each save', () => {
    enqueue(dir, entry());
    const runAgent = agent({ ops: [ADD] });

    const { code, out } = run(['extract'], { runAgent });

    expect(code).toBe(0);
    expect(out).toBe(
      'Extracted sess-9:\n  Saved to memory: m1 (user, preference) The user wants answers in English, even to Japanese messages.'
    );
    expect(readQueue(dir)).toEqual([]);
    expect(read(AGENTS_LOCAL_FILE)).toBeDefined();
  });

  test('should say when the queue is empty', () => {
    expect(run(['extract'], { runAgent: agent({ ops: [] }) }).out).toBe(
      'Nothing to extract: the queue is empty.'
    );
  });

  test('should exit 1 when an extraction failed', () => {
    enqueue(dir, entry());
    const runAgent = vi.fn(() => ({
      code: 2,
      signal: null,
      stdout: '',
      output: 'not logged in',
      durationMs: 1,
    }));

    const { code, out } = run(['extract'], { runAgent });

    expect(code).toBe(1);
    expect(out).toMatch(/^Failed sess-9 \(attempt 1 of 3; .*not logged in$/);
  });

  test('should leave the queue to a worker that is already running', () => {
    enqueue(dir, entry());
    const lock = tryLock(dir);

    const { code, out } = run(['extract'], { runAgent: agent({ ops: [] }) });

    expect(code).toBe(0);
    expect(out).toBe(
      'An extraction is already running; it will take the queue.'
    );
    lock?.release();
  });

  test('should extract an open session by id and keep it open', () => {
    registerOpen(dir, entry());
    const runAgent = agent({ ops: [] });

    const { out } = run(['extract', SESSION], { runAgent });

    expect(out).toBe('Extracted sess-9: nothing new to remember.');
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(readOpen(dir).map((item) => item.session)).toEqual([SESSION]);
  });

  test('should extract a queued session by id', () => {
    enqueue(dir, { ...entry(), session: 'other' });
    enqueue(dir, entry());
    const runAgent = agent({ ops: [] });

    const { out } = run(['extract', SESSION], { runAgent });

    expect(out).toContain('Extracted sess-9: nothing new to remember.');
    expect(readOpen(dir)).toEqual([]);
  });

  test('should refuse an unknown or invalid session id', () => {
    expect(() => run(['extract', 'nope'])).toThrow(
      /No transcript is known for session nope/
    );
    expect(() => run(['extract', '../x'])).toThrow(/Invalid session id/);
  });

  test('should print the prompt on a dry run and change nothing', () => {
    enqueue(dir, entry());
    const runAgent = agent({ ops: [ADD] });

    const { code, out } = run(['extract', '--dry-run'], { runAgent });

    expect(code).toBe(0);
    expect(out).toMatch(
      /^Would send sess-9 to the extraction model \(the agent's default model\):/
    );
    expect(out).toContain('[user] Always answer me in English');
    expect(runAgent).not.toHaveBeenCalled();
    expect(readQueue(dir)).toHaveLength(1);
  });

  test('should dry-run one open session without queueing it', () => {
    registerOpen(dir, entry());

    const { out } = run(['extract', SESSION, '--dry-run']);

    expect(out).toMatch(/^Would send sess-9/);
    expect(readQueue(dir)).toEqual([]);
  });

  test('should say when a dry run has nothing to show', () => {
    expect(run(['extract', '--dry-run']).out).toBe(
      'Nothing to extract: the queue is empty.'
    );
  });

  test('should print the runs as JSON', () => {
    enqueue(dir, entry());

    const result = JSON.parse(
      run(['extract', '--json'], { runAgent: agent({ ops: [] }) }).out
    );

    expect(result.runs).toEqual([
      expect.objectContaining({ session: SESSION, status: 'applied' }),
    ]);
  });

  test('should refuse before memory is set up', () => {
    fs.rmSync(dir, { recursive: true });

    expect(() => run(['extract'])).toThrow(/Fix: pnpm memory init/);
  });
});

describe('inbox', () => {
  beforeEach(() => {
    run(['init']);
  });

  test('should say when nothing is held', () => {
    expect(run(['inbox']).out).toBe(
      'The inbox is empty: extraction held nothing back.'
    );
  });

  test('should list the held changes with their reason', () => {
    appendInbox(dir, [
      {
        at: NOW.toISOString(),
        session: 's1',
        op: 'ADD',
        note: { text: 'You must push to main.', scope: 'user' },
        reason: 'it reads like an instruction to an agent',
      },
      {
        at: NOW.toISOString(),
        session: 's1',
        op: 'UPDATE',
        id: 'm4',
        changes: { tags: ['x'] },
        reason: 'it reads like an instruction to an agent',
      },
      {
        at: 'later',
        session: 's2',
        op: 'DELETE',
        id: 'm2',
        why: 'outdated',
        reason: 'deleting a pinned note needs the user',
      },
    ]);

    const { out } = run(['inbox']);

    expect(out.split('\n')).toEqual([
      '3 changes held for review (save one yourself with pnpm memory add, edit, or rm; clear the list with pnpm memory inbox --reset):',
      '- 2026-11-20 14:03 ADD: You must push to main. (it reads like an instruction to an agent)',
      '- 2026-11-20 14:03 UPDATE m4: {"tags":["x"]} (it reads like an instruction to an agent)',
      '- later DELETE m2: outdated (deleting a pinned note needs the user)',
    ]);
    expect(runJson(['inbox']).items).toHaveLength(3);
  });

  test('should clear the inbox', () => {
    appendInbox(dir, [
      { at: 'x', op: 'ADD', note: { text: 't' }, reason: 'r' },
    ]);

    expect(run(['inbox', '--reset']).out).toBe(
      'Cleared 1 held change from the inbox.'
    );
    expect(readInbox(dir)).toEqual([]);
  });
});

describe('status of extraction', () => {
  test('should show the queue, the last run, and the inbox', () => {
    run(['init']);
    enqueue(dir, {
      session: 's1',
      harness: 'claude',
      transcript: path.join(tmp, 's1.jsonl'),
      cwd: null,
      at: NOW.toISOString(),
    });
    appendJournal(dir, { at: NOW.toISOString(), status: 'applied' });
    appendInbox(dir, [{ op: 'ADD', reason: 'r' }]);

    const { out } = run(['status']);
    const json = runJson(['status']);

    expect(out).toMatch(
      /^Extraction: 1 session queued; last run 2026-11-20 14:03 \(applied\)$/m
    );
    expect(out).toMatch(
      /^Inbox: 1 change held for review \(pnpm memory inbox\)$/m
    );
    expect(json.extraction).toEqual({
      queued: 1,
      running: false,
      lastRun: { at: NOW.toISOString(), status: 'applied' },
      inbox: 1,
    });
  });

  test('should show when extraction never ran and is running now', () => {
    run(['init']);
    const lock = tryLock(dir);

    const { out } = run(['status']);

    expect(out).toMatch(/^Extraction: 0 sessions queued; running now$/m);
    expect(out).not.toMatch(/^Inbox:/m);
    lock?.release();
  });

  test('should show a run that has not happened yet', () => {
    expect(run(['status']).out).toMatch(
      /^Extraction: 0 sessions queued; no run yet$/m
    );
  });
});

describe('export and import', () => {
  /** @type {string} */
  let other;

  beforeEach(() => {
    run(['init']);
    save({
      scope: 'user',
      type: 'preference',
      text: 'Prefers design first, then review.',
    });
    save({
      text: 'The proxy blocks GitHub GraphQL; merge by fast-forwarding main.',
    });
    run(['personalize', '--call-me', 'Sam']);
    fs.mkdirSync(path.join(root, 'tasks', TASK), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', TASK, 'plan.md'), '# demo\n');
    other = gitCheckout(path.join(tmp, 'other'), 'workspace');
  });

  /** @param {string[]} argv @param {object} [deps] */
  const exportRun = (argv, deps = {}) =>
    run(['export', ...argv], { machine: 'old-laptop', ...deps });

  test('should export memory and personalization by default, named by date', () => {
    const { code, out } = exportRun([]);

    expect(code).toBe(0);
    expect(out.split('\n')[0]).toMatch(
      /^Exported memory, personalization to memory-export-261120\.tar\.gz \(2 notes, 0 tasks, 3 files, [\d.]+ (B|KB)\)\.$/
    );
    expect(fs.existsSync(path.join(root, 'memory-export-261120.tar.gz'))).toBe(
      true
    );
  });

  test('should export the parts and tasks asked for, to --out', () => {
    const out = path.join(tmp, 'all.tar.gz');

    const result = JSON.parse(
      exportRun([
        '--include',
        'memory,tasks',
        '--tasks',
        TASK,
        '--out',
        out,
        '--json',
      ]).out
    );

    expect(result.manifest).toMatchObject({
      parts: ['memory', 'tasks'],
      machine: 'old-laptop',
    });
    expect(result.file).toBe(out);
  });

  test('should refuse --tasks without the tasks part', () => {
    expect(() => exportRun(['--tasks', TASK])).toThrow(
      /--tasks needs the tasks part/
    );
  });

  test('should refuse secrets unless --allow-secrets', () => {
    fs.writeFileSync(
      path.join(root, 'tasks', TASK, 'tmp.md'),
      `token ${SECRET}\n`
    );
    const args = ['--include', 'tasks', '--out', path.join(tmp, 's.tar.gz')];

    expect(() => exportRun(args)).toThrow(/looks like it holds a secret/);
    expect(exportRun([...args, '--allow-secrets']).out).toMatch(
      /Warning: it holds possible secrets/
    );
  });

  test('should use the machine name by default', () => {
    const out = path.join(tmp, 'host.tar.gz');

    const result = JSON.parse(run(['export', '--out', out, '--json']).out);

    expect(result.manifest.machine).toBe(os.hostname());
  });

  test('should import into another checkout, and dry-run first', () => {
    const file = path.join(tmp, 'move.tar.gz');
    exportRun(['--include', 'memory,personalization,tasks', '--out', file]);

    const dry = run(['import', 'move.tar.gz', '--dry-run'], {
      rootDir: other,
      cwd: tmp,
    });
    expect(dry.out.split('\n')[0]).toMatch(
      /^Dry run: import of move\.tar\.gz \(from old-laptop, /
    );
    expect(fs.existsSync(path.join(other, 'memory'))).toBe(false);

    const real = run(['import', 'move.tar.gz'], { rootDir: other, cwd: tmp });
    expect(real.code).toBe(0);
    expect(real.out).toMatch(/^Imported move\.tar\.gz/);
    expect(real.out).toContain(
      'Notes: 2 added (machine and repo notes start unchecked)'
    );
    expect(real.out).toContain(`Tasks: added ${TASK}`);
    expect(loadNotes(memoryDir(other)).notes).toHaveLength(2);
    expect(readPersonalization(memoryDir(other))).toEqual({ callMe: 'Sam' });
  });

  test('should import only --include parts, or replace with --replace', () => {
    const file = path.join(tmp, 'move.tar.gz');
    exportRun(['--out', file]);
    run(['init'], { rootDir: other });
    addNote(memoryDir(other), {
      text: 'A note only the other checkout has.',
      scope: 'machine',
      type: 'fact',
    });

    const only = JSON.parse(
      run(['import', file, '--include', 'personalization', '--json'], {
        rootDir: other,
      }).out
    );
    expect(only.plan.parts).toEqual(['personalization']);

    const replaced = JSON.parse(
      run(['import', file, '--replace', '--json'], { rootDir: other }).out
    );
    expect(replaced.plan.notes.add).toBe(2);
    expect(replaced.result.snapshot).toMatch(/-import-2$/);
    expect(
      loadNotes(memoryDir(other)).notes.map((note) => note.text)
    ).not.toContain('A note only the other checkout has.');
  });

  test('should refuse an import without a file', () => {
    expect(() => run(['import'])).toThrow(/Name the archive/);
  });

  test('should refuse a bad archive', () => {
    const file = path.join(tmp, 'bad.tar.gz');
    fs.writeFileSync(file, 'nope');

    expect(() => run(['import', file])).toThrow(
      /^Refused: The file is not a gzip archive/
    );
  });
});

describe('status', () => {
  test('should be the default command', () => {
    expect(run([]).out).toBe(run(['status']).out);
  });

  test('should say what is missing in a fresh checkout', () => {
    const { out, code } = run(['status']);

    expect(code).toBe(0);
    expect(out).toMatch(/^Memory: no notes yet\./);
    expect(out).toMatch(
      /Not set up: memory\/, AGENTS\.local\.md, CLAUDE\.local\.md\. Fix: pnpm memory init/
    );
  });

  test('should count notes by scope, pinned, stale, and deleted', () => {
    run(['init']);
    setPinned(
      dir,
      save({ scope: 'user', type: 'preference', text: 'Prefers design first.' })
        .id,
      true
    );
    save({ text: 'The proxy blocks GraphQL.', type: 'fact', unchecked: true });
    save({ scope: 'repo', repo: 'web', text: 'Deploys run on tags.' });
    deleteNote(dir, save({ text: 'Old wrong fact about builds.' }).id, 'wrong');

    const { out } = run(['status']);

    expect(out.split('\n')[0]).toBe(
      'Memory: 3 notes (user 1, machine 1, repo 1); 1 pinned; 1 stale; 1 deleted'
    );
    expect(out).toMatch(
      /^Core block: \d+\/3000 characters \(AGENTS\.local\.md\)$/m
    );
    expect(out).not.toMatch(/Not set up/);
  });

  test('should show personalization, saving, and the extraction model', () => {
    run(['init']);
    run(['personalize', '--call-me', 'Sam', '--tone', 'calm']);
    writeConfig(dir, {
      ...DEFAULT_CONFIG,
      off: true,
      extractModel: 'small-model',
    });

    const { out } = run(['status']);

    expect(out).toMatch(/^Personalization: callMe, tone$/m);
    expect(out).toMatch(/^Saving: off everywhere \(pnpm memory on\)$/m);
    expect(out).toMatch(/^Extraction model: small-model$/m);
  });

  test('should show the defaults', () => {
    const { out } = run(['status']);

    expect(out).toMatch(
      /^Personalization: not set \(pnpm memory personalize --presets\)$/m
    );
    expect(out).toMatch(/^Saving: on$/m);
    expect(out).toMatch(/^Extraction model: the main session's model$/m);
  });

  test('should show a session that is off', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, offSessions: ['sess-1'] });

    expect(run(['status']).out).toMatch(
      /^Saving: off for this session \(pnpm memory on\)$/m
    );
  });

  test('should warn about bad log lines and a broken config', () => {
    save();
    fs.appendFileSync(path.join(dir, LOG_FILE), '{broken\n');
    fs.writeFileSync(path.join(dir, CONFIG_FILE), '{oops');

    const { out } = run(['status']);

    expect(out).toMatch(/^Warning: the log has 1 bad line: line 2: not JSON$/m);
    expect(out).toMatch(/^Warning: memory\/config\.json is not valid JSON/m);
    expect(out).toMatch(/^Saving: on$/m);
  });

  test('should pass on the core block warnings', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, budget: 1000 });
    for (let i = 0; i < 8; i++) {
      setPinned(
        dir,
        save({ text: `Pinned fact ${i} ${'about the build '.repeat(10)}` }).id,
        true
      );
    }

    expect(run(['status']).out).toMatch(
      /^Warning: The core block is over 1000 characters/m
    );
  });

  test('should report as JSON', () => {
    save();

    const status = runJson(['status']);

    expect(status).toMatchObject({
      notes: {
        active: 1,
        scopes: { user: 0, machine: 1, repo: 0 },
        pinned: 0,
        stale: 0,
        deleted: 0,
      },
      core: { budget: 3000 },
      personalization: [],
      saving: 'on',
      extractModel: null,
      missing: ['AGENTS.local.md', 'CLAUDE.local.md'],
      warnings: [],
    });
    expect(status.core.chars).toBeGreaterThan(0);
  });
});

describe('init', () => {
  test('should create the local files', () => {
    const { out } = run(['init']);

    expect(out).toBe('Created: memory/, AGENTS.local.md, CLAUDE.local.md');
    expect(read(CLAUDE_LOCAL_FILE)).toBe('@AGENTS.local.md\n');
  });

  test('should say when there is nothing to do', () => {
    run(['init']);

    expect(run(['init']).out).toBe('Memory is set up; nothing to change.');
  });

  test('should list updated files and warnings', () => {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), 'Mine.\n');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, PERSONALIZATION_FILE), '{nope');

    const { out } = run(['init']);

    expect(out).toMatch(/^Created: AGENTS\.local\.md$/m);
    expect(out).toMatch(/^Updated: CLAUDE\.local\.md$/m);
    expect(out).toMatch(
      /^Warning: memory\/personalization\.json is not valid JSON/m
    );
  });

  test('should report as JSON', () => {
    expect(runJson(['init'])).toEqual({
      created: ['memory/', 'AGENTS.local.md', 'CLAUDE.local.md'],
      updated: [],
      warnings: [],
    });
  });
});

describe('add', () => {
  const ADD = [
    'add',
    'Merge by fast-forwarding main.',
    '--scope',
    'machine',
    '--type',
    'howto',
  ];

  test('should save the note and announce it', () => {
    const { out, code } = run([
      ...ADD,
      '--tags',
      'git, merge,,PR',
      '--trigger',
      'gh pr merge',
    ]);

    expect(code).toBe(0);
    expect(out).toBe(
      'Saved to memory: m1 (machine, howto) Merge by fast-forwarding main.'
    );
    expect(notes()[0]).toMatchObject({
      text: 'Merge by fast-forwarding main.',
      tags: ['git', 'merge', 'PR'],
      triggers: ['gh pr merge'],
      source: { via: 'agent', harness: 'claude', session: 'sess-1' },
    });
  });

  test('should split tags on Japanese and full-width commas', () => {
    run([...ADD, '--tags', 'マージ、プルリク，merge']);

    expect(notes()[0].tags).toEqual(['マージ', 'プルリク', 'merge']);
  });

  test('should join words that were not quoted', () => {
    run([
      'add',
      'Prefers',
      'design',
      'first.',
      '--scope',
      'user',
      '--type',
      'preference',
    ]);

    expect(notes()[0].text).toBe('Prefers design first.');
  });

  test('should record the current task as the source', () => {
    activeTask();

    run(ADD);

    expect(notes()[0].source.task).toBe(TASK);
  });

  test('should record the user as the source outside an agent', () => {
    run(ADD, { env: {} });

    expect(notes()[0].source).toEqual({ via: 'user' });
  });

  test('should detect Claude Code without TASK_AGENT', () => {
    run(ADD, { env: { CLAUDECODE: '1' } });

    expect(notes()[0].source).toEqual({ via: 'agent', harness: 'claude' });
  });

  test('should refresh the core block and the search index', () => {
    run([...ADD, '--pin']);

    expect(notes()[0].pinned).toBe(true);
    expect(read(AGENTS_LOCAL_FILE)).toMatch(
      /- m1 \(machine, howto\) Merge by fast-forwarding main\./
    );
    expect(fs.existsSync(path.join(dir, CACHE_DIR, INDEX_CACHE_FILE))).toBe(
      true
    );
  });

  test('should announce a merge into a similar note', () => {
    run([...ADD, '--tags', 'git']);

    const { out } = run([
      'add',
      'Merge by fast-forwarding main!',
      '--scope',
      'machine',
      '--type',
      'howto',
      '--tags',
      'merge',
    ]);

    expect(out).toBe(
      'Updated memory: m1 (merged into a similar note) Merge by fast-forwarding main!'
    );
  });

  test('should say when the note is already saved', () => {
    run(ADD);

    expect(run(ADD).out).toBe(
      'Already in memory: m1 Merge by fast-forwarding main.'
    );
  });

  test('should shorten a long note in the announcement', () => {
    const { out } = run([
      'add',
      `Remember ${'this detail '.repeat(20)}`,
      '--scope',
      'user',
      '--type',
      'fact',
    ]);

    expect(out).toMatch(
      /^Saved to memory: m1 \(user, fact\) Remember this detail .{80,}…$/
    );
    expect(out.length).toBeLessThan(160);
  });

  test('should default a repo note to the current repository', () => {
    run(['add', 'Deploys run on tags.', '--scope', 'repo', '--type', 'fact']);

    expect(notes()[0].repo).toBe('workspace');
  });

  test('should default a repo note to the task repository', () => {
    activeTask(gitCheckout(path.join(tmp, 'web-checkout'), 'web'));

    run(['add', 'Deploys run on tags.', '--scope', 'repo', '--type', 'fact']);

    expect(notes()[0].repo).toBe('web');
  });

  test('should default a repo note to the folder when the task has no repo', () => {
    activeTask();

    run(['add', 'Deploys run on tags.', '--scope', 'repo', '--type', 'fact']);

    expect(notes()[0].repo).toBe('workspace');
  });

  test('should fall back to the folder when the task state is broken', () => {
    activeTask();
    fs.writeFileSync(path.join(tasksRoot(root), TASK, 'state.json'), '{broken');

    run(['add', 'Deploys run on tags.', '--scope', 'repo', '--type', 'fact']);

    expect(notes()[0].repo).toBe('workspace');
  });

  test('should name the repository of a --repo path', () => {
    gitCheckout(path.join(tmp, 'api-checkout'), 'api');

    run([
      'add',
      'Uses pnpm.',
      '--scope',
      'repo',
      '--type',
      'fact',
      '--repo',
      '../api-checkout',
    ]);

    expect(notes()[0].repo).toBe('api');
  });

  test('should take a --repo name as it is', () => {
    run([
      'add',
      'Uses pnpm.',
      '--scope',
      'repo',
      '--type',
      'fact',
      '--repo',
      'docs',
    ]);

    expect(notes()[0].repo).toBe('docs');
  });

  test('should refuse a --repo path that is not a folder', () => {
    expect(() =>
      run([
        'add',
        'Uses pnpm.',
        '--scope',
        'repo',
        '--type',
        'fact',
        '--repo',
        './missing',
      ])
    ).toThrow(/--repo \.\/missing: no such folder/);
  });

  test('should refuse a --repo folder outside git', () => {
    fs.mkdirSync(path.join(tmp, 'plain'));
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'a', 'b'));

    expect(() =>
      run(
        [
          'add',
          'Uses pnpm.',
          '--scope',
          'repo',
          '--type',
          'fact',
          '--repo',
          '~/../../plain',
        ],
        { cwd: tmp }
      )
    ).toThrow(
      /--repo ~\/\.\.\/\.\.\/plain: .*plain is not in a git repository/
    );
  });

  test('should refuse a repo note outside a repository', () => {
    fs.mkdirSync(path.join(tmp, 'plain'));

    expect(() =>
      run(['add', 'Uses pnpm.', '--scope', 'repo', '--type', 'fact'], {
        cwd: path.join(tmp, 'plain'),
      })
    ).toThrow(
      /Not in a git repository, so the repo is unknown\.\nFix: add --repo <name>/
    );
  });

  test('should refuse an empty note', () => {
    expect(() => run(['add', '--scope', 'user', '--type', 'fact'])).toThrow(
      /Give the note text: pnpm memory add "<text>"/
    );
  });

  test('should require the scope', () => {
    expect(() => run(['add', 'Text.', '--type', 'fact'])).toThrow(
      '--scope is required: user, machine, or repo.'
    );
  });

  test('should require the type', () => {
    expect(() => run(['add', 'Text.', '--scope', 'user'])).toThrow(
      '--type is required: preference, fact, howto, or episode.'
    );
  });

  test('should refuse a secret and save nothing', () => {
    expect(() =>
      run([
        'add',
        `The token is ${SECRET}`,
        '--scope',
        'machine',
        '--type',
        'fact',
      ])
    ).toThrow(
      /Refused: the note looks like it holds a secret \(github-token\)/
    );
    expect(fs.existsSync(path.join(dir, LOG_FILE))).toBe(false);
  });

  test('should refuse while saving is off everywhere', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });

    expect(() => run(ADD)).toThrow(
      /^Saving to memory is off everywhere, so nothing was saved\.\nFix: pnpm memory on — or add --force if the user asked to save this$/
    );
    expect(notes()).toEqual([]);
  });

  test('should refuse while saving is off for this session', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, offSessions: ['sess-1'] });

    expect(() => run(ADD)).toThrow(/^Saving to memory is off for this session/);
  });

  test('should save while off with --force', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });

    run([...ADD, '--force']);

    expect(notes()).toHaveLength(1);
  });

  test('should save and warn when the core block cannot be written', () => {
    fs.writeFileSync(
      path.join(root, AGENTS_LOCAL_FILE),
      '<!-- memory:start -->\n'
    );

    const { out } = run(ADD);

    expect(notes()).toHaveLength(1);
    expect(out).toMatch(
      /^Warning: The memory block in AGENTS\.local\.md is broken/m
    );
  });

  test('should rethrow unexpected errors from the refresh', () => {
    fs.mkdirSync(path.join(root, AGENTS_LOCAL_FILE));

    expect(() => run(ADD)).toThrow(/EISDIR/);
  });

  test('should report as JSON', () => {
    const result = runJson(ADD);

    expect(result).toMatchObject({
      action: 'added',
      note: { id: 'm1' },
      warnings: [],
    });
  });
});

describe('recall', () => {
  test('should print matching notes with labels and full text', () => {
    save();
    save({
      scope: 'user',
      type: 'preference',
      text: 'Prefers tea over coffee.',
      tags: ['drink'],
    });

    const { out } = run(['recall', 'how do I merge this PR']);

    expect(out).toBe(
      `- m1 (machine, howto, ${DAY}) Merge by fast-forwarding main and git push.`
    );
  });

  test('should say when nothing matches', () => {
    save();

    expect(run(['recall', 'weather', 'tomorrow']).out).toBe(
      'No notes match "weather tomorrow".'
    );
  });

  test('should need a query', () => {
    expect(() => run(['recall'])).toThrow(
      'Give a query: pnpm memory recall "<query>"'
    );
  });

  test('should keep to one scope with --scope', () => {
    save({ text: 'Merge alpha notes.', tags: SHARED });
    save({ scope: 'user', text: 'Merge gamma notes.', tags: SHARED });
    fillers();

    const all = run(['recall', 'merge squash']).out;
    const { out } = run(['recall', 'merge squash', '--scope', 'user']);

    expect(all).toMatch(/^- m1 /m);
    expect(out).toMatch(/^- m2 \(user/);
    expect(out).not.toMatch(/m1/);
  });

  test('should refuse an unknown scope', () => {
    expect(() => run(['recall', 'merge', '--scope', 'team'])).toThrow(
      'Unknown scope "team"; use one of: user, machine, repo.'
    );
  });

  test('should limit the results', () => {
    save({ text: 'Merge alpha notes.', tags: SHARED });
    save({ text: 'Merge gamma notes.', tags: SHARED });
    fillers();

    const all = run(['recall', 'merge squash']).out.split('\n');
    const limited = run(['recall', 'merge squash', '--limit', '1']).out.split(
      '\n'
    );

    expect(all).toHaveLength(2);
    expect(limited).toEqual([all[0]]);
  });

  test.each(['0', '21', 'x'])('should refuse --limit %s', (limit) => {
    expect(() => run(['recall', 'merge', '--limit', limit])).toThrow(
      '--limit must be a whole number from 1 to 20.'
    );
  });

  test('should rank machine notes higher for a failure', () => {
    save({
      scope: 'user',
      type: 'fact',
      text: 'Merge alpha notes.',
      tags: SHARED,
    });
    save({
      scope: 'machine',
      type: 'fact',
      text: 'Merge gamma notes.',
      tags: SHARED,
    });
    fillers();

    const plain = run(['recall', 'merge squash']).out.split('\n');
    const failure = run(['recall', 'merge squash', '--failure']).out.split(
      '\n'
    );

    expect(plain.map((line) => line.slice(0, 5))).toEqual(['- m1 ', '- m2 ']);
    expect(failure.map((line) => line.slice(0, 5))).toEqual(['- m2 ', '- m1 ']);
  });

  test('should recall repo notes in their repo only', () => {
    save({
      scope: 'repo',
      repo: 'web',
      text: 'Deploys run on tags.',
      tags: ['deploy'],
    });

    expect(run(['recall', 'deploy']).out).toMatch(/^No notes match/);
    expect(run(['recall', 'deploy', '--repo', 'web']).out).toMatch(
      /^- m1 \(repo web/
    );
  });

  test('should not count a search as a recall', () => {
    save();

    run(['recall', 'merge']);

    expect(fs.existsSync(path.join(dir, CACHE_DIR, USAGE_FILE))).toBe(false);
  });

  test('should report as JSON', () => {
    save();

    const [result] = runJson(['recall', 'merge']);

    expect(result).toMatchObject({
      id: 'm1',
      matched: ['merge'],
      note: { id: 'm1' },
    });
    expect(result.score).toBeGreaterThan(0);
  });
});

describe('list', () => {
  beforeEach(() => {
    setPinned(
      dir,
      save({ scope: 'user', type: 'preference', text: 'Prefers design first.' })
        .id,
      true
    );
    save({ text: 'The proxy blocks GraphQL.', type: 'fact', unchecked: true });
    save({
      scope: 'repo',
      repo: 'web',
      text: `Deploys run on tags ${'and more words '.repeat(10)}`,
    });
    deleteNote(
      dir,
      save({ text: 'Old wrong fact about builds.' }).id,
      'wrong',
      { now: NOW }
    );
  });

  test('should list active notes with their labels', () => {
    const lines = run(['list']).out.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      `- m1 (user, preference, ${DAY}, pinned) Prefers design first.`
    );
    expect(lines[1]).toBe(
      `- m2 (machine, fact, ${DAY}, unchecked) The proxy blocks GraphQL.`
    );
    expect(lines[2]).toMatch(
      /^- m3 \(repo web, howto, .{10}\) Deploys run on tags .{70,}…$/
    );
  });

  test('should include deleted notes with --all', () => {
    expect(run(['list', '--all']).out).toMatch(
      new RegExp(
        `^- m4 \\(machine, howto, ${DAY}, deleted ${DAY}: wrong\\) Old wrong fact`,
        'm'
      )
    );
  });

  test.each([
    [['--scope', 'user'], ['m1']],
    [['--type', 'fact'], ['m2']],
    [['--repo', 'web'], ['m3']],
    [['--pinned'], ['m1']],
    [['--stale'], ['m2']],
  ])('should filter with %j', (flags, ids) => {
    const lines = run(['list', ...flags]).out.split('\n');

    expect(lines.map((line) => line.split(' ')[1])).toEqual(ids);
  });

  test('should say when no note matches', () => {
    expect(run(['list', '--type', 'episode']).out).toBe(
      'No notes match these filters.'
    );
  });

  test('should refuse an unknown type', () => {
    expect(() => run(['list', '--type', 'rumor'])).toThrow(
      'Unknown type "rumor"; use one of: preference, fact, howto, episode.'
    );
  });

  test('should report as JSON', () => {
    expect(
      runJson(['list', '--pinned']).map((/** @type {any} */ n) => n.id)
    ).toEqual(['m1']);
  });
});

test('list should explain how to save the first note', () => {
  expect(run(['list']).out).toBe(
    'No notes yet. Save one: pnpm memory add "<text>" --scope user|machine|repo --type preference|fact|howto|episode'
  );
});

describe('show', () => {
  test('should print the note, its source, dates, and history', () => {
    save({ triggers: ['gh pr merge'] });
    activeTask();
    run(['pin', 'm1']);

    const lines = run(['show', 'm1']).out.split('\n');

    expect(lines).toEqual([
      `m1 (machine, howto, ${DAY}, pinned)`,
      'Merge by fast-forwarding main and git push.',
      'Tags: merge, pull request, PR',
      'Triggers: gh pr merge',
      'Source: agent',
      `Created ${DAY}, updated ${DAY}, checked ${DAY}`,
      'History:',
      '- 2026-11-20 14:03 add m1 (machine, howto): Merge by fast-forwarding main and git push.',
      '- 2026-11-20 14:03 pin m1',
    ]);
  });

  test('should show the harness, session, and task of the source', () => {
    activeTask();
    run(['add', 'Uses pnpm everywhere.', '--scope', 'user', '--type', 'fact']);

    expect(run(['show', 'm1']).out).toMatch(
      /^Source: agent, claude, session sess-1, task demo-261120$/m
    );
  });

  test('should show a deleted note with the reason', () => {
    deleteNote(dir, save().id, 'no longer true', { now: NOW });

    const { out } = run(['show', 'm1']);

    expect(out).toMatch(new RegExp(`^Deleted ${DAY}: no longer true$`, 'm'));
    expect(out).toMatch(/^- 2026-11-20 14:03 delete m1: no longer true$/m);
  });

  test('should leave out empty tags and triggers', () => {
    save({ tags: [] });

    expect(run(['show', 'm1']).out).not.toMatch(/^(Tags|Triggers):/m);
  });

  test('should show a note that was never checked', () => {
    save({ type: 'fact', unchecked: true });

    expect(run(['show', 'm1']).out).toMatch(
      new RegExp(`^Created ${DAY}, updated ${DAY}, checked never$`, 'm')
    );
  });

  test('should refuse an unknown id', () => {
    expect(() => run(['show', 'm9'])).toThrow(
      'No note m9. Run pnpm memory list to see the ids.'
    );
  });

  test('should need an id', () => {
    expect(() => run(['show'])).toThrow(
      'Give a note id: pnpm memory show <id>'
    );
  });

  test('should report as JSON', () => {
    save();

    expect(runJson(['show', 'm1'])).toMatchObject({
      note: { id: 'm1' },
      history: [{ op: 'add' }],
    });
  });
});

describe('history', () => {
  test('should list every change, oldest first, in local time', () => {
    save();
    run(['edit', 'm1', 'Merge by fast-forward only.', '--tags', 'merge']);
    run(['pin', 'm1']);
    run(['unpin', 'm1']);
    run(['check', 'm1']);
    run(['rm', 'm1', '-m', 'outdated']);

    expect(run(['history']).out.split('\n')).toEqual([
      '- 2026-11-20 14:03 add m1 (machine, howto): Merge by fast-forwarding main and git push.',
      '- 2026-11-20 14:03 update m1: text, tags',
      '- 2026-11-20 14:03 pin m1',
      '- 2026-11-20 14:03 unpin m1',
      '- 2026-11-20 14:03 check m1',
      '- 2026-11-20 14:03 delete m1: outdated',
    ]);
  });

  test('should filter with --grep, ignoring case', () => {
    save();
    save({ scope: 'user', type: 'preference', text: 'Prefers tea.', tags: [] });

    expect(run(['history', '--grep', 'TEA']).out).toBe(
      '- 2026-11-20 14:03 add m2 (user, preference): Prefers tea.'
    );
  });

  test('should show only the newest changes with --limit', () => {
    save();
    run(['pin', 'm1']);
    run(['unpin', 'm1']);

    expect(run(['history', '--limit', '1']).out.split('\n')).toEqual([
      '… 2 earlier changes (pnpm memory history --limit <n>)',
      '- 2026-11-20 14:03 unpin m1',
    ]);
  });

  test('should show an op it does not know and skip lines that are not ops', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, LOG_FILE),
      [
        '{"op":"zap","id":"m1","at":"not a time"}',
        '{"op":"check"}',
        'null',
        '{broken',
        '{"op":"add"}',
        '{"op":"update","id":"m1"}',
        '{"op":"delete","id":"m1"}',
      ].join('\n')
    );

    const { out } = run(['history']);

    expect(out.split('\n')).toEqual([
      '- not a time zap m1',
      '- ? check ?',
      '- ? add ?',
      '- ? update m1',
      '- ? delete m1',
      'Warning: the log has 2 bad lines: line 3: not an op; line 4: not JSON',
    ]);
  });

  test('should say when there are no changes', () => {
    expect(run(['history']).out).toBe('No memory changes yet.');
  });

  test('should say when nothing matches --grep', () => {
    save();

    expect(run(['history', '--grep', 'zebra']).out).toBe(
      'No changes match "zebra".'
    );
  });

  test('should refuse a bad --limit', () => {
    expect(() => run(['history', '--limit', '0'])).toThrow(
      '--limit must be a whole number from 1 to 1000.'
    );
  });

  test('should report as JSON', () => {
    save();

    expect(runJson(['history'])).toMatchObject({
      ops: [{ op: 'add' }],
      problems: [],
    });
  });
});

describe('edit', () => {
  test('should change the text and announce it', () => {
    save();

    const { out } = run(['edit', 'm1', 'Merge', 'by', 'fast-forward', 'only.']);

    expect(out).toBe('Edited m1 (machine, howto): Merge by fast-forward only.');
    expect(notes()[0].text).toBe('Merge by fast-forward only.');
  });

  test('should replace tags, triggers, and type', () => {
    save();

    run([
      'edit',
      'm1',
      '--tags',
      'git',
      '--trigger',
      'gh pr merge',
      '--type',
      'fact',
    ]);

    expect(notes()[0]).toMatchObject({
      tags: ['git'],
      triggers: ['gh pr merge'],
      type: 'fact',
    });
  });

  test('should clear the repo when the scope leaves repo', () => {
    save({ scope: 'repo', repo: 'web' });

    run(['edit', 'm1', '--scope', 'user']);

    expect(notes()[0]).toMatchObject({ scope: 'user', repo: null });
  });

  test('should set the current repository when the scope becomes repo', () => {
    save();

    run(['edit', 'm1', '--scope', 'repo']);

    expect(notes()[0]).toMatchObject({ scope: 'repo', repo: 'workspace' });
  });

  test('should move a repo note to another repo', () => {
    save({ scope: 'repo', repo: 'web' });

    run(['edit', 'm1', '--repo', 'api']);

    expect(notes()[0].repo).toBe('api');
  });

  test('should record who edited', () => {
    save();

    run(['edit', 'm1', 'New text here.']);

    expect(fs.readFileSync(path.join(dir, LOG_FILE), 'utf-8')).toMatch(
      /"op":"update".*"source":\{"via":"agent","harness":"claude","session":"sess-1"\}/
    );
  });

  test('should need something to change', () => {
    save();

    expect(() => run(['edit', 'm1'])).toThrow(
      'Nothing to change: give new text, or --tags, --trigger, --type, --scope, --repo.'
    );
  });

  test('should need an id', () => {
    expect(() => run(['edit'])).toThrow(
      'Give a note id: pnpm memory edit <id>'
    );
  });

  test('should refuse a deleted note', () => {
    deleteNote(dir, save().id, 'gone');

    expect(() => run(['edit', 'm1', 'Back.'])).toThrow('Note m1 is deleted.');
  });

  test('should report as JSON', () => {
    save();

    expect(runJson(['edit', 'm1', '--type', 'fact'])).toMatchObject({
      note: { id: 'm1', type: 'fact' },
      warnings: [],
    });
  });
});

describe('rm', () => {
  test('should delete the note with a reason', () => {
    save();

    const { out } = run(['rm', 'm1', '-m', 'no longer true']);

    expect(out).toBe(
      'Deleted m1: no longer true (kept in the journal: pnpm memory show m1)'
    );
    expect(notes()[0].status).toBe('deleted');
  });

  test('should need a reason', () => {
    save();

    expect(() => run(['rm', 'm1'])).toThrow(
      'Give a reason for deleting m1 (-m "why").'
    );
  });

  test('should report as JSON', () => {
    save();

    expect(runJson(['rm', 'm1', '-m', 'x'])).toMatchObject({
      note: { status: 'deleted' },
    });
  });
});

describe('pin, unpin, check', () => {
  test('should pin a note into the core block', () => {
    save();

    const { out } = run(['pin', 'm1']);

    expect(out).toBe('Pinned m1: every session loads it (AGENTS.local.md).');
    expect(read(AGENTS_LOCAL_FILE)).toMatch(/### Pinned\n\n- m1 /);
  });

  test('should unpin a note', () => {
    setPinned(dir, save().id, true);

    expect(run(['unpin', 'm1']).out).toBe('Unpinned m1.');
    expect(notes()[0].pinned).toBe(false);
  });

  test('should mark a note checked today', () => {
    save({ type: 'fact', unchecked: true });

    expect(run(['check', 'm1']).out).toBe('Checked m1: confirmed today.');
    expect(notes()[0].checked).toBe(DAY);
  });

  test('should point to the stale notes when check has no id', () => {
    expect(() => run(['check'])).toThrow(
      'Give a note id: pnpm memory check <id> (stale notes: pnpm memory list --stale)'
    );
  });

  test('should report as JSON', () => {
    save();

    expect(runJson(['pin', 'm1'])).toMatchObject({
      note: { pinned: true },
      warnings: [],
    });
  });
});

describe('personalize', () => {
  test('should explain how to start when nothing is set', () => {
    expect(run(['personalize']).out).toBe(
      'No personalization set. Start from a preset: pnpm memory personalize --preset <name> (list: --presets), or set fields such as --call-me "<name>".'
    );
  });

  test('should list the presets', () => {
    expect(run(['personalize', '--presets']).out).toMatch(
      /^- concise: Short answers that lead with the result\.$/m
    );
  });

  test('should copy a preset and render it into the core block', () => {
    const { out } = run(['personalize', '--preset', 'concise']);

    expect(out).toMatch(/^## Personalization/);
    expect(out).toMatch(/- Tone: Concise: lead with the answer/);
    expect(read(AGENTS_LOCAL_FILE)).toMatch(/## Personalization/);
  });

  test('should merge fields into the current settings', () => {
    run(['personalize', '--preset', 'concise']);

    run([
      'personalize',
      '--call-me',
      'Sam',
      '--traits',
      'direct, explains trade-offs',
    ]);

    expect(readPersonalization(dir)).toMatchObject({
      callMe: 'Sam',
      tone: expect.stringMatching(/^Concise/),
      traits: ['direct', 'explains trade-offs'],
    });
  });

  test('should set every text field', () => {
    run([
      'personalize',
      '--about-me',
      'Engineer.',
      '--language',
      'English',
      '--persona',
      'A calm guide.',
      '--extra',
      'Ask before big refactors.',
    ]);

    expect(readPersonalization(dir)).toEqual({
      aboutMe: 'Engineer.',
      language: 'English',
      persona: 'A calm guide.',
      extra: 'Ask before big refactors.',
    });
  });

  test('should clear a field given an empty value', () => {
    run(['personalize', '--call-me', 'Sam', '--tone', 'calm']);

    run(['personalize', '--call-me', '']);

    expect(readPersonalization(dir)).toEqual({ tone: 'calm' });
  });

  test("should use a preset's tone for --tone <preset>", () => {
    run(['personalize', '--tone', 'concise']);

    expect(readPersonalization(dir).tone).toMatch(
      /^Concise: lead with the answer/
    );
  });

  test('should keep a free-text tone', () => {
    run(['personalize', '--tone', 'Warm but brief.']);

    expect(readPersonalization(dir).tone).toBe('Warm but brief.');
  });

  test('should reset the settings', () => {
    run(['personalize', '--call-me', 'Sam']);

    expect(run(['personalize', '--reset']).out).toBe(
      'Personalization cleared.'
    );
    expect(readPersonalization(dir)).toEqual({});
    expect(read(AGENTS_LOCAL_FILE)).not.toMatch(/## Personalization/);
  });

  test('should reset and then apply the fields', () => {
    run(['personalize', '--call-me', 'Sam']);

    run(['personalize', '--reset', '--tone', 'calm']);

    expect(readPersonalization(dir)).toEqual({ tone: 'calm' });
  });

  test('should show the current settings', () => {
    run(['personalize', '--call-me', 'Sam']);

    expect(run(['personalize', '--show']).out).toMatch(
      /^- Call the user: Sam$/m
    );
  });

  test('should refuse to build on a broken settings file', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PERSONALIZATION_FILE), '{nope');

    expect(() => run(['personalize', '--call-me', 'Sam'])).toThrow(
      /not valid JSON/
    );
    expect(run(['personalize', '--reset', '--call-me', 'Sam']).out).toMatch(
      /Sam/
    );
  });

  test('should refuse a secret', () => {
    expect(() => run(['personalize', '--extra', `key ${SECRET}`])).toThrow(
      /Refused/
    );
  });

  test('should report as JSON', () => {
    expect(runJson(['personalize', '--call-me', 'Sam'])).toEqual({
      settings: { callMe: 'Sam' },
      warnings: [],
    });
  });
});

describe('set', () => {
  test('should show the settings without flags', () => {
    expect(run(['set']).out).toBe(
      "Extraction model: the main session's model\nCore budget: 3000 characters (default)"
    );
  });

  test('should set the extraction model', () => {
    expect(run(['set', '--extract-model', 'claude-haiku-5-5']).out).toMatch(
      /^Extraction model: claude-haiku-5-5$/m
    );
    expect(readConfig(dir).extractModel).toBe('claude-haiku-5-5');
  });

  test('should set the core budget and re-render', () => {
    run(['init']);

    const { out } = run(['set', '--budget', '4000']);

    expect(out).toMatch(/^Core budget: 4000 characters$/m);
    expect(readConfig(dir).budget).toBe(4000);
  });

  test('should go back to the defaults', () => {
    run(['set', '--extract-model', 'x', '--budget', '4000']);

    run(['set', '--extract-model', 'default', '--budget', 'default']);

    expect(readConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  test('should refuse a budget that is not a number', () => {
    expect(() => run(['set', '--budget', 'lots'])).toThrow(
      '--budget takes a number of characters, or default.'
    );
  });

  test('should refuse a budget out of range', () => {
    expect(() => run(['set', '--budget', '10'])).toThrow(
      /budget must be a whole number/
    );
  });

  test('should report as JSON', () => {
    expect(runJson(['set', '--budget', '5000'])).toMatchObject({
      config: { budget: 5000 },
      warnings: [],
    });
  });
});

describe('off, on', () => {
  test('should turn saving off everywhere', () => {
    expect(run(['off']).out).toBe(
      'Saving to memory is off everywhere. Recall still works. Turn it back on: pnpm memory on'
    );
    expect(readConfig(dir).off).toBe(true);
  });

  test('should turn saving off for this session', () => {
    expect(run(['off', '--session']).out).toBe(
      'Saving to memory is off for this session (sess-1). Recall still works. Turn it back on: pnpm memory on'
    );
    expect(readConfig(dir).offSessions).toEqual(['sess-1']);
  });

  test('should need a session id for --session', () => {
    expect(() => run(['off', '--session'], { env: {} })).toThrow(
      'No session id: set TASK_SESSION, or run this inside Claude Code.'
    );
  });

  test('should turn saving back on', () => {
    run(['off']);
    run(['off', '--session']);

    expect(run(['on']).out).toBe('Saving to memory is on.');
    expect(readConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  test('should say when the session is on but saving is off everywhere', () => {
    run(['off']);
    run(['off', '--session']);

    expect(run(['on', '--session']).out).toBe(
      'Saving is on for this session, but still off everywhere: pnpm memory on'
    );
    expect(readConfig(dir)).toMatchObject({ off: true, offSessions: [] });
  });

  test('should turn on only the session', () => {
    run(['off', '--session']);

    expect(run(['on', '--session']).out).toBe('Saving to memory is on.');
  });

  test('should report as JSON', () => {
    expect(runJson(['off'])).toEqual({ saving: 'off everywhere' });
  });
});
