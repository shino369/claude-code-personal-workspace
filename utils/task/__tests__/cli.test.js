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
});

describe('set', () => {
  test('should replace the goal and verify lists', () => {
    newTask(['--verify', 'old']);
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
    newTask(['--verify', 'pnpm test']);
    run(['set', '--loop-max', '7']);
    expect(state().loop).toMatchObject({ enabled: false, max: 7 });
    run(['set', '--loop', 'on']);
    run(['set', '--loop', 'off']);
    expect(state().loop).toMatchObject({ enabled: false, max: 7 });
  });

  test('should refuse to turn the loop on without verify commands', () => {
    newTask();
    expect(() => run(['set', '--loop', 'on'])).toThrow(
      /no verify commands, so the loop has no finish line\.\nFix: pnpm task set --verify "pnpm check" --loop on/
    );
    expect(state().loop.enabled).toBe(false);
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
    newTask(['--verify', 'a']);
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
});

test('COMMANDS should list every documented command', () => {
  expect(Object.keys(COMMANDS).sort()).toEqual(
    [
      'claim',
      'done',
      'help',
      'init',
      'list',
      'new',
      'next',
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
