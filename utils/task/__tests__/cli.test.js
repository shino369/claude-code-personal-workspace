import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  COMMANDS,
  HELP,
  detectAgent,
  doneBlockers,
  listTasks,
  main,
  parseArgs,
  sessionBrief,
  stateLine,
} from '../cli.js';
import {
  TEMPLATES_DIR,
  loadTask,
  readActive,
  readSession,
  tasksRoot,
  updateState,
  writeSession,
} from '../store.js';
import { FOLDER_BASE } from '../review.js';
import { DEFAULT_CONFIG, writeConfig } from '../../memory/config.js';
import { loadNotes, memoryDir } from '../../memory/store.js';

/** @type {string} */
let root;
/** @type {string[]} */
let logs;

const NOW = new Date(2026, 10, 17, 9, 30);
const GIT = { branch: 'feat/x', changed: 2, diffStat: null };
const NAME = 'demo-261117';

/**
 * @param {Array<{ command?: string, ok: boolean, output?: string }>} outcomes
 */
function fakeRunner(outcomes) {
  return vi.fn(
    /** @param {{ commands: string[], onStart?: (command: string) => void }} options */
    ({ commands, onStart }) =>
      commands.slice(0, outcomes.length).map((command, i) => {
        onStart?.(command);
        const { ok, output = '' } = outcomes[i];
        return { command, ok, code: ok ? 0 : 1, durationMs: 1, output };
      })
  );
}

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
      templatesDir: TEMPLATES_DIR,
      env: { TASK_AGENT: 'tester' },
      now: () => NOW,
      log: (message) => logs.push(message),
      git: () => GIT,
      runCommands: fakeRunner([{ ok: true }]),
      ...deps,
    },
  });
  return { code, out: logs.join('\n') };
}

const read = (/** @type {string} */ file) =>
  fs.readFileSync(path.join(tasksRoot(root), NAME, file), 'utf-8');
const state = () =>
  /** @type {import('../state.js').TaskState} */ (loadTask(root, NAME).state);

/** @param {string[]} [extra] */
const newTask = (extra = []) =>
  run([
    'new',
    'demo',
    '--goal',
    'Ship it',
    '--step',
    'One',
    '--step',
    'Two',
    ...extra,
  ]);

/** Hand-written task (no state.json). */
function legacyTask(
  name = 'old-251101',
  plan = 'Goal: Legacy\n- [x] a\n- [ ] b\n'
) {
  const dir = path.join(tasksRoot(root), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.md'), plan);
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('should collect positionals, values, repeats, and booleans', () => {
    expect(
      parseArgs([
        'new',
        'x',
        '--goal=G',
        '--step',
        'a',
        '--step',
        'b',
        '-m',
        'msg',
        '--json',
        '-h',
        '-',
      ])
    ).toMatchObject({
      positionals: ['new', 'x', '-'],
      goal: 'G',
      step: ['a', 'b'],
      message: 'msg',
      json: true,
      help: true,
    });
  });

  test('should reject a value flag without a value', () => {
    expect(() => parseArgs(['--goal'])).toThrow('--goal needs a value');
  });

  test('should reject unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option: --nope/);
  });
});

describe('detectAgent', () => {
  const base = parseArgs([]);

  test.each([
    [{ ...base, agent: 'dsh' }, { TASK_AGENT: 'x' }, 'dsh'],
    [base, { TASK_AGENT: 'codex' }, 'codex'],
    [base, { CLAUDECODE: '1' }, 'claude'],
    [base, {}, 'agent'],
  ])('should pick the agent name (%#)', (options, env, expected) => {
    expect(detectAgent(options, env)).toBe(expected);
  });
});

describe('main', () => {
  test('should print help for no command, help, and --help', () => {
    expect(run([]).out).toBe(HELP);
    expect(run(['help']).out).toBe(HELP);
    expect(run(['status', '--help']).code).toBe(0);
  });

  test('should show the optional task name on next and done', () => {
    const { out } = run(['help']);

    expect(out).toMatch(/^  next \[name\]/m);
    expect(out).toMatch(/^  done \[name\]/m);
  });

  test('should show e2e and the loop cap as independent settings', () => {
    const { out } = run(['help']);
    const settings = out.slice(
      out.indexOf('\n  set '),
      out.indexOf('\n  review ')
    );

    expect(settings).toContain('[--kind code|general] [--e2e required|no]');
    expect(settings).toContain('[--loop on|off] [--loop-max N]');
  });

  test('should reject an unknown command', () => {
    expect(() => run(['explode'])).toThrow(/Unknown command "explode"/);
  });

  test('should fall back to process argv, console, and real deps', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const argv = process.argv;
    process.argv = ['node', 'cli.js', 'help'];
    try {
      expect(main()).toBe(0);
    } finally {
      process.argv = argv;
    }
    expect(spy).toHaveBeenCalledWith(HELP);
  });

  test('should use real time, git, and commands when not injected', () => {
    const deps = { rootDir: root, log: () => {}, env: {} };
    main({
      argv: ['new', 'real', '--goal', 'G', '--verify', 'node -e "0"'],
      deps,
    });
    expect(main({ argv: ['verify'], deps })).toBe(0);
  });
});

describe('new', () => {
  test('should scaffold the task, make it active, and suggest the first step', () => {
    const { code, out } = newTask();
    expect(code).toBe(0);
    expect(out).toBe(
      `Created tasks/${NAME}/ (active task).\nNext: pnpm task step s1 start`
    );
    expect(readActive(root)).toBe(NAME);
    expect(state()).toMatchObject({
      goal: 'Ship it',
      branch: 'feat/x',
      lastAgent: 'tester',
    });
    expect(read('plan.md')).toContain('Acceptance: `pnpm check` passes');
  });

  test('should suggest adding steps when there are none', () => {
    expect(run(['new', 'demo', '--goal', 'G']).out).toContain(
      'Next: add steps'
    );
  });

  test.each([
    [['--verify', 'a'], 'Acceptance: `a` passes'],
    [['--verify', 'a', '--verify', 'b'], 'Acceptance: `a` and `b` pass'],
    [['--acceptance', 'it works'], 'Acceptance: it works'],
  ])('should derive the acceptance line from %j', (extra, expected) => {
    newTask(extra);
    expect(read('plan.md')).toContain(expected);
  });

  test('should make a task with verify commands a code task with the loop on', () => {
    const { out } = newTask(['--verify', 'pnpm test']);
    expect(state()).toMatchObject({
      kind: 'code',
      e2e: 'no',
      loop: { enabled: true },
    });
    expect(out).toContain(
      'Coding task: work test-first (failing test, then code); verify = pnpm test; pnpm task check (lint, format, types) runs before it once the task has code; inner loop on (max 5).'
    );
    expect(read('plan.md')).toContain(
      'Acceptance: `pnpm test` passes; `pnpm task check` passes (lint, format, types)'
    );
  });

  test('should keep a task without verify commands general', () => {
    const { out } = newTask();
    expect(state()).toMatchObject({
      kind: 'general',
      loop: { enabled: false },
    });
    expect(out).not.toContain('Coding task');
  });

  test('should require verify commands for --kind code', () => {
    expect(() => newTask(['--kind', 'code'])).toThrow(
      /A code task needs a finish line[^]*Fix: add --verify "<test command>"/
    );
  });

  test('should allow a general task with verify commands', () => {
    newTask(['--verify', 'pnpm check', '--kind', 'general']);
    expect(state()).toMatchObject({
      kind: 'general',
      loop: { enabled: false },
    });
  });

  test('should warn when e2e is required but no verify command runs it', () => {
    const { out } = newTask(['--verify', 'pnpm test', '--e2e', 'required']);
    expect(out).toContain(
      'e2e: required, but no verify command runs e2e tests yet.'
    );
    expect(read('plan.md')).toContain(
      '; e2e tests cover the user-facing flows'
    );
  });

  test('should not warn when a verify command runs e2e tests', () => {
    const { out } = newTask([
      '--verify',
      'pnpm test',
      '--verify',
      'pnpm exec playwright test',
      '--e2e',
      'required',
    ]);
    expect(state().e2e).toBe('required');
    expect(out).not.toContain('e2e: required, but');
  });

  test.each([
    [['--kind', 'app'], /--kind must be code or general \(got "app"\)/],
    [['--e2e', 'yes'], /--e2e must be required or no \(got "yes"\)/],
  ])('should reject %j', (extra, error) => {
    expect(() => newTask(extra)).toThrow(error);
  });

  test('should print JSON', () => {
    expect(JSON.parse(newTask(['--json']).out)).toMatchObject({
      ok: true,
      name: NAME,
    });
  });

  test('should require a name and a goal', () => {
    expect(() => run(['new'])).toThrow(/Usage: pnpm task new/);
    expect(() => run(['new', 'demo'])).toThrow(/needs a goal/);
  });
});

describe('init', () => {
  test('should create state.json from a hand-written plan', () => {
    const dir = legacyTask();
    const { out } = run(['init', 'old', '--verify', 'pnpm check']);
    expect(out).toContain('Created old-251101/state.json with 2 step(s)');
    const created = JSON.parse(
      fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')
    );
    expect(created).toMatchObject({
      goal: 'Legacy',
      verify: ['pnpm check'],
      steps: [{ status: 'done' }, { status: 'todo' }],
    });
  });

  test('should accept --goal when the plan has none, and print JSON', () => {
    legacyTask('bare-251101', '');
    fs.writeFileSync(path.join(tasksRoot(root), 'bare-251101', 'NOTES.md'), '');
    fs.rmSync(path.join(tasksRoot(root), 'bare-251101', 'plan.md'));
    const { out } = run(['init', 'bare', '--goal', 'Given', '--json']);
    expect(JSON.parse(out).state.goal).toBe('Given');
  });

  test('should make the adopted task a code task when verify is given', () => {
    legacyTask();
    const { out } = run(['init', 'old', '--verify', 'pnpm test']);
    expect(loadTask(root, 'old-251101').state).toMatchObject({
      kind: 'code',
      loop: { enabled: true },
    });
    expect(out).toContain('Coding task:');
  });

  test('should refuse a plan with no goal', () => {
    legacyTask('bare-251101', '- [ ] x\n');
    expect(() => run(['init', 'bare'])).toThrow(/no Goal: line/);
  });

  test('should refuse a task that already has state', () => {
    newTask();
    expect(() => run(['init'])).toThrow(/already has state\.json/);
  });
});

