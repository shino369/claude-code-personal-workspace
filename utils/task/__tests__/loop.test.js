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
  scopeFingerprint,
  workPrint,
} from '../loop.js';
import { createState } from '../state.js';
import { TEMPLATES_DIR, loadTask, updateState, writeActive } from '../store.js';

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
    runCheck: vi.fn(),
    runGit: vi.fn(),
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

  describe('quality loop (code tasks)', () => {
    const passing = () =>
      vi.fn(({ commands }) =>
        commands.map((/** @type {string} */ command) => ({
          command,
          ok: true,
          code: 0,
          durationMs: 1,
          output: '',
        }))
      );
    /** A git scope with one changed file whose content the test controls. */
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' ? 'abc' : args[0] === 'diff' ? 'lib.js' : ''
    );
    const stop = () =>
      runInnerLoop({ deps: deps({ runCommands: passing(), runGit }) });
    const quality = () => loadTask(root, NAME).state?.quality;

    test('should block once to ask for a review, then let the stop through', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      fs.writeFileSync(path.join(root, 'lib.js'), 'v1');

      const first = stop();
      expect(first.action).toBe('block');
      expect(first.reason).toContain('run review round 1/2');
      expect(quality()?.nudged).toMatch(/^review round 1:r0:[0-9a-f]{16}:$/);
      expect(loadTask(root, NAME).state?.lastVerify?.ok).toBe(true);

      expect(stop()).toMatchObject({
        action: 'allow',
        message: expect.stringContaining('reminded once already'),
      });

      fs.writeFileSync(path.join(root, 'lib.js'), 'v2');
      expect(stop().action).toBe('block');
    });

    test('should complete the loop and write a NOTES entry', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      fs.writeFileSync(path.join(root, 'lib.js'), 'v1');
      const state = /** @type {import('../state.js').TaskState} */ (
        loadTask(root, NAME).state
      );
      const file = path.join(root, 'tasks', NAME, 'state.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...state,
          quality: { ...state.quality, phase: 'fix', reviewRounds: 2 },
        })
      );

      expect(stop()).toMatchObject({
        action: 'allow',
        message: `✓ quality loop complete for ${NAME} (2 review round(s)).`,
      });
      expect(quality()?.phase).toBe('complete');
      const notes = fs.readFileSync(
        path.join(root, 'tasks', NAME, 'NOTES.md'),
        'utf-8'
      );
      expect(notes).toContain('auto: quality loop');
      expect(notes).toContain('verify pass');
    });

    test('should let the stop through when git cannot give a merge base', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      const result = runInnerLoop({
        deps: deps({ runCommands: passing(), runGit: () => null }),
      });
      expect(result).toMatchObject({ action: 'allow' });
      expect(quality()?.phase).toBe('build');
    });

    test('should fingerprint a code state that has no quality yet', () => {
      fs.writeFileSync(path.join(root, 'lib.js'), 'v1');
      const { quality: _q, ...state } = createState({
        name: NAME,
        goal: 'G',
        kind: 'code',
      });
      expect(
        scopeFingerprint(deps({ runGit }), path.join(root, 'none'), state)
      ).toMatch(/^[0-9a-f]{16}$/);
    });

    test('should give no fingerprint when nothing is in scope', () => {
      const state = createState({ name: NAME, goal: 'G', kind: 'code' });
      expect(
        scopeFingerprint(
          deps({ runGit: (args) => (args[0] === 'merge-base' ? 'abc' : '') }),
          path.join(root, 'none'),
          state
        )
      ).toBeNull();
    });

    test('should leave general tasks to the plain inner loop', () => {
      cli([
        'new',
        'demo',
        '--goal',
        'G',
        '--verify',
        'pnpm test',
        '--kind',
        'general',
      ]);
      cli(['set', '--loop', 'on']);
      expect(stop()).toMatchObject({
        action: 'allow',
        message: `✓ task verify passed (${NAME})`,
      });
      expect(quality()).toBeUndefined();
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
    cli([
      'new',
      'demo',
      '--goal',
      'G',
      '--verify',
      'pnpm test',
      '--kind',
      'general',
    ]);
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

  describe('changes made while verify runs', () => {
    /**
     * A verify (failing unless `ok`) during which another agent changes the
     * task.
     *
     * @param {(state: import('../state.js').TaskState) => import('../state.js').TaskState} change
     * @param {boolean} [ok]
     */
    const failingWhile = (change, ok = false) =>
      vi.fn(() => {
        updateState(root, NAME, change);
        return [
          {
            command: 'pnpm test',
            ok,
            code: ok ? 0 : 1,
            durationMs: 5,
            output: ok ? '' : 'expected 3, received 4',
          },
        ];
      });

    test('should not turn a loop back on that was turned off during verify', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      const runCommands = failingWhile((s) => ({
        ...s,
        loop: { ...s.loop, enabled: false },
      }));

      const decision = runInnerLoop({ deps: deps({ runCommands }) });

      expect(decision.action).toBe('skip');
      const { state } = loadTask(root, NAME);
      expect(state?.loop.enabled).toBe(false);
      expect(state?.lastVerify?.ok).toBe(false);
    });

    test('should keep a review recorded during a passing verify', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      const runCommands = failingWhile(
        (s) => ({
          ...s,
          quality: {
            .../** @type {import('../quality.js').Quality} */ (s.quality),
            phase: 'complete',
            reviewRounds: 1,
          },
        }),
        true
      );

      runInnerLoop({ deps: deps({ runCommands }) });

      expect(loadTask(root, NAME).state?.quality).toMatchObject({
        phase: 'complete',
        reviewRounds: 1,
      });
    });

    test('should not block a task closed during verify', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      const runCommands = failingWhile((s) => ({ ...s, status: 'done' }));

      expect(runInnerLoop({ deps: deps({ runCommands }) }).action).toBe('skip');
    });

    test('should count from the iteration on disk, not the one read before verify', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      const runCommands = failingWhile((s) => ({
        ...s,
        loop: { ...s.loop, iteration: 3 },
      }));

      const decision = runInnerLoop({ deps: deps({ runCommands }) });

      expect(decision.reason).toContain('task loop iteration 4/5');
      expect(loadTask(root, NAME).state?.loop.iteration).toBe(4);
    });
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

  test("should take a note's git state from the task's repository", () => {
    cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
    cli(['set', '--loop', 'on', '--loop-max', '1']);
    const repo = path.resolve(root, '..', 'other-repo');
    updateState(root, NAME, (s) => ({ ...s, repo }));
    const git = (/** @type {string} */ cwd) =>
      cwd === repo ? { ...GIT, branch: 'feat/r' } : GIT;

    runInnerLoop({ deps: deps({ git }) });
    runInnerLoop({ deps: deps({ git }) });

    expect(
      fs.readFileSync(path.join(root, 'tasks', NAME, 'NOTES.md'), 'utf-8')
    ).toContain('State: branch feat/r');
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
  describe('unchanged work', () => {
    /** A git that reports a fixed tree; `diff` is what the test changes. */
    const tree = { diff: 'diff-1', untracked: 'new.js' };
    /** @type {import('../review.js').RunGit} */
    const runGit = (args) =>
      ({
        'rev-parse': 'head1',
        status: '?? new.js',
        diff: tree.diff,
        'ls-files': tree.untracked,
      })[args[0]] ?? null;
    const passing = () =>
      vi.fn(({ commands }) =>
        commands.map((/** @type {string} */ command) => ({
          command,
          ok: true,
          code: 0,
          durationMs: 1,
          output: '',
        }))
      );

    beforeEach(() => {
      tree.diff = 'diff-1';
      tree.untracked = 'new.js';
      fs.writeFileSync(path.join(root, 'new.js'), 'v1');
    });

    test('should not re-run a passing verify when nothing changed', () => {
      cli([
        'new',
        'demo',
        '--goal',
        'G',
        '--verify',
        'pnpm test',
        '--kind',
        'general',
      ]);
      cli(['set', '--loop', 'on']);
      const runCommands = passing();
      expect(
        runInnerLoop({ deps: deps({ runGit, runCommands }) })
      ).toMatchObject({
        action: 'allow',
        message: `✓ task verify passed (${NAME})`,
      });

      const second = runInnerLoop({ deps: deps({ runGit, runCommands }) });

      expect(second).toMatchObject({ action: 'allow', message: undefined });
      expect(runCommands).toHaveBeenCalledTimes(1);
    });

    test('should re-run verify after a tracked or untracked change', () => {
      cli([
        'new',
        'demo',
        '--goal',
        'G',
        '--verify',
        'pnpm test',
        '--kind',
        'general',
      ]);
      cli(['set', '--loop', 'on']);
      const runCommands = passing();
      const stop = () => runInnerLoop({ deps: deps({ runGit, runCommands }) });
      stop();
      tree.diff = 'diff-2';
      stop();
      fs.writeFileSync(path.join(root, 'new.js'), 'v2, longer');
      stop();
      expect(runCommands).toHaveBeenCalledTimes(3);
    });

    test('should always re-run a failing verify', () => {
      cli(['new', 'demo', '--goal', 'G', '--verify', 'pnpm test']);
      const runCommands = deps().runCommands;
      runInnerLoop({ deps: deps({ runGit, runCommands }) });
      runInnerLoop({ deps: deps({ runGit, runCommands }) });
      expect(runCommands).toHaveBeenCalledTimes(2);
    });
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
    runCheck: vi.fn(),
    runGit: vi.fn(),
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

describe('workPrint', () => {
  /** @type {string} */
  let root;
  /** @type {Record<string, string | null>} */
  let outputs;
  /** @type {Array<[string[], string]>} */
  let calls;
  /** @type {import('../review.js').RunGit} */
  const runGit = (args, cwd) => {
    calls.push([args, cwd]);
    return outputs[args[0]] ?? null;
  };
  const print = (
    /** @type {Partial<import('../state.js').TaskState>} */ extra = {}
  ) =>
    workPrint(
      /** @type {any} */ ({ rootDir: root, runGit }),
      { ...makeState(), ...extra },
      path.join(root, 'tasks', NAME)
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-print-'));
    fs.mkdirSync(path.join(root, 'tasks', NAME, 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', NAME, 'app', 'a.js'), 'v1');
    outputs = {
      'rev-parse': 'head1',
      status: '',
      diff: '',
      'ls-files': 'gone.js',
    };
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('should be stable for the same work', () => {
    expect(print()).toMatch(/^[0-9a-f]{16}$/);
    expect(print()).toBe(print());
  });

  test('should change with the verify commands and the task code', () => {
    const first = print();
    expect(print({ verify: ['pnpm other'] })).not.toBe(first);
    fs.writeFileSync(path.join(root, 'tasks', NAME, 'app', 'a.js'), 'v2');
    expect(print()).not.toBe(first);
  });

  test('should be null when git cannot answer', () => {
    outputs.diff = null;
    expect(print()).toBeNull();
  });

  test("should include the task's repository", () => {
    const repo = path.join(root, 'other');
    print({ repo });
    expect(calls.map(([, cwd]) => cwd)).toContain(repo);
    expect(calls.map(([, cwd]) => cwd)).toContain(root);
  });

  test('should work for a task folder that is gone', () => {
    fs.rmSync(path.join(root, 'tasks', NAME), { recursive: true });
    expect(print()).toMatch(/^[0-9a-f]{16}$/);
  });
});
