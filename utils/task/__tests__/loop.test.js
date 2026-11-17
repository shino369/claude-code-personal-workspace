import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { main } from '../cli.js';
import {
  INNER_LOOP_ENV,
  INNER_VERIFY_TIMEOUT_MS,
  MAX_ITERATIONS,
  STALL_LIMIT,
  FRESH_LOOP,
  decideInner,
  failureSignature,
  innerCommands,
  normalizeFailure,
  parseMax,
  resetInnerLoop,
  runInnerLoop,
} from '../loop.js';
import { createState } from '../state.js';
import { TEMPLATES_DIR, loadTask, writeActive } from '../store.js';

const NOW = new Date(2026, 10, 17, 9, 30);
const GIT = { branch: 'feat/x', changed: 1, diffStat: null };
const NAME = 'demo-261117';

/** @param {Partial<import('../state.js').VerifyResult>} [overrides] */
const fail = (overrides = {}) => ({
  at: NOW.toISOString(),
  ok: false,
  failed: 'pnpm test',
  summary: 'FAIL a.test.js > adds\nexpected 3, received 4',
  ...overrides,
});
const pass = () => ({
  at: NOW.toISOString(),
  ok: true,
  failed: null,
  summary: '1 command(s) passed',
});

/** @param {Partial<import('../state.js').TaskState['loop']>} [loop] */
function makeState(loop = {}) {
  const state = createState({
    name: NAME,
    goal: 'Ship it',
    steps: [],
    verify: ['pnpm test'],
    verifyFast: [],
    now: NOW,
  });
  return { ...state, loop: { ...state.loop, enabled: true, ...loop } };
}

describe('normalizeFailure', () => {
  test('should mask timestamps, clock times, and durations', () => {
    expect(
      normalizeFailure(
        'failed at 17:30:34 on 2026-11-17T08:30:34.120Z\ntook 829ms (tests 1.5 s)  \n'
      )
    ).toBe('failed at <time> on <date>\ntook <dur> (tests <dur>)\n');
  });

  test('should drop color codes and timing lines from test runners', () => {
    const run = (/** @type {string} */ breakdown) =>
      normalizeFailure(
        `\x1b[31m×\x1b[39m adds\x1b[32m 3\x1b[2mms\x1b[22m\n   Start at  17:53:17\n   Duration  81ms (${breakdown})\nTime:        1.2 s\nAssertionError: expected 1 to be 2`
      );
    expect(run('import 27%, tests 24%')).toBe(
      '× adds <dur>\n\n\n\nAssertionError: expected 1 to be 2'
    );
    expect(run('import 30%, worker 26%, environment 1%')).toBe(
      run('import 27%, tests 24%')
    );
  });

  test('should keep counts that signal progress', () => {
    expect(normalizeFailure('3 failed | 2 passed')).toBe('3 failed | 2 passed');
  });
});

describe('failureSignature', () => {
  test('should be null for a missing or passing verify', () => {
    expect(failureSignature(null)).toBeNull();
    expect(failureSignature(undefined)).toBeNull();
    expect(failureSignature(pass())).toBeNull();
  });

  test('should match failures that differ only by timing', () => {
    expect(failureSignature(fail({ summary: 'x failed in 12ms' }))).toBe(
      failureSignature(fail({ summary: 'x failed in 40ms' }))
    );
  });

  test('should differ when the failing command or output differs', () => {
    const base = failureSignature(fail());
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(failureSignature(fail({ failed: 'pnpm lint' }))).not.toBe(base);
    expect(failureSignature(fail({ summary: 'other' }))).not.toBe(base);
  });
});

describe('parseMax', () => {
  test('should accept whole numbers from 1 to the limit', () => {
    expect(parseMax('1', '--max')).toBe(1);
    expect(parseMax(String(MAX_ITERATIONS), '--max')).toBe(MAX_ITERATIONS);
  });

  test.each(['0', '-2', '2.5', 'abc', String(MAX_ITERATIONS + 1)])(
    'should reject %s',
    (value) => {
      expect(() => parseMax(value, '--loop-max')).toThrow(
        `--loop-max must be a whole number from 1 to ${MAX_ITERATIONS}`
      );
    }
  );
});

describe('innerCommands', () => {
  test('should prefer the fast subset and fall back to verify', () => {
    const state = makeState();
    expect(innerCommands(state)).toEqual(['pnpm test']);
    expect(innerCommands({ ...state, verifyFast: ['pnpm lint'] })).toEqual([
      'pnpm lint',
    ]);
  });
});