describe('list', () => {
  test('should explain when there are no tasks', () => {
    expect(run(['list']).out).toMatch(/^No tasks\./);
  });

  test('should list open tasks newest first and hide done ones', () => {
    const old = legacyTask();
    const past = new Date(2025, 0, 1);
    fs.utimesSync(path.join(old, 'plan.md'), past, past);
    newTask();
    const dir = legacyTask('closed-251001', 'Goal: x\n');
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ ...state(), name: 'closed-251001', status: 'done' })
    );
    const lines = run(['list']).out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `* ${NAME}  [open, active task]  updated 2026-11-17 09:30  next: s1. One`
    );
    expect(lines[1]).toMatch(
      /^ {2}old-251101 {2}\[open, untracked\].*next: b$/
    );
    expect(run(['list', '--all']).out.split('\n')).toHaveLength(3);
  });

  test('should print JSON and show a dash when nothing is next', () => {
    legacyTask('finished-251101', '- [x] a\n');
    const [task] = JSON.parse(run(['list', '--json']).out);
    expect(task).toMatchObject({ name: 'finished-251101', next: '—' });
  });

  test('should date a notes-only task by its mtime', () => {
    const dir = path.join(tasksRoot(root), 'notes-251101');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '');
    expect(listTasks(/** @type {any} */ ({ rootDir: root }))[0].updatedMs).toBe(
      Math.floor(fs.statSync(path.join(dir, 'NOTES.md')).mtimeMs)
    );
  });
});

describe('status, switch, and sessionBrief', () => {
  test('should print the brief for the active task', () => {
    newTask();
    expect(run(['status']).out).toContain(
      `[Task] ${NAME} (active task) — open (tasks/${NAME}/)`
    );
    expect(JSON.parse(run(['status', '--json']).out)).toMatchObject({
      name: NAME,
      status: 'active',
    });
    legacyTask();
    expect(run(['status', 'old']).out).toContain(
      '[Task] old-251101 — open, untracked (tasks/old-251101/)'
    );
  });

  test('should switch tasks by name or --task', () => {
    newTask();
    legacyTask();
    expect(run(['switch', 'old']).out).toBe(
      'Active task: old-251101. Next: pnpm task status'
    );
    run(['switch', '--task', 'demo', '--json']);
    expect(readActive(root)).toBe(NAME);
    expect(() => run(['switch'])).toThrow(/Usage: pnpm task switch/);
  });

  test('should brief the active task, a pick list, or nothing', () => {
    /** @type {any} */
    const deps = { rootDir: root, git: () => GIT };
    expect(sessionBrief(deps)).toBeNull();
    newTask();
    expect(sessionBrief(deps)).toContain(`[Task] ${NAME}`);
    run(['switch', 'demo']);
    fs.rmSync(path.join(tasksRoot(root), '.active'));
    expect(sessionBrief(deps)).toContain('No active task. Open tasks');
  });
});

describe('sessions', () => {
  /** @param {string} session */
  const as = (session) => ({
    env: { TASK_AGENT: 'tester', TASK_SESSION: session },
  });
  const binding = (/** @type {string} */ session) => readSession(root, session);

  test('should bind the session that creates a task, engaged', () => {
    run(['new', 'alpha', '--goal', 'A', '--step', 'One'], as('sess-a'));
    expect(binding('sess-a')).toMatchObject({
      task: 'alpha-261117',
      engaged: true,
    });
    expect(readActive(root)).toBe('alpha-261117');
  });

  test("should keep each session's commands on its own task when another session creates one", () => {
    run(['new', 'alpha', '--goal', 'A', '--step', 'One'], as('sess-a'));
    run(['new', 'beta', '--goal', 'B', '--step', 'One'], as('sess-b'));
    expect(readActive(root)).toBe('beta-261117');

    run(['step', 's1', 'done'], as('sess-a'));
    run(['set', '--verify', 'pytest'], as('sess-a'));

    const alpha = loadTask(root, 'alpha-261117').state;
    const beta = loadTask(root, 'beta-261117').state;
    expect(alpha?.steps[0].status).toBe('done');
    expect(alpha?.verify).toEqual(['pytest']);
    expect(beta?.steps[0].status).toBe('todo');
    expect(beta?.verify).toEqual([]);
  });

  test('should resolve a dormant binding without engaging it on read-only commands', async () => {
    newTask();
    writeSession(root, 'sess-c', { task: NAME, engaged: false });
    expect(run(['status'], as('sess-c')).out).toContain(
      `[Task] ${NAME} (active task)`
    );
    run(['next'], as('sess-c'));
    const runCheck = vi.fn(async () => ({
      ok: true,
      skipped: true,
      parts: [],
    }));
    await run(['check'], { ...as('sess-c'), runCheck }).code;
    expect(binding('sess-c')?.engaged).toBe(false);
  });

  test('should engage the binding on a command that changes the task', () => {
    newTask();
    writeSession(root, 'sess-c', { task: NAME, engaged: false });
    run(['note', '--done', 'x', '--next', 'y'], as('sess-c'));
    expect(binding('sess-c')).toMatchObject({ task: NAME, engaged: true });
  });

  test('should bind an unbound session to the default task on its first change', () => {
    newTask();
    run(['step', 's1', 'start'], as('sess-new'));
    expect(binding('sess-new')).toMatchObject({ task: NAME, engaged: true });
  });

  test('should leave the binding alone for --task and an already engaged task', () => {
    newTask();
    legacyTask();
    writeSession(root, 'sess-d', { task: NAME, engaged: true, now: NOW });
    run(['note', '-m', 'x', '--task', 'old'], as('sess-d'));
    run(['note', '-m', 'y'], as('sess-d'));
    expect(binding('sess-d')).toEqual({
      task: NAME,
      engaged: true,
      updatedAt: NOW.toISOString(),
    });
  });

  test('should move the binding and the default on switch', () => {
    newTask();
    legacyTask();
    run(['switch', 'old'], as('sess-e'));
    expect(binding('sess-e')).toMatchObject({
      task: 'old-251101',
      engaged: true,
    });
    expect(readActive(root)).toBe('old-251101');
  });

  test('should unbind the session and clear the default when its task is closed', () => {
    newTask(['--kind', 'general']);
    run(['step', 's1', 'done'], as('sess-f'));
    run(['step', 's2', 'done'], as('sess-f'));
    run(['done'], as('sess-f'));
    expect(binding('sess-f')).toMatchObject({ task: null, engaged: false });
    expect(readActive(root)).toBeNull();
  });

  test("should keep another session's binding when closing a task by name", () => {
    newTask(['--kind', 'general']);
    legacyTask();
    writeSession(root, 'sess-g', { task: 'old-251101', engaged: true });
    run(['step', 's1', 'done', '--task', NAME]);
    run(['step', 's2', 'done', '--task', NAME]);
    run(['done', NAME], as('sess-g'));
    expect(binding('sess-g')?.task).toBe('old-251101');
  });

  test("should mark the session's task as active in list and the brief", () => {
    newTask();
    legacyTask();
    writeSession(root, 'sess-h', { task: 'old-251101', engaged: false });
    expect(run(['list'], as('sess-h')).out).toMatch(
      /^\* old-251101 {2}\[open, untracked, active task\]/m
    );
    /** @type {any} */
    const deps = { rootDir: root, git: () => GIT, env: {} };
    expect(sessionBrief(deps, 'sess-h')).toContain('[Task] old-251101');
    expect(sessionBrief(deps)).toContain(`[Task] ${NAME}`);
  });
});

