import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  COMMANDS,
  HELP,
  detectAgent,
  listTasks,
  main,
  parseArgs,
  sessionBrief,
  stateLine,
} from '../cli.js';
import { TEMPLATES_DIR, loadTask, readActive, tasksRoot } from '../store.js';

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
      `* ${NAME}  [active]  updated 2026-11-17 09:30  next: s1. One`
    );
    expect(lines[1]).toMatch(
      /^ {2}old-251101 {2}\[active, no state\.json\].*next: b$/
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
    expect(run(['status']).out).toContain(`[Task] ${NAME} — active`);
    expect(JSON.parse(run(['status', '--json']).out).name).toBe(NAME);
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
      mergeBase: 'abc',
      files: ['utils/x.js'],
    });
    expect(state().quality?.base).toBe('main');
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
      `Created ${path.join('tasks', NAME, 'reviews', 'REVIEW_demo.md')} — fill in every (…) placeholder.`
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
      path.join('tasks', NAME, 'studies', 'STUDIES_api-limits.md')
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
  test('should close a task without verify commands and clear the pointer', () => {
    newTask();
    expect(run(['done', '-m', 'All good.']).out).toBe(`Closed ${NAME}.`);
    expect(state()).toMatchObject({ status: 'done', next: null });
    expect(readActive(root)).toBeNull();
    expect(read('NOTES.md')).toContain(
      '— tester (done)\n\nTask closed. All good.\nState:'
    );
  });

  test('should require a passing verify unless forced', () => {
    newTask(['--verify', 'pnpm test']);
    expect(() => run(['done'])).toThrow(/did not pass \(not run\)/);
    run(['verify'], { runCommands: fakeRunner([{ ok: false }]) });
    expect(() => run(['done'])).toThrow(/`pnpm test` failed/);
    expect(run(['done', '--force', '--json']).out).toContain('"ok": true');
  });

  test('should close a passing non-active task and keep the pointer', () => {
    newTask(['--verify', 'a', '--kind', 'general']);
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
      run(['verify']);
    };

    test('should refuse a code task that never had a review round', () => {
      greenCode();
      expect(() => run(['done'])).toThrow(
        /code task and its quality loop is not finished:\n- No review round ran\. Fix: pnpm task review/
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
      expect(run(['done']).out).toBe(`Closed ${NAME}.`);
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
      expect(run(['done']).out).toBe(`Closed ${NAME}.`);
      expect(read('NOTES.md')).not.toContain('Forced past');
    });

    test('should close with --force and log what it skipped', () => {
      greenCode();
      patch((s) => {
        delete s.quality;
      });
      expect(run(['done', '--force']).out).toBe(`Closed ${NAME}.`);
      expect(read('NOTES.md')).toContain(
        'Task closed. Forced past: No review round ran.'
      );
    });
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
      'review',
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
          child.stdout.on('data', (chunk) => (out += chunk));
          child.on('error', reject);
          child.on('close', (code) =>
            resolve({ code, result: JSON.parse(out) })
          );
        })
    );
    const results =
      /** @type {Array<{ code: number, result: { step: { id: string, owner: string } | null } }>} */ (
        await Promise.all(workers)
      );
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