describe('decideInner', () => {
  test('should allow the stop and reset the loop when verify passes', () => {
    const decision = decideInner({
      state: makeState({
        iteration: 3,
        signature: 'abc',
        repeats: 1,
        halted: true,
      }),
      verify: pass(),
    });
    expect(decision).toMatchObject({
      action: 'allow',
      message: `✓ task verify passed (${NAME})`,
      loop: { enabled: true, ...FRESH_LOOP },
    });
  });

  test('should block with the failure and count the iteration', () => {
    const decision = decideInner({
      state: makeState({ iteration: 1 }),
      verify: fail(),
    });
    expect(decision.action).toBe('block');
    expect(decision.reason).toContain(
      'Task verify failed (task loop iteration 2/5): `pnpm test`'
    );
    expect(decision.reason).toContain('expected 3, received 4');
    expect(decision.reason).toContain('the Stop hook re-runs: pnpm test');
    expect(decision.reason).toContain(
      'If it cannot be fixed in code (a git, install, or environment error), do not retry'
    );
    expect(decision.loop).toMatchObject({
      iteration: 2,
      signature: failureSignature(fail()),
      repeats: 0,
    });
  });

  test('should halt at the cap, pause the loop, and leave a note', () => {
    const decision = decideInner({
      state: makeState({ iteration: 5 }),
      verify: fail(),
    });
    expect(decision).toMatchObject({
      action: 'allow',
      message: `Task loop stopped: verify still fails after 5 iteration(s). The loop is paused until your next prompt; see tasks/${NAME}/NOTES.md.`,
      loop: { iteration: 5, halted: true },
    });
    expect(decision.note).toBe(
      'Inner loop stopped at the cap (5). `pnpm test` still fails.'
    );
  });

  test('should count repeats of the same failure and halt on no progress', () => {
    const signature = failureSignature(fail());
    const once = decideInner({
      state: makeState({ iteration: 1, signature }),
      verify: fail(),
    });
    expect(once).toMatchObject({ action: 'block', loop: { repeats: 1 } });

    const stalled = decideInner({
      state: makeState({ iteration: 2, signature, repeats: 1 }),
      verify: fail(),
    });
    expect(stalled).toMatchObject({
      action: 'allow',
      loop: { repeats: STALL_LIMIT, halted: true },
    });
    expect(stalled.message).toContain(
      'Task loop stopped: no progress (the same failure 3 times in a row).'
    );
    expect(stalled.note).toContain('iteration 2/5');
  });

  test('should start the repeat count over when the failure changes', () => {
    const decision = decideInner({
      state: makeState({ iteration: 2, signature: 'old', repeats: 1 }),
      verify: fail(),
    });
    expect(decision).toMatchObject({ action: 'block', loop: { repeats: 0 } });
  });
});

describe('runInnerLoop', () => {
  /** @type {string} */
  let root;
  /** @type {string[]} */
  let logs;

  /** @param {Partial<import('../deps.js').Deps>} [overrides] */
  const deps = (overrides = {}) => ({
    rootDir: root,
    templatesDir: TEMPLATES_DIR,
    env: {},
    now: () => NOW,
    log: (/** @type {string} */ message) => logs.push(message),
    git: () => GIT,
    runCommands: vi.fn(() => [
      {
        command: 'pnpm test',
        ok: false,
        code: 1,
        durationMs: 5,
        output: 'expected 3, received 4',
      },
    ]),
    ...overrides,
  });

  /** @param {string[]} argv */
  const cli = (argv) =>
    main({ argv, deps: deps({ env: { TASK_AGENT: 't' } }) });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-loop-'));
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('should skip when the outer loop turned the inner loop off', () => {
    const runCommands = vi.fn();
    expect(
      runInnerLoop({
        deps: deps({ env: { [INNER_LOOP_ENV]: 'off' }, runCommands }),
      })
    ).toEqual({ action: 'skip' });
    expect(runCommands).not.toHaveBeenCalled();
  });

  test('should skip when no task is active', () => {
    expect(runInnerLoop({ deps: deps() })).toEqual({
      action: 'skip',
    });
  });

  test('should skip a hand-written task without state.json', () => {
    const dir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.md'), 'Goal: G\n');
    writeActive(root, NAME);
    expect(runInnerLoop({ deps: deps() })).toEqual({
      action: 'skip',
    });
  });

  test('should skip when the loop is off or the task is done', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    const runCommands = vi.fn();
    expect(runInnerLoop({ deps: deps({ runCommands }) })).toEqual({
      action: 'skip',
    });

    cli(['set', '--loop', 'on']);
    cli(['done', '--force', '--task', NAME]);
    writeActive(root, NAME);
    expect(runInnerLoop({ deps: deps({ runCommands }) })).toEqual({
      action: 'skip',
    });
    expect(runCommands).not.toHaveBeenCalled();
  });

  test('should allow the stop with a fix hint when there are no verify commands', () => {
    cli(['new', 'demo', '--goal', 'G']);
    const dir = path.join(root, 'tasks', NAME);
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, 'state.json'), 'utf-8')
    );
    state.loop.enabled = true;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));

    expect(runInnerLoop({ deps: deps() })).toEqual({
      action: 'allow',
      message: `Task loop is on for ${NAME} but it has no verify commands. Fix: pnpm task set --verify "pnpm check"`,
    });
  });

  test('should block on a failure and record lastVerify and the iteration', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm check']);
    cli([
      'set',
      '--verify-fast',
      'pnpm test',
      '--loop',
      'on',
      '--loop-max',
      '2',
    ]);
    const runCommands = deps().runCommands;

    const decision = runInnerLoop({
      deps: deps({ runCommands }),
    });

    expect(decision.action).toBe('block');
    expect(runCommands).toHaveBeenCalledWith({
      commands: ['pnpm test'],
      cwd: root,
      timeoutMs: INNER_VERIFY_TIMEOUT_MS,
    });
    const { state } = loadTask(root, NAME);
    expect(state?.lastVerify).toMatchObject({ ok: false, failed: 'pnpm test' });
    expect(state?.loop).toMatchObject({ enabled: true, iteration: 1, max: 2 });
    expect(state?.lastAgent).toBe('claude');
  });

  test('should write a NOTES entry when it stops at the cap', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on', '--loop-max', '1']);
    const env = { TASK_AGENT: 'dsh' };

    expect(runInnerLoop({ deps: deps({ env }) }).action).toBe('block');
    const second = runInnerLoop({ deps: deps({ env }) });

    expect(second.action).toBe('allow');
    const notes = fs.readFileSync(
      path.join(root, 'tasks', NAME, 'NOTES.md'),
      'utf-8'
    );
    expect(notes).toContain('— dsh (auto: inner loop)');
    expect(notes).toContain('Inner loop stopped at the cap (1).');
    expect(notes).toContain('State: branch feat/x');
    expect(notes).toContain('; verify fail');
  });

  test('should allow the stop and reset the count when verify passes', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on']);
    const runCommands = vi.fn(() => [
      { command: 'pnpm test', ok: true, code: 0, durationMs: 1, output: '' },
    ]);

    const decision = runInnerLoop({
      deps: deps({ runCommands }),
    });

    expect(decision).toMatchObject({ action: 'allow' });
    expect(loadTask(root, NAME).state?.loop.iteration).toBe(0);
    expect(loadTask(root, NAME).state?.lastVerify?.ok).toBe(true);
  });
  test('should skip verify entirely once the loop has halted', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on', '--loop-max', '1']);
    runInnerLoop({ deps: deps() });
    expect(runInnerLoop({ deps: deps() }).action).toBe('allow');
    const runCommands = vi.fn();

    expect(runInnerLoop({ deps: deps({ runCommands }) })).toEqual({
      action: 'skip',
    });
    expect(runCommands).not.toHaveBeenCalled();
    expect(loadTask(root, NAME).state?.loop.halted).toBe(true);
  });

  test('should never reset the count on its own, however many stops', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on', '--loop-max', '3']);
    let count = 0;
    /** @type {string[]} */
    const actions = [];
    for (let i = 0; i < 10; i += 1) {
      const runCommands = vi.fn(() => [
        {
          command: 'pnpm test',
          ok: false,
          code: 1,
          durationMs: 1,
          output: `different failure ${(count += 1)}`,
        },
      ]);
      actions.push(runInnerLoop({ deps: deps({ runCommands }) }).action);
    }
    expect(actions).toEqual([
      'block',
      'block',
      'block',
      'allow',
      ...Array(6).fill('skip'),
    ]);
  });
});