describe('repo', () => {
  /** @type {string} */
  let repo;
  /** @type {import('../review.js').RunGit} */
  const runGit = (args, cwd) => {
    if (args.join(' ') === 'rev-parse --show-toplevel') {
      return fs.existsSync(path.join(cwd, '.git')) ? cwd : null;
    }
    if (args.join(' ') === 'rev-parse HEAD') {
      return cwd === repo ? 'repohead' : 'roothead';
    }
    return null;
  };
  /** @param {string} cwd */
  const git = (cwd) =>
    cwd === repo
      ? { branch: 'feat/r', changed: 3, diffStat: null }
      : { branch: 'feat/x', changed: 0, diffStat: null };
  const deps = { runGit, git };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'task-repo-'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.mkdirSync(path.join(root, '.git'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('should record the repo with its branch and start commit', () => {
    run(['new', 'demo', '--goal', 'G', '--repo', repo], deps);
    expect(state()).toMatchObject({
      repo,
      branch: 'feat/r',
      startCommit: 'repohead',
    });
  });

  test('should take git state for status and notes from the repo', () => {
    // The temp dir can sit under the real home (Windows), which would print ~.
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    run(['new', 'demo', '--goal', 'G', '--repo', repo], deps);
    const { out } = run(['status'], deps);
    expect(out).toContain(`Repo: ${repo}`);
    expect(out).toContain('Git: branch feat/r; uncommitted yes (3 files)');
    run(['note', '--done', 'x', '--next', 'y'], deps);
    expect(read('NOTES.md')).toContain(
      'State: branch feat/r; uncommitted yes (3 files); verify not run'
    );
  });

  test('should treat the workspace itself as no repo', () => {
    run(['new', 'demo', '--goal', 'G', '--repo', root], deps);
    expect(state()).not.toHaveProperty('repo');
    expect(state().startCommit).toBe('roothead');
  });

  test('should refuse a missing folder or one outside git', () => {
    const plain = path.join(repo, 'plain');
    fs.mkdirSync(plain);
    expect(() =>
      run(
        ['new', 'demo', '--goal', 'G', '--repo', path.join(repo, 'nope')],
        deps
      )
    ).toThrow(/--repo .*nope: no such folder/);
    expect(() =>
      run(['new', 'demo', '--goal', 'G', '--repo', plain], {
        ...deps,
        runGit: () => null,
      })
    ).toThrow(/is not in a git repository/);
  });

  test('should expand ~ and resolve a relative path from where the command ran', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(path.dirname(repo));
    run(
      ['new', 'demo', '--goal', 'G', '--repo', `~/${path.basename(repo)}`],
      deps
    );
    expect(state().repo).toBe(repo);
    run(['set', '--repo', path.basename(repo)], {
      ...deps,
      env: { TASK_AGENT: 'tester', INIT_CWD: path.dirname(repo) },
    });
    expect(state().repo).toBe(repo);
  });

  test('should set and clear the repo, restarting the start commit and review base', () => {
    newTask(['--verify', 'pnpm test']);
    updateState(root, NAME, (s) => ({
      ...s,
      quality: {
        .../** @type {import('../quality.js').Quality} */ (s.quality),
        base: 'roothead',
      },
    }));

    // The temp dir can sit under the real home (Windows), which would print ~.
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    const { out } = run(['set', '--repo', repo], deps);
    expect(out).toContain(`Repo: ${repo} (start commit repohead)`);
    expect(state()).toMatchObject({
      repo,
      branch: 'feat/r',
      startCommit: 'repohead',
      quality: { base: null },
    });

    run(['set', '--repo', 'none'], deps);
    expect(state()).toMatchObject({ repo: null, startCommit: 'roothead' });
  });

  test('should refuse to change the repo while a review round is open', () => {
    newTask(['--verify', 'pnpm test']);
    updateState(root, NAME, (s) => ({
      ...s,
      quality: {
        .../** @type {import('../quality.js').Quality} */ (s.quality),
        phase: 'review',
        reviewRounds: 1,
      },
    }));
    expect(() => run(['set', '--repo', repo], deps)).toThrow(
      /Review round 1 is open/
    );
  });

  test('should adopt a hand-written task with a repo', () => {
    legacyTask();
    run(['init', 'old', '--repo', repo], deps);
    expect(loadTask(root, 'old-251101').state).toMatchObject({
      repo,
      startCommit: 'repohead',
    });
  });
});

describe('next', () => {
  test('should print the next step and how to start or finish it', () => {
    newTask();
    expect(run(['next']).out).toBe(
      's1. One [todo] — start: pnpm task step s1 start'
    );
    run(['step', 's1', 'start']);
    expect(run(['next']).out).toContain(
      'when finished: pnpm task step s1 done'
    );
    expect(JSON.parse(run(['next', '--json']).out).step.id).toBe('s1');
  });

  test('should say when nothing is ready', () => {
    run(['new', 'demo', '--goal', 'G']);
    expect(run(['next']).out).toMatch(/^No ready step/);
  });

  test('should point a hand-written task at init', () => {
    legacyTask();
    expect(() => run(['next', 'old'])).toThrow(/pnpm task init old-251101/);
  });
});

describe('step', () => {
  test('should add steps with optional deps', () => {
    newTask();
    expect(run(['step', 'add', 'Three', '--deps', 's1, s2,']).out).toBe(
      'Added s3. Three'
    );
    expect(state().steps[2].deps).toEqual(['s1', 's2']);
    expect(
      JSON.parse(run(['step', 'add', 'Four', '--json']).out).step
    ).toMatchObject({
      id: 's4',
      deps: [],
    });
    expect(read('plan.md')).toContain('- [ ] s3. Three (after s1, s2)');
  });

  test('should start and finish a step and log the finish in NOTES', () => {
    newTask();
    expect(run(['step', 's1', 'start']).out).toBe(
      's1. One → in_progress\nNext step: s1. One'
    );
    expect(state().steps[0].owner).toBe('tester');
    run(['step', 's1', 'done', '-m', 'shipped']);
    expect(read('NOTES.md')).toContain(
      '## 2026-11-17 09:30 — tester (step s1 done)\n\ns1. One → done: shipped'
    );
    expect(read('plan.md')).toContain('- [x] s1. One');
  });

  test('should log a blocked step and say when nothing is left', () => {
    run(['new', 'demo', '--goal', 'G', '--step', 'Only']);
    const { out } = run([
      'step',
      's1',
      'blocked',
      '-m',
      'needs API key',
      '--json',
    ]);
    expect(JSON.parse(out).next).toBeNull();
    expect(read('NOTES.md')).toContain('s1. Only → blocked: needs API key');
    expect(run(['step', 's1', 'done']).out).toContain('No ready step left');
    expect(read('NOTES.md')).toContain('s1. Only → done\n');
  });

  test('should not log start or todo in NOTES', () => {
    newTask();
    const before = read('NOTES.md');
    run(['step', 's1', 'start']);
    run(['step', 's1', 'todo']);
    expect(read('NOTES.md')).toBe(before);
  });

  test('should reject bad usage', () => {
    newTask();
    expect(() => run(['step'])).toThrow(/Usage: pnpm task step add/);
    expect(() => run(['step', 'add'])).toThrow(
      'Usage: pnpm task step add "title"'
    );
    expect(() => run(['step', 's1'])).toThrow(/Usage: pnpm task step s1 start/);
    expect(() => run(['step', 's1', 'finish'])).toThrow(/start\|done/);
  });
});

describe('step waiting and remove', () => {
  test('should mark a step waiting with what it waits for, and note it', () => {
    newTask();
    const { out } = run(['step', 's2', 'waiting', '-m', 'the user signs in']);
    expect(out).toContain('s2. Two → waiting');
    expect(state().steps[1]).toMatchObject({
      status: 'waiting',
      note: 'the user signs in',
    });
    expect(read('NOTES.md')).toContain(
      '(step s2 waiting)\n\ns2. Two → waiting: the user signs in'
    );
  });

  test('should mark a waiting step as a gate that holds the review', () => {
    newTask();
    const { out } = run([
      'step',
      's2',
      'waiting',
      '--gate',
      '-m',
      'the user approves the design',
    ]);
    expect(out).toContain('s2. Two → waiting (gate: holds the review)');
    expect(state().steps[1]).toMatchObject({ status: 'waiting', gate: true });
  });

  test('should list --gate in the help', () => {
    expect(run(['help']).out).toContain('waiting [--gate]');
  });

  test('should say no step is left for the agent when the rest waits on someone else', () => {
    newTask();
    run(['step', 's1', 'done']);
    expect(
      run(['step', 's2', 'waiting', '-m', 'the user signs in']).out
    ).toContain(
      'No step left for you: s2 waits on someone else. When it happens: pnpm task step s2 done'
    );
  });

  test('should remove a step with a reason and note it', () => {
    newTask();
    const { out } = run(['step', 's2', 'remove', '-m', 'written by mistake']);
    expect(out).toBe('Removed s2. Two (written by mistake)');
    expect(state().steps.map((s) => s.id)).toEqual(['s1']);
    expect(read('NOTES.md')).toContain(
      '(step s2 removed)\n\ns2. Two removed: written by mistake'
    );
  });

  test('should need a reason to remove a step', () => {
    newTask();
    expect(() => run(['step', 's2', 'remove'])).toThrow(
      /Removing a step needs a reason: -m "why"/
    );
  });

  test('should name a waiting step without a note', () => {
    newTask(['--kind', 'general']);
    const s = state();
    expect(
      doneBlockers({
        ...s,
        steps: s.steps.map((step) => ({ ...step, status: 'waiting' })),
      })[0]
    ).toMatch(/^s1 waits on someone else \(no note\)\./);
  });

  test('should keep a waiting step from closing the task, with how to finish it', () => {
    newTask(['--kind', 'general']);
    run(['step', 's1', 'done']);
    run(['step', 's2', 'waiting', '-m', 'store review']);
    expect(() => run(['done'])).toThrow(
      /s2 waits on someone else \(store review\)\. When it happens: pnpm task step s2 done/
    );
  });
});

describe('rm', () => {
  test("should move paths to the trash, inside the workspace and the task's repo", () => {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rm-repo-'))
    );
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      fs.writeFileSync(path.join(root, 'stale.txt'), 'x');
      fs.writeFileSync(path.join(repo, 'old.js'), 'y');
      /** @type {import('../review.js').RunGit} */
      const runGit = (args, cwd) =>
        args.join(' ') === 'rev-parse --show-toplevel' ? cwd : null;
      run(['new', 'demo', '--goal', 'G', '--repo', repo], { runGit });

      const { out } = run(['rm', 'stale.txt', path.join(repo, 'old.js')]);

      expect(out).toMatch(
        /^Moved 2 path\(s\) to tasks\/\.trash\/\d{8}-\d{6}\/ \(kept 7 days\)\./
      );
      expect(out).toContain('Restore: mv ');
      expect(fs.existsSync(path.join(root, 'stale.txt'))).toBe(false);
      expect(fs.existsSync(path.join(repo, 'old.js'))).toBe(false);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('should work without any task, in the workspace only', () => {
    fs.writeFileSync(path.join(root, 'stale.txt'), 'x');
    const parsed = JSON.parse(run(['rm', 'stale.txt', '--json']).out);
    expect(parsed).toMatchObject({
      ok: true,
      moved: [{ from: expect.stringContaining('stale.txt') }],
    });
  });

  test('should use the repo of the task given with --task', () => {
    newTask();
    fs.writeFileSync(path.join(root, 'stale.txt'), 'x');
    expect(run(['rm', 'stale.txt', '--task', 'demo']).code).toBe(0);
  });
});

describe('note', () => {
  test('should append a structured entry with a State line and save next', () => {
    newTask();
    run(['note', '--done', 'A', '--next', 'B', '--open', 'C']);
    expect(read('NOTES.md')).toContain(
      '## 2026-11-17 09:30 — tester\n\nDone: A\nState: branch feat/x; uncommitted yes (2 files); verify not run\nNext: B\nOpen: C\n'
    );
    expect(state().next).toBe('B');
  });

  test('should accept a plain message without touching state', () => {
    newTask();
    const before = state().updatedAt;
    const { out } = run(['note', '-m', 'just a note', '--json']);
    expect(JSON.parse(out)).toEqual({ ok: true, task: NAME });
    expect(state().updatedAt).toBe(before);
  });

  test('should work on hand-written tasks', () => {
    legacyTask();
    run(['note', '--task', 'old', '--next', 'carry on']);
    expect(
      fs.readFileSync(
        path.join(tasksRoot(root), 'old-251101', 'NOTES.md'),
        'utf-8'
      )
    ).toContain('Next: carry on');
  });

  test('should require at least one field', () => {
    expect(() => run(['note'])).toThrow(/Usage: pnpm task note/);
  });
});

describe('stateLine', () => {
  test.each([
    [null, 'not run'],
    [{ ok: true }, 'pass'],
    [{ ok: false }, 'fail'],
  ])('should report verify %j as %s', (lastVerify, word) => {
    /** @type {any} */
    const task = { state: { lastVerify } };
    expect(
      stateLine(/** @type {any} */ ({ rootDir: root, git: () => GIT }), task)
    ).toMatch(new RegExp(`verify ${word}$`));
  });

  test('should handle a task without state', () => {
    /** @type {any} */
    const deps = { rootDir: root, git: () => GIT };
    expect(stateLine(deps, /** @type {any} */ ({ state: null }))).toMatch(
      /not run$/
    );
  });
});

describe('verify', () => {
  test('should run the commands, record a pass, and print progress', () => {
    newTask(['--verify', 'pnpm lint', '--verify', 'pnpm test']);
    const runCommands = fakeRunner([{ ok: true }, { ok: true }]);
    const { code, out } = run(['verify'], { runCommands });
    expect(code).toBe(0);
    expect(out).toBe(
      '▶ pnpm lint\n▶ pnpm test\n✓ verify passed (2 command(s))'
    );
    expect(state().lastVerify).toMatchObject({ ok: true, failed: null });
    expect(runCommands).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['pnpm lint', 'pnpm test'],
        cwd: root,
      })
    );
  });

  test('should record a failure and exit 1', () => {
    newTask(['--verify', 'pnpm test']);
    const runCommands = fakeRunner([
      { ok: false, output: 'x\nAssertionError' },
    ]);
    const { code, out } = run(['verify'], { runCommands });
    expect(code).toBe(1);
    expect(out).toContain(
      '✗ pnpm test failed (exit 1):\nx\nAssertionError\nFix the failure'
    );
    expect(state().lastVerify).toMatchObject({
      ok: false,
      failed: 'pnpm test',
    });
  });

  test('should record what the passing verify ran on, except with --no-check', () => {
    newTask(['--verify', 'pnpm test']);
    /** @type {import('../review.js').RunGit} */
    const runGit = (args) =>
      ({ 'rev-parse': 'h', status: '', diff: '', 'ls-files': '' })[args[0]] ??
      null;
    run(['verify'], { runGit });
    expect(state().lastVerify?.print).toMatch(/^[0-9a-f]{16}$/);
    run(['verify', '--no-check'], { runGit });
    expect(state().lastVerify).not.toHaveProperty('print');
  });

  test('should use the fast list with --fast, and fall back without one', () => {
    newTask(['--verify', 'slow', '--verify-fast', 'quick']);
    const runCommands = fakeRunner([{ ok: true }]);
    run(['verify', '--fast'], { runCommands });
    expect(runCommands.mock.calls[0][0].commands).toEqual(['quick']);

    run(['set', '--verify-fast', 'quick']);
    const fallback = fakeRunner([{ ok: true }]);
    fs.writeFileSync(
      path.join(tasksRoot(root), NAME, 'state.json'),
      JSON.stringify({ ...state(), verifyFast: [] })
    );
    run(['verify', '--fast'], { runCommands: fallback });
    expect(fallback.mock.calls[0][0].commands).toEqual(['slow']);
  });

  test('should print JSON without progress lines', () => {
    newTask(['--verify', 'a']);
    const runCommands = fakeRunner([{ ok: true, output: 'done' }]);
    const parsed = JSON.parse(run(['verify', '--json'], { runCommands }).out);
    expect(parsed.results).toEqual([
      { command: 'a', ok: true, code: 0, durationMs: 1, tail: 'done' },
    ]);
  });

  test('should explain missing state or commands', () => {
    legacyTask();
    expect(() => run(['verify', '--task', 'old'])).toThrow(
      /pnpm task init old-251101 --verify/
    );
    newTask();
    expect(() => run(['verify'])).toThrow(
      /no verify commands\.\nFix: pnpm task set/
    );
  });

  test('should run pnpm task check first when the task has code', () => {
    newTask(['--verify', 'pnpm test']);
    fs.mkdirSync(path.join(tasksRoot(root), NAME, 'scripts'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(tasksRoot(root), NAME, 'scripts', 'a.js'), '');
    const runCommands = fakeRunner([{ ok: true }, { ok: true }]);
    run(['verify'], { runCommands });
    expect(runCommands.mock.calls[0][0].commands).toEqual([
      `pnpm task check --task ${NAME}`,
      'pnpm test',
    ]);

    const skipped = fakeRunner([{ ok: true }]);
    run(['verify', '--no-check'], { runCommands: skipped });
    expect(skipped.mock.calls[0][0].commands).toEqual(['pnpm test']);
  });
});