describe('resetInnerLoop', () => {
  /** @type {string} */
  let root;

  /** @param {Partial<import('../deps.js').Deps>} [overrides] */
  const deps = (overrides = {}) => ({
    rootDir: root,
    templatesDir: TEMPLATES_DIR,
    env: {},
    now: () => NOW,
    log: () => {},
    git: () => GIT,
    runCommands: vi.fn(() => [
      { command: 'pnpm test', ok: false, code: 1, durationMs: 1, output: 'x' },
    ]),
    ...overrides,
  });
  /** @param {string[]} argv */
  const cli = (argv) => main({ argv, deps: deps() });
  const halt = () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on', '--loop-max', '1']);
    runInnerLoop({ deps: deps() });
    runInnerLoop({ deps: deps() });
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-reset-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('should reset the count and un-halt on a typed prompt', () => {
    halt();
    expect(resetInnerLoop({ deps: deps(), prompt: '  please continue' })).toBe(
      true
    );
    expect(loadTask(root, NAME).state?.loop).toMatchObject({
      enabled: true,
      max: 1,
      ...FRESH_LOOP,
    });
  });

  test.each([
    ['a task notification', '<task-notification>done</task-notification>'],
    ['an empty prompt', '   '],
    ['a missing prompt', undefined],
  ])('should not reset on %s', (_label, prompt) => {
    halt();
    expect(resetInnerLoop({ deps: deps(), prompt })).toBe(false);
    expect(loadTask(root, NAME).state?.loop.halted).toBe(true);
  });

  test('should do nothing when no loop applies or the count is already fresh', () => {
    expect(resetInnerLoop({ deps: deps(), prompt: 'hi' })).toBe(false);
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    expect(resetInnerLoop({ deps: deps(), prompt: 'hi' })).toBe(false);
    cli(['set', '--loop', 'on']);
    expect(resetInnerLoop({ deps: deps(), prompt: 'hi' })).toBe(false);
  });

  test('should reset after a failure that did not halt yet', () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on']);
    runInnerLoop({ deps: deps() });
    expect(resetInnerLoop({ deps: deps(), prompt: 'hi' })).toBe(true);
    expect(loadTask(root, NAME).state?.loop.iteration).toBe(0);
  });
});