describe('check', () => {
  const result = (/** @type {boolean} */ ok) => ({
    ok,
    skipped: false,
    parts: [{ name: /** @type {const} */ ('eslint'), ok, output: 'out' }],
  });

  test('should report a pass and pass --fix through', async () => {
    newTask();
    const runCheck = vi.fn(async () => result(true));
    const { code } = run(['check', '--fix'], { runCheck });
    expect(await code).toBe(0);
    expect(logs.join('\n')).toContain('✓ check passed');
    expect(runCheck).toHaveBeenCalledWith({
      rootDir: root,
      taskDir: path.join(tasksRoot(root), NAME),
      fix: true,
    });
  });

  test('should exit 1 on failure and print JSON with --json', async () => {
    newTask();
    const runCheck = vi.fn(async () => result(false));
    const { code } = run(['check', '--json'], { runCheck });
    expect(await code).toBe(1);
    expect(JSON.parse(logs.join('\n'))).toMatchObject({
      ok: false,
      task: NAME,
      parts: [{ name: 'eslint' }],
    });
  });
});

describe('review', () => {
  const finishSteps = () => {
    run(['step', 's1', 'done']);
    run(['step', 's2', 'done']);
  };
  const taskDir = () => path.join(tasksRoot(root), NAME);
  const findingsFile = (/** @type {number} */ n) =>
    path.join(taskDir(), 'reviews', `REVIEW_${NAME}-r${n}.md`);
  /** A code task with one code file and a green verify. */
  const greenCodeTask = () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    fs.mkdirSync(path.join(taskDir(), 'app'), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), 'app', 'a.js'), 'export {};\n');
    run(['verify'], { runCommands: fakeRunner([{ ok: true }, { ok: true }]) });
  };
  const addRows = (/** @type {number} */ n, /** @type {string[]} */ rows) =>
    fs.appendFileSync(findingsFile(n), `${rows.join('\n')}\n`);
  const HIGH =
    '| | app/a.js:1 | high | Leaks handle | open twice → EMFILE | CONFIRMED | no close |';
  const LOW =
    '| | app/a.js | low | Odd name | reading it | CONFIRMED | agreed |';

  test('should open round 1, write the brief and findings files, and log it', () => {
    greenCodeTask();
    const { code, out } = run(['review']);
    expect(code).toBe(0);
    expect(out).toContain(`Opened review round 1/2 for ${NAME} (1 file(s)).`);
    expect(out).toContain(`Brief: tasks/${NAME}/reviews/BRIEF_${NAME}-r1.md`);
    expect(out).toContain('subagent_type "reviewer"');
    expect(out).toContain(
      'Codex: spawn_agent with agent_type "reviewer", message "Follow'
    );
    expect(out).toContain('then wait_agent before you end the turn');
    expect(out).toContain(
      'DSH: subagent with prompt "Follow .claude/agents/reviewer.md'
    );
    expect(out).toContain('Then: pnpm task review record');
    expect(state().quality).toMatchObject({
      phase: 'review',
      reviewRounds: 1,
      base: null,
    });
    expect(read(`reviews/BRIEF_${NAME}-r1.md`)).toContain(
      `- tasks/${NAME}/app/a.js`
    );
    expect(read('NOTES.md')).toContain('Review round 1/2 opened: 1 file(s)');
  });

  test('should refuse --folder or --base while a round is open', () => {
    greenCodeTask();
    run(['review']);

    expect(() => run(['review', '--folder'])).toThrow(
      /Round 1 is open with its own scope[^]*Fix: finish it/
    );
    expect(() => run(['review', '--base', 'main'])).toThrow(
      /Round 1 is open with its own scope/
    );
  });

  test('should reprint an open round without touching the findings file', () => {
    greenCodeTask();
    run(['review']);
    addRows(1, [HIGH]);
    const notes = read('NOTES.md');
    const { out } = run(['review', '--json']);
    expect(JSON.parse(out)).toMatchObject({ round: 1, reopened: true });
    expect(fs.readFileSync(findingsFile(1), 'utf-8')).toContain('Leaks handle');
    expect(read('NOTES.md')).toBe(notes);
    expect(run(['review']).out).toContain('Review round still open 1/2');
  });

  test('should review git changes since main when the task has no code', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    run(['verify']);
    /** @type {import('../review.js').RunGit} */
    const runGit = (args) =>
      args[0] === 'merge-base' ? 'abc' : args[0] === 'diff' ? 'utils/x.js' : '';
    const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);
    expect(parsed.scope).toEqual({
      base: 'main',
      since: 'abc',
      files: ['utils/x.js'],
    });
    expect(state().quality?.base).toBe('main');
  });

  test('should review a page in docs/ and Python from the task folder, not unrelated git changes', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    for (const rel of ['docs/index.html', 'app/clean.py', 'scripts/gen.sh']) {
      fs.mkdirSync(path.dirname(path.join(taskDir(), rel)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(taskDir(), rel), '\n');
    }
    run(['verify']);
    /** @type {import('../review.js').RunGit} */
    const runGit = (args) =>
      args[0] === 'merge-base'
        ? 'abc'
        : args[0] === 'diff'
          ? 'skills-lock.json'
          : '';

    const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);

    expect(parsed.scope).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/app/clean.py`, `tasks/${NAME}/docs/index.html`],
    });
    const brief = read(`reviews/BRIEF_${NAME}-r1.md`);
    expect(brief).toContain(
      `- tasks/${NAME}/docs/index.html — pnpm task check does not lint or format it`
    );
    expect(brief).toContain(`- tasks/${NAME}/scripts/gen.sh`);
    expect(brief).not.toContain('skills-lock.json');
  });

  test('should review the task folder with --folder and keep later rounds on it', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    fs.mkdirSync(path.join(taskDir(), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), 'scripts', 'gen.py'), 'print(1)\n');
    run(['verify']);
    /** @type {import('../review.js').RunGit} */
    const runGit = (args) =>
      args[0] === 'merge-base' ? 'abc' : args[0] === 'diff' ? 'utils/x.js' : '';
    const folder = {
      base: null,
      since: null,
      files: [`tasks/${NAME}/scripts/gen.py`],
    };

    const first = JSON.parse(
      run(['review', '--folder', '--json'], { runGit }).out
    );
    run(['review', 'record'], { runGit });
    const second = JSON.parse(run(['review', '--json'], { runGit }).out);

    expect(first.scope).toEqual(folder);
    expect(second).toMatchObject({ round: 2, scope: folder });
    expect(state().quality?.base).toBe(FOLDER_BASE);
  });

  test('should refuse --folder with --base, or for a folder without code', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    run(['verify']);

    expect(() => run(['review', '--folder', '--base', 'main'])).toThrow(
      /--folder or --base, not both/
    );
    expect(() => run(['review', '--folder'])).toThrow(
      `Nothing to review for ${NAME}: its task folder has no code`
    );
  });

  /**
   * A fake git: HEAD is `head`, merge-base(HEAD, main) is `mergeBase`, and one
   * file changed.
   *
   * @param {{ head: string, mergeBase: string }} refs
   */
  const fakeGit = ({ head, mergeBase }) =>
    vi.fn(
      /** @type {import('../review.js').RunGit} */ (args) =>
        args[0] === 'rev-parse'
          ? head
          : args[0] === 'merge-base'
            ? args[2] === 'main'
              ? mergeBase
              : args[2]
            : args[0] === 'diff'
              ? 'utils/x.js'
              : ''
    );

  test('should review work committed on main since the task started', () => {
    run(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v'], {
      runGit: fakeGit({ head: 'start123', mergeBase: 'start123' }),
    });
    expect(state().startCommit).toBe('start123');
    run(['step', 's1', 'done']);
    run(['verify']);
    // Two commits later, still on main: merge-base(HEAD, main) is HEAD.
    const runGit = fakeGit({ head: 'later456', mergeBase: 'later456' });
    const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);
    expect(parsed.scope).toEqual({
      base: 'start123',
      since: 'start123',
      files: ['utils/x.js'],
    });
    expect(runGit).toHaveBeenCalledWith(
      ['diff', '--name-only', 'start123'],
      root
    );
    expect(state().quality?.base).toBe('start123');
  });

  test('should review only since the task started on a branch that already had other work', () => {
    run(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v'], {
      runGit: fakeGit({ head: 'mid789', mergeBase: 'fork000' }),
    });
    run(['step', 's1', 'done']);
    run(['verify']);
    const runGit = fakeGit({ head: 'tip999', mergeBase: 'fork000' });
    const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);
    expect(parsed.scope).toMatchObject({ base: 'mid789', since: 'mid789' });
    expect(runGit).toHaveBeenCalledWith(
      ['diff', '--name-only', 'mid789'],
      root
    );
  });

  test('should review the whole branch with an explicit --base', () => {
    run(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v'], {
      runGit: fakeGit({ head: 'mid789', mergeBase: 'fork000' }),
    });
    run(['step', 's1', 'done']);
    run(['verify']);
    const runGit = fakeGit({ head: 'tip999', mergeBase: 'fork000' });
    const parsed = JSON.parse(
      run(['review', '--json', '--base', 'main'], { runGit }).out
    );
    expect(parsed.scope).toMatchObject({ base: 'main', since: 'fork000' });
  });

  test("should review a repo task's changes in its repository", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-repo-'));
    try {
      fs.writeFileSync(path.join(repo, 'a.js'), 'v1');
      /** @type {import('../review.js').RunGit} */
      const runGit = vi.fn((args, cwd) =>
        args.join(' ') === 'rev-parse --show-toplevel'
          ? cwd
          : args[0] === 'rev-parse'
            ? cwd === repo
              ? 'r-start'
              : 'w-head'
            : args[0] === 'merge-base'
              ? args[1] === '--is-ancestor'
                ? ''
                : 'r-fork'
              : args[0] === 'diff' && cwd === repo
                ? 'a.js\ntasks/t.js'
                : ''
      );
      run(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v'], {
        runGit,
      });
      run(['set', '--repo', repo], { runGit });
      run(['step', 's1', 'done']);
      run(['verify']);

      const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);

      expect(parsed.scope).toEqual({
        base: 'r-start',
        since: 'r-start',
        files: ['a.js', 'tasks/t.js'],
      });
      expect(runGit).toHaveBeenCalledWith(
        ['diff', '--name-only', 'r-start'],
        repo
      );
      const brief = fs.readFileSync(
        path.join(tasksRoot(root), NAME, 'reviews', `BRIEF_${NAME}-r1.md`),
        'utf-8'
      );
      expect(brief).toContain(`Repository: ${repo}`);
      expect(brief).toContain(`git -C ${repo} diff r-start -- <file>`);
      expect(state().quality?.reviewedDiff).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test("should review against the repository's default branch", () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    run(['verify']);
    const runGit = vi.fn(
      /** @type {import('../review.js').RunGit} */ (args) =>
        args[0] === 'symbolic-ref'
          ? 'origin/develop'
          : args[0] === 'merge-base'
            ? 'fork000'
            : args[0] === 'diff'
              ? 'utils/x.js'
              : 'tip999'
    );
    const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);
    expect(parsed.scope).toMatchObject({
      base: 'origin/develop',
      since: 'fork000',
    });
    expect(runGit).toHaveBeenCalledWith(
      ['merge-base', 'HEAD', 'origin/develop'],
      root
    );
  });

  test('should review unpushed work on main since the task started', () => {
    run(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v'], {
      runGit: fakeGit({ head: 'start123', mergeBase: 'start123' }),
    });
    run(['step', 's1', 'done']);
    run(['verify']);
    // On local main, two commits ahead of origin/main.
    const runGit = vi.fn(
      /** @type {import('../review.js').RunGit} */ (args) =>
        ({
          'symbolic-ref': 'origin/main',
          'merge-base': 'pushed000',
          'rev-parse': 'local222',
          branch: 'main',
          diff: 'utils/x.js',
        })[args[0]] ?? ''
    );
    const parsed = JSON.parse(run(['review', '--json'], { runGit }).out);
    expect(parsed.scope).toEqual({
      base: 'start123',
      since: 'start123',
      files: ['utils/x.js'],
    });
  });

  test('should use an explicit --base as given, even on main', () => {
    run(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v'], {
      runGit: fakeGit({ head: 'start123', mergeBase: 'start123' }),
    });
    run(['step', 's1', 'done']);
    run(['verify']);
    const runGit = vi.fn(
      /** @type {import('../review.js').RunGit} */ (args) =>
        ({ 'merge-base': 'later456', 'rev-parse': 'later456' })[args[0]] ?? ''
    );
    expect(() => run(['review', '--base', 'main'], { runGit })).toThrow(
      /no files changed since main \(commit later45\)\. If the work/
    );
  });

  test('should record the start commit when adopting a hand-written task', () => {
    legacyTask();
    run(['init', 'old', '--verify', 'v'], {
      runGit: fakeGit({ head: 'adopt111', mergeBase: 'adopt111' }),
    });
    const adopted = loadTask(root, 'old-251101').state;
    expect(adopted?.startCommit).toBe('adopt111');
  });

  test('should refuse to open a round with nothing in scope', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    run(['verify']);
    const runGit = (/** @type {string[]} */ args) =>
      args[0] === 'merge-base' ? 'abcdef123' : '';
    expect(() => run(['review'], { runGit })).toThrow(
      /Nothing to review for demo-261117: no files changed since main \(commit abcdef1\)\. demo-261117 has no recorded start commit.*\nFix: pnpm task review --base/s
    );
    expect(state().quality?.reviewRounds).toBe(0);
    fs.mkdirSync(path.join(tasksRoot(root), NAME, 'app'), { recursive: true });
    fs.writeFileSync(path.join(tasksRoot(root), NAME, 'app', 'notes.txt'), '');
    expect(() => run(['review', '--base', 'main'], { runGit })).toThrow(
      /no files changed since main/
    );
  });

  test('should take --base and --force', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    const runGit = vi.fn(() => 'abc');
    run(['review', '--base', 'dev', '--force'], { runGit });
    expect(runGit).toHaveBeenCalledWith(['merge-base', 'HEAD', 'dev'], root);
  });

  test('should explain a missing state.json and an unknown subcommand', () => {
    legacyTask();
    expect(() => run(['review', '--task', 'old'])).toThrow(
      /pnpm task init old-251101/
    );
    expect(() => run(['review', 'record', '--task', 'old'])).toThrow(
      /pnpm task init old-251101/
    );
    expect(() => run(['review', 'later'])).toThrow(/Usage: pnpm task review/);
  });

  test('should record fixes, then run round 2 and complete the loop', () => {
    greenCodeTask();
    run(['review']);
    addRows(1, [HIGH, LOW]);

    const first = run(['review', 'record']).out;
    expect(first).toContain(
      'Round 1: 2 finding(s) — 2 confirmed, 0 refuted; 1 fix step(s) (s3); 1 medium/low recorded.'
    );
    expect(first).toContain('  s3. fix: Leaks handle (app/a.js:1; r1-1)');
    expect(first).toContain('Recorded, not fixed (medium/low): r1-2');
    expect(first).toContain(
      'After all fixes pass verify: pnpm task review (next round).'
    );
    expect(state().quality?.phase).toBe('fix');
    expect(() => run(['review'])).toThrow(/before the next review: s3/);

    run(['step', 's3', 'done']);
    const second = run(['review']).out;
    expect(second).toContain('Opened review round 2/2');
    expect(read(`reviews/BRIEF_${NAME}-r2.md`)).toContain('- fixed r1-1');

    const last = run(['review', 'record']).out;
    expect(last).toContain('Round 2: 0 finding(s)');
    expect(last).toContain('the quality loop is complete');
    expect(state().quality).toMatchObject({
      phase: 'complete',
      reviewRounds: 2,
    });
    expect(() => run(['review'])).toThrow(/2\/2 review rounds \(the limit\)/);
  });

  test('should say when the last round still has fixes', () => {
    greenCodeTask();
    const quality = { ...state().quality, reviewRounds: 1, phase: 'complete' };
    fs.writeFileSync(
      path.join(taskDir(), 'state.json'),
      JSON.stringify({ ...state(), quality })
    );
    run(['review']);
    addRows(2, [HIGH]);
    const { out } = run(['review', 'record']);
    expect(out).toContain(
      'That was the last review round (2/2): after the fixes, no more reviews.'
    );
    expect(state().quality?.phase).toBe('fix');
  });

  test('should print the recorded round as JSON', () => {
    greenCodeTask();
    run(['review']);
    addRows(1, [HIGH]);
    const parsed = JSON.parse(run(['review', 'record', '--json']).out);
    expect(parsed).toMatchObject({
      ok: true,
      round: 1,
      fixSteps: [{ id: 's3' }],
    });
  });

  test('should refuse rows that have not been triaged and name the file', () => {
    greenCodeTask();
    run(['review']);
    addRows(1, ['| | app/a.js | high | c | s |  |  |']);
    expect(() => run(['review', 'record'])).toThrow(
      new RegExp(
        `REVIEW_${NAME}-r1\\.md is not ready:\\n- row 1: no verdict yet`
      )
    );
  });

  test('should read a findings file given on the command line', () => {
    greenCodeTask();
    run(['review']);
    const other = path.join(root, 'elsewhere.md');
    fs.writeFileSync(
      other,
      fs.readFileSync(findingsFile(1), 'utf-8') + `${LOW}\n`
    );
    expect(run(['review', 'record', 'elsewhere.md']).out).toContain(
      'Round 1: 1 finding(s)'
    );
  });

  test('should handle a code task written before quality existed', () => {
    greenCodeTask();
    const { quality: _q, ...legacy } = state();
    const file = path.join(taskDir(), 'state.json');
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(() => run(['review', 'record'])).toThrow(
      /REVIEW_demo-261117-r0\.md/
    );
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(run(['review']).out).toContain('Opened review round 1/2');
  });

  test('should explain a missing findings file', () => {
    greenCodeTask();
    expect(() => run(['review', 'record'])).toThrow(
      new RegExp(
        `No findings file at tasks/${NAME}/reviews/REVIEW_${NAME}-r0\\.md`
      )
    );
  });
});

describe('set', () => {
  test('should replace the goal and verify lists', () => {
    newTask(['--verify', 'old', '--kind', 'general']);
    expect(
      run(['set', '--goal', 'New goal', '--verify', 'a', '--verify', 'b']).out
    ).toBe(
      `Updated ${NAME}: verify = a && b; fast = (same as verify)\nInner loop: off`
    );
    expect(state()).toMatchObject({ goal: 'New goal', verify: ['a', 'b'] });
  });

  test('should keep unchanged fields and print JSON', () => {
    newTask();
    const parsed = JSON.parse(run(['set', '--verify-fast', 'q', '--json']).out);
    expect(parsed.state).toMatchObject({
      goal: 'Ship it',
      verify: [],
      verifyFast: ['q'],
    });
    expect(run(['set', '--verify-fast', 'q']).out).toContain(
      'verify = (none); fast = q'
    );
  });

  test('should require something to set', () => {
    expect(() => run(['set'])).toThrow(/Usage: pnpm task set/);
  });

  test('should turn the inner loop on with a cap and reset its counters', () => {
    newTask(['--verify', 'pnpm test']);
    expect(run(['set', '--loop', 'on', '--loop-max', '3']).out).toContain(
      'Inner loop: on (max 3) — in Claude Code, each stop re-runs the fast verify until it passes. Turn off: pnpm task set --loop off'
    );
    expect(state().loop).toEqual({
      enabled: true,
      iteration: 0,
      max: 3,
      signature: null,
      repeats: 0,
      halted: false,
    });
  });

  test('should change only the cap and keep the loop setting', () => {
    newTask(['--verify', 'pnpm test', '--kind', 'general']);
    run(['set', '--loop-max', '7']);
    expect(state().loop).toMatchObject({ enabled: false, max: 7 });
    run(['set', '--loop', 'on']);
    run(['set', '--loop', 'off']);
    expect(state().loop).toMatchObject({ enabled: false, max: 7 });
  });

  test('should refuse to turn the loop on without verify commands', () => {
    newTask();
    expect(() => run(['set', '--loop', 'on'])).toThrow(
      /no verify commands, so the loop has no finish line\.\nFix: pnpm task set --verify "<test command>" --loop on/
    );
    expect(state().loop.enabled).toBe(false);
  });

  test('should turn the loop on when a task becomes a code task', () => {
    newTask(['--verify', 'pnpm test', '--kind', 'general']);
    const { out } = run(['set', '--kind', 'code', '--e2e', 'required']);
    expect(state()).toMatchObject({
      kind: 'code',
      e2e: 'required',
      loop: { enabled: true, iteration: 0 },
    });
    expect(out).toContain('Inner loop: on (max 5)');
    expect(out).toContain('Coding task:');
    expect(state().quality).toMatchObject({ phase: 'build', reviewRounds: 0 });
  });

  test('should keep the quality state when a task becomes a code task again', () => {
    newTask(['--verify', 'pnpm test']);
    const quality = { ...state().quality, reviewRounds: 1, phase: 'fix' };
    fs.writeFileSync(
      path.join(tasksRoot(root), NAME, 'state.json'),
      JSON.stringify({ ...state(), kind: 'general', quality })
    );
    run(['set', '--kind', 'code']);
    expect(state().quality).toMatchObject({ reviewRounds: 1, phase: 'fix' });
  });

  test('should respect --loop off when a task becomes a code task', () => {
    newTask(['--verify', 'pnpm test', '--kind', 'general']);
    run(['set', '--kind', 'code', '--loop', 'off']);
    expect(state()).toMatchObject({ kind: 'code', loop: { enabled: false } });
  });

  test('should keep the loop as is when an existing code task changes e2e', () => {
    newTask(['--verify', 'pnpm test']);
    run(['set', '--loop', 'off']);
    run(['set', '--kind', 'code', '--e2e', 'no']);
    expect(state()).toMatchObject({ e2e: 'no', loop: { enabled: false } });
  });

  test('should keep the kind of a task when only e2e changes', () => {
    newTask(['--verify', 'pnpm test', '--kind', 'general']);
    const { out } = run(['set', '--e2e', 'required']);
    expect(state()).toMatchObject({ kind: 'general', e2e: 'required' });
    expect(out).not.toContain('Coding task:');
  });

  test('should refuse to make a task without verify commands a code task', () => {
    newTask();
    expect(() => run(['set', '--kind', 'code'])).toThrow(
      /Fix: pnpm task set --verify "<test command>" --kind code/
    );
  });

  test('should reject an unknown kind', () => {
    newTask();
    expect(() => run(['set', '--kind', 'app'])).toThrow(/--kind must be/);
  });

  test('should accept verify and loop on in one call', () => {
    newTask();
    run(['set', '--verify', 'pnpm check', '--loop', 'on']);
    expect(state()).toMatchObject({
      verify: ['pnpm check'],
      loop: { enabled: true },
    });
  });

  test('should reject a bad --loop or --loop-max value', () => {
    newTask(['--verify', 'pnpm test']);
    expect(() => run(['set', '--loop', 'maybe'])).toThrow(
      '--loop must be on or off (got "maybe")'
    );
    expect(() => run(['set', '--loop-max', '0'])).toThrow(
      /--loop-max must be a whole number/
    );
  });
});

describe('template', () => {
  test('should create review and study files from templates', () => {
    newTask();
    expect(run(['template', 'review']).out).toBe(
      `Created tasks/${NAME}/reviews/REVIEW_demo.md — fill in every (…) placeholder.`
    );
    expect(read(path.join('reviews', 'REVIEW_demo.md'))).toMatch(
      /^# Review — demo\n\nDate: 2026-11-17/
    );
    const { out } = run([
      'template',
      'study',
      '--name',
      'api-limits',
      '--json',
    ]);
    expect(JSON.parse(out).file).toBe(
      `tasks/${NAME}/studies/STUDIES_api-limits.md`
    );
  });

  test('should refuse duplicates, bad names, and unknown kinds', () => {
    newTask();
    run(['template', 'review']);
    expect(() => run(['template', 'review'])).toThrow(/already exists/);
    expect(() => run(['template', 'study', '--name', 'Bad Name'])).toThrow(
      /Invalid --name/
    );
    expect(() => run(['template', 'memo'])).toThrow(
      /Usage: pnpm task template/
    );
    expect(() => run(['template'])).toThrow(/Usage: pnpm task template/);
  });
});

describe('done', () => {
  const finishSteps = () => {
    run(['step', 's1', 'done']);
    run(['step', 's2', 'done']);
  };

  test('should refuse open steps in any task unless forced', () => {
    newTask(['--kind', 'general']);
    run(['step', 's1', 'start']);
    expect(() => run(['done'])).toThrow(
      /^demo-261117 is not finished:\n- 2 step\(s\) not done: s1 \(in_progress\), s2 \(todo\)\. Fix: finish them/
    );
    expect(state().status).toBe('active');
    expect(run(['done', '--force']).out.split('\n')[0]).toBe(`Closed ${NAME}.`);
    expect(read('NOTES.md')).toContain(
      'Forced past: 2 step(s) not done: s1 (in_progress), s2 (todo).'
    );
  });

  test('should close a task without verify commands and clear the pointer', () => {
    newTask();
    finishSteps();
    expect(run(['done', '-m', 'All good.']).out.split('\n')[0]).toBe(
      `Closed ${NAME}.`
    );
    expect(state()).toMatchObject({ status: 'done', next: null });
    expect(readActive(root)).toBeNull();
    expect(read('NOTES.md')).toContain(
      '— tester (done)\n\nTask closed. All good.\nState:'
    );
  });

  test('should require a passing verify unless forced', () => {
    newTask(['--verify', 'pnpm test']);
    finishSteps();
    expect(() => run(['done'])).toThrow(/did not pass \(not run\)/);
    run(['verify'], { runCommands: fakeRunner([{ ok: false }]) });
    expect(() => run(['done'])).toThrow(/`pnpm test` failed/);
    expect(run(['done', '--force', '--json']).out).toContain('"ok": true');
  });

  test('should close a passing non-active task and keep the pointer', () => {
    newTask(['--verify', 'a', '--kind', 'general']);
    finishSteps();
    run(['verify']);
    legacyTask();
    run(['switch', 'old']);
    run(['done', NAME]);
    expect(state().status).toBe('done');
    expect(readActive(root)).toBe('old-251101');
  });

  test('should point a hand-written task at init', () => {
    legacyTask();
    expect(() => run(['done', 'old'])).toThrow(/pnpm task init old-251101/);
  });

  describe('code tasks', () => {
    const statePath = () => path.join(tasksRoot(root), NAME, 'state.json');
    /** @param {(s: any) => void} edit */
    const patch = (edit) => {
      const s = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
      edit(s);
      fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
    };
    const finding = (/** @type {object} */ fields) => ({
      id: 'r1-1',
      round: 1,
      file: 'app/a.js',
      line: 1,
      severity: 'high',
      claim: 'Leaks handle',
      scenario: 'open twice',
      verdict: 'CONFIRMED',
      reason: 'no close',
      step: null,
      ...fields,
    });
    const greenCode = () => {
      newTask(['--verify', 'pnpm test']);
      finishSteps();
      run(['verify']);
    };

    test('should refuse a code task that never had a review round', () => {
      greenCode();
      expect(() => run(['done'])).toThrow(
        /is not finished:\n- No review round ran\. Fix: pnpm task review/
      );
      expect(state().status).not.toBe('done');
    });

    test('should refuse an open round and unfixed confirmed findings', () => {
      greenCode();
      run(['step', 'add', 'fix: Leaks handle']);
      patch((s) => {
        s.quality.phase = 'review';
        s.quality.reviewRounds = 2;
        s.quality.findings = [
          finding({ step: 's3' }),
          finding({ id: 'r1-2', severity: 'must-fix' }),
          finding({ id: 'r1-3', severity: 'low' }),
          finding({ id: 'r1-4', verdict: 'REFUTED' }),
        ];
      });
      let message = '';
      try {
        run(['done']);
      } catch (error) {
        message = /** @type {Error} */ (error).message;
      }
      expect(message).toContain('Review round 2 is open but not recorded.');
      expect(message).toContain(
        '2 CONFIRMED must-fix/high finding(s) not fixed: r1-1 (step s3), r1-2.'
      );
      expect(message).not.toContain('No review round ran');
      // s3 is the fix step of r1-1: reported with the finding, not again as a step
      expect(message).not.toContain('step(s) not done');
      expect(message).toContain('pnpm task done --force');
    });

    test('should refuse e2e: required without an e2e verify command', () => {
      greenCode();
      run(['set', '--e2e', 'required']);
      patch((s) => {
        s.quality.reviewRounds = 1;
        s.quality.phase = 'complete';
      });
      expect(() => run(['done'])).toThrow(/e2e: required, but no verify/);
      run(['set', '--verify', 'pnpm test', '--verify', 'pnpm test:e2e']);
      run(['verify'], {
        runCommands: fakeRunner([{ ok: true }, { ok: true }]),
      });
      expect(run(['done']).out.split('\n')[0]).toBe(`Closed ${NAME}.`);
    });

    test('should close once a round is recorded and the fixes are done', () => {
      greenCode();
      run(['step', 'add', 'fix: Leaks handle']);
      patch((s) => {
        s.quality.reviewRounds = 1;
        s.quality.phase = 'complete';
        s.quality.findings = [finding({ step: 's3' })];
        s.steps[2].status = 'done';
      });
      expect(run(['done']).out.split('\n')[0]).toBe(`Closed ${NAME}.`);
      expect(read('NOTES.md')).not.toContain('Forced past');
    });

    test('should close with --force and log what it skipped', () => {
      greenCode();
      patch((s) => {
        delete s.quality;
      });
      expect(run(['done', '--force']).out.split('\n')[0]).toBe(
        `Closed ${NAME}.`
      );
      expect(read('NOTES.md')).toContain(
        'Task closed. Forced past: No review round ran.'
      );
    });
  });
});

describe('task memory', () => {
  const SECRET = `ghp_${'a1B2'.repeat(8)}`;
  const memory = () => loadNotes(memoryDir(root)).notes;
  const finishSteps = () => {
    run(['step', 's1', 'done']);
    run(['step', 's2', 'done']);
  };
  /** A git checkout named `web` for a task that works in another repo. */
  const webRepo = () => {
    const dir = path.join(root, 'web-checkout');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:me/web.git\n'
    );
    updateState(root, NAME, (s) => ({ ...s, repo: dir }), {
      now: NOW,
      agent: 'tester',
    });
  };

  test('done should save a task digest and announce it', () => {
    newTask();
    finishSteps();
    run([
      'note',
      '--done',
      'Shipped.',
      '--next',
      'Close.',
      '--open',
      'Docs later',
    ]);

    const { out } = run(['done', '-m', 'Released v1.']);

    expect(out.split('\n')).toEqual([
      `Closed ${NAME}.`,
      'Saved to memory: t1 (task digest) Ship it. Outcome: Released v1. Open: Docs later.',
    ]);
    expect(memory()[0]).toMatchObject({
      scope: 'machine',
      type: 'episode',
      tags: ['demo'],
      source: { via: 'digest', task: NAME },
    });
  });

  test('done --learn should save the lessons and list them in the digest', () => {
    newTask();
    finishSteps();

    run(['done', '--learn', 'The proxy blocks GraphQL.']);

    expect(memory().map((note) => [note.id, note.type])).toEqual([
      ['m1', 'fact'],
      ['t2', 'episode'],
    ]);
    expect(memory()[1].text).toBe(
      'Ship it. Learned: The proxy blocks GraphQL.'
    );
  });

  test('done should refuse a bad --learn line before closing', () => {
    newTask();
    finishSteps();

    expect(() => run(['done', '--learn', `token ${SECRET}`])).toThrow(
      /^--learn line 1: Refused: the note looks like it holds a secret/
    );
    expect(state().status).toBe('active');
  });

  test('closing a reopened task should replace its digest', () => {
    newTask();
    finishSteps();
    run(['done', '-m', 'v1']);
    run(['reopen', 'demo', '-m', 'one more fix']);

    const { out } = run(['done', '-m', 'v2']);

    expect(out.split('\n')[1]).toBe(
      'Updated memory: t1 (task digest, replaces the earlier one) Ship it. Outcome: v2.'
    );
    expect(memory()).toHaveLength(1);
  });

  test('done should name the repository of a task in another repo', () => {
    newTask();
    finishSteps();
    webRepo();

    run(['done']);

    expect(memory()[0]).toMatchObject({
      text: 'Ship it. Repo: web.',
      tags: ['demo', 'web'],
    });
  });

  test('done should say when saving to memory is off', () => {
    newTask();
    finishSteps();
    writeConfig(memoryDir(root), { ...DEFAULT_CONFIG, off: true });

    expect(run(['done']).out.split('\n')).toEqual([
      `Closed ${NAME}.`,
      'Memory saving is off everywhere: nothing was saved to memory (pnpm memory on).',
    ]);
    expect(memory()).toEqual([]);
  });

  test('done should report memory as JSON', () => {
    newTask();
    finishSteps();

    expect(JSON.parse(run(['done', '--json']).out)).toMatchObject({
      ok: true,
      task: NAME,
      memory: { digest: { action: 'added', note: { id: 't1' } }, learned: [] },
    });
  });

  test('note --learn should save each line with the task as the source', () => {
    newTask();

    const { out } = run([
      'note',
      '--done',
      'x',
      '--next',
      'y',
      '--learn',
      'Uploads take a minute.',
      '--learn',
      'The API needs a refresh token.',
    ]);

    expect(out.split('\n')).toEqual([
      `Appended a note to tasks/${NAME}/NOTES.md`,
      'Saved to memory: m1 (machine, fact) Uploads take a minute.',
      'Saved to memory: m2 (machine, fact) The API needs a refresh token.',
    ]);
    expect(memory()[0].source).toEqual({
      via: 'agent',
      harness: 'tester',
      task: NAME,
    });
  });

  test('note --learn should save repo facts for a task in another repo', () => {
    newTask();
    webRepo();

    run(['note', '-m', 'x', '--learn', 'Deploys run on tags.']);

    expect(memory()[0]).toMatchObject({ scope: 'repo', repo: 'web' });
  });

  test('note --learn should work for a hand-written task', () => {
    legacyTask();
    run(['switch', 'old']);

    run(['note', '-m', 'x', '--learn', 'Uses pnpm everywhere.']);

    expect(memory()[0]).toMatchObject({
      scope: 'machine',
      source: { task: 'old-251101' },
    });
  });

  test('note --learn should refuse a bad line before writing the note', () => {
    newTask();
    const before = read('NOTES.md');

    expect(() => run(['note', '-m', 'x', '--learn', '  '])).toThrow(
      '--learn line 1: The note text is empty.'
    );
    expect(read('NOTES.md')).toBe(before);
  });

  test('note --learn should report memory as JSON', () => {
    newTask();

    expect(
      JSON.parse(
        run(['note', '-m', 'x', '--learn', 'Uses pnpm.', '--json']).out
      )
    ).toMatchObject({
      ok: true,
      task: NAME,
      memory: { learned: [{ action: 'added' }] },
    });
  });

  test('note without --learn should leave memory alone', () => {
    newTask();

    run(['note', '-m', 'x']);

    expect(fs.existsSync(memoryDir(root))).toBe(false);
  });
});

describe('reopen', () => {
  const statePath = () => path.join(tasksRoot(root), NAME, 'state.json');
  /** @param {(s: any) => void} edit */
  const patch = (edit) => {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    edit(s);
    fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
  };
  /** A closed code task that had `rounds` review rounds. */
  const closedCode = (rounds = 2) => {
    newTask(['--verify', 'pnpm test']);
    run(['step', 's1', 'done']);
    run(['step', 's2', 'done']);
    run(['verify']);
    patch((s) => {
      s.quality.reviewRounds = rounds;
      s.quality.phase = 'complete';
      s.quality.reviewedDiff = 'old-print';
      s.quality.base = 'abc123';
      s.quality.nudged = 'old-nudge';
      s.loop.iteration = 3;
      s.loop.halted = true;
    });
    run(['done']);
  };
  const runGit = (/** @type {string[]} */ args) =>
    args[0] === 'rev-parse' ? 'f00dcafe' : null;

  test('should refuse without a reason', () => {
    closedCode();
    expect(() => run(['reopen', 'demo'])).toThrow(
      /Reopening a task needs a reason: -m "why" \(pnpm task reopen demo-261117 -m "…"\)/
    );
    expect(state().status).toBe('done');
  });

  test('should refuse a task that is not closed', () => {
    newTask();
    expect(() => run(['reopen', '-m', 'more'])).toThrow(
      /demo-261117 is not closed \(active\)\.\nFix: pnpm task switch demo-261117/
    );
  });

  test('should point a hand-written task at init', () => {
    legacyTask();
    expect(() => run(['reopen', 'old', '-m', 'more'])).toThrow(
      /pnpm task init old-251101/
    );
  });

  test('should need a name once the task is closed and no task is active', () => {
    closedCode();
    expect(() => run(['reopen', '-m', 'more'])).toThrow(/No active task/);
  });

  test('should make the task active again with a clean loop and no stale verify', () => {
    closedCode();
    const { out } = run(['reopen', 'demo', '-m', 'Store asked for changes'], {
      runGit,
    });
    expect(out).toBe(
      `Reopened ${NAME} (active task). Next: pnpm task step add "…" for the new work, then pnpm task next`
    );
    expect(state()).toMatchObject({
      status: 'active',
      next: null,
      lastVerify: null,
      startCommit: 'f00dcafe',
      branch: GIT.branch,
      loop: { enabled: true, iteration: 0, halted: false },
    });
    expect(readActive(root)).toBe(NAME);
    expect(read('NOTES.md')).toContain(
      '— tester (reopened)\n\nTask reopened: Store asked for changes\nState:'
    );
  });

  test('should continue the review rounds and allow new ones', () => {
    closedCode(2);
    run(['reopen', 'demo', '-m', 'follow-up'], { runGit });
    expect(state().quality).toMatchObject({
      phase: 'build',
      reviewRounds: 2,
      roundsBefore: 2,
      maxRounds: 4,
      reviewedDiff: null,
      base: null,
      nudged: null,
    });
  });

  test('should start the review rounds of a task closed before they existed', () => {
    closedCode();
    patch((s) => {
      delete s.quality;
    });
    run(['reopen', 'demo', '-m', 'old task']);
    expect(state().quality).toMatchObject({
      phase: 'build',
      reviewRounds: 0,
      roundsBefore: 0,
      maxRounds: 2,
    });
  });

  test('should bind the calling session to the reopened task', () => {
    closedCode();
    run(['new', 'other', '--goal', 'O', '--step', 'One']);
    run(['reopen', 'demo', '-m', 'more'], {
      env: { TASK_AGENT: 'tester', TASK_SESSION: 'sess-r' },
    });
    expect(readSession(root, 'sess-r')).toMatchObject({
      task: NAME,
      engaged: true,
    });
    expect(readActive(root)).toBe(NAME);
  });

  test('should print JSON', () => {
    closedCode();
    expect(
      JSON.parse(run(['reopen', 'demo', '-m', 'more', '--json']).out)
    ).toEqual({ ok: true, task: NAME, status: 'active' });
  });

  test('should keep a reopened code task open until a round runs after it', () => {
    closedCode(2);
    run(['reopen', 'demo', '-m', 'more']);
    run(['verify']);
    expect(() => run(['done'])).toThrow(
      /No review round ran since the task was reopened\. Fix: pnpm task review/
    );
    patch((s) => {
      s.quality.reviewRounds = 3;
      s.quality.phase = 'complete';
    });
    expect(run(['done']).out.split('\n')[0]).toBe(`Closed ${NAME}.`);
  });
});

test('COMMANDS should list every documented command', () => {
  expect(Object.keys(COMMANDS).sort()).toEqual(
    [
      'check',
      'claim',
      'done',
      'help',
      'init',
      'list',
      'new',
      'next',
      'reopen',
      'review',
      'rm',
      'note',
      'set',
      'status',
      'step',
      'switch',
      'template',
      'verify',
    ].sort()
  );
});

describe('claim', () => {
  test('should claim ready steps in order and exit 2 when none is left', () => {
    newTask();
    run(['step', 'add', 'Three', '--deps', 's1']);
    expect(run(['claim', '--agent', 'w1'])).toEqual({
      code: 0,
      out: 'Claimed s1. One for w1. When finished: pnpm task step s1 done -m "…" (give it back: pnpm task step s1 todo)',
    });
    expect(JSON.parse(run(['claim', '--agent', 'w2', '--json']).out)).toEqual(
      expect.objectContaining({
        ok: true,
        step: expect.objectContaining({ id: 's2', owner: 'w2' }),
        reason: null,
      })
    );
    expect(state().steps[1].claimedAt).toBe(NOW.toISOString());
    expect(run(['claim', '--agent', 'w3'])).toEqual({
      code: 2,
      out: 'Nothing to claim: in progress: s1 (w1), s2 (w2); waiting on dependencies: s3 (needs s1).',
    });
    expect(JSON.parse(run(['claim', '--json']).out)).toMatchObject({
      ok: false,
      step: null,
      reason: expect.stringContaining('in progress'),
    });
  });

  test('should claim a given step and refuse one another agent owns', () => {
    newTask();
    expect(run(['claim', 's2']).out).toContain('Claimed s2. Two for tester.');
    expect(() => run(['claim', 's2', '--agent', 'other'])).toThrow(
      /already claimed by tester/
    );
    expect(() => run(['step', 's2', 'start', '--agent', 'other'])).toThrow(
      /already claimed by tester/
    );
    run(['step', 's2', 'start', '--agent', 'other', '--force']);
    expect(state().steps[1].owner).toBe('other');
    run(['step', 's2', 'todo']);
    expect(state().steps[1]).toMatchObject({ status: 'todo', owner: null });
  });

  test('should never hand one step to two concurrent processes', async () => {
    run([
      'new',
      'demo',
      '--goal',
      'G',
      ...Array.from({ length: 4 }, (_, i) => ['--step', `S${i + 1}`]).flat(),
    ]);
    const cli = new URL('../cli.js', import.meta.url).href;
    const script = `import { main } from ${JSON.stringify(cli)};
const code = main({ argv: ['claim', '--json', '--agent', process.argv[1]], deps: { rootDir: process.argv[2], log: (m) => process.stdout.write(m) } });
process.exitCode = code;`;
    const { spawn } = await import('child_process');
    const workers = Array.from(
      { length: 6 },
      (_, i) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--input-type=module', '-e', script, `w${i}`, root],
            { stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let out = '';
          let err = '';
          child.stdout.on('data', (chunk) => (out += chunk));
          child.stderr.on('data', (chunk) => (err += chunk));
          child.on('error', reject);
          child.on('close', (code) =>
            resolve({ code, err, result: out ? JSON.parse(out) : null })
          );
        })
    );
    const results =
      /** @type {Array<{ code: number, err: string, result: { step: { id: string, owner: string } | null } }>} */ (
        await Promise.all(workers)
      );
    // A crashed worker prints nothing on stdout: show why.
    expect(results.map((r) => r.err).filter(Boolean)).toEqual([]);
    const claimed = results
      .filter((r) => r.code === 0)
      .map((r) => r.result.step?.id);
    expect(claimed.sort()).toEqual(['s1', 's2', 's3', 's4']);
    expect(results.filter((r) => r.code === 2)).toHaveLength(2);
    const owners = state().steps.map((s) => s.owner);
    expect(new Set(owners).size).toBe(4);
    expect(owners.every((o) => o && /^w\d$/.test(o))).toBe(true);
  }, 20_000);
});
