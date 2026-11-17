import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { createState } from '../../task/state.js';
import { loadTask, saveState, tasksRoot } from '../../task/store.js';
import { buildCommand } from '../adapters.js';
import {
  OUTPUT_TAIL_LINES,
  buildPrompt,
  fingerprint,
  formatIterationLog,
  runLoop,
} from '../driver.js';

const NAME = 'demo-261117';
const NOW = new Date(2026, 10, 17, 9, 30, 5);
const COMMAND = buildCommand({ agent: 'codex' });

/** @type {string} */
let root;

/** @param {Partial<import('../../task/state.js').TaskState>} [overrides] */
function seedTask(overrides = {}) {
  const dir = path.join(tasksRoot(root), NAME);
  fs.mkdirSync(dir, { recursive: true });
  saveState(dir, {
    ...createState({
      name: NAME,
      goal: 'Fix the bug',
      verify: ['pnpm test'],
      now: NOW,
    }),
    ...overrides,
  });
  return dir;
}

/**
 * Verify outcomes in order: true = pass, a string = failure output.
 *
 * @param {Array<true | string>} outcomes
 */
function verifySequence(outcomes) {
  let call = 0;
  return vi.fn(
    /** @param {{ commands: string[] }} options */
    ({ commands }) => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
      return [
        {
          command: commands[0],
          ok: outcome === true,
          code: outcome === true ? 0 : 1,
          durationMs: 5,
          output: outcome === true ? 'ok' : outcome,
        },
      ];
    }
  );
}

/**
 * @param {{ outcomes: Array<true | string>, prints?: Array<string | null>, clock?: () => number }} options
 * @returns {import('../driver.js').LoopDeps & { logs: string[] }}
 */
function makeDeps({ outcomes, prints, clock = () => 0 }) {
  let print = 0;
  /** @type {string[]} */
  const logs = [];
  return {
    logs,
    clock,
    date: () => NOW,
    env: { HOME: '/home/t' },
    log: (message) => logs.push(message),
    git: () => ({
      branch: 'loop/demo',
      changed: 1,
      diffStat: '1 file changed',
    }),
    fingerprint: vi.fn(() =>
      prints ? prints[Math.min(print++, prints.length - 1)] : `fp-${print++}`
    ),
    runAgent: vi.fn(() => ({
      code: 0,
      signal: null,
      output: 'changed things',
      durationMs: 2000,
    })),
    runCommands: verifySequence(outcomes),
  };
}

/** @param {import('../driver.js').LoopDeps} deps */
function loop(deps, overrides = {}) {
  return runLoop({
    rootDir: root,
    name: NAME,
    command: COMMAND,
    max: 5,
    stall: 2,
    timeoutMs: 60 * 60 * 1000,
    iterationTimeoutMs: 20 * 60 * 1000,
    deps,
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-driver-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fingerprint', () => {
  test('should change when the working tree changes', () => {
    const git = (/** @type {string[]} */ ...args) =>
      spawnSync(
        'git',
        ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
        { cwd: root }
      );
    git('init', '-q');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const first = fingerprint(root, spawnSync);
    fs.writeFileSync(path.join(root, 'a.txt'), 'b');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(root, spawnSync)).not.toBe(first);
  });

  test('should be null when git cannot answer', () => {
    expect(fingerprint(root, () => ({ status: 128 }))).toBeNull();
  });
});

describe('buildPrompt', () => {
  test('should include the goal, verify commands, failure, brief, and rules', () => {
    const prompt = buildPrompt({
      name: NAME,
      iteration: 2,
      max: 5,
      verify: ['pnpm test', 'pnpm lint'],
      lastVerify: {
        at: NOW.toISOString(),
        ok: false,
        failed: 'pnpm test',
        summary: 'expected 1 to be 2',
      },
      brief: '[Task] demo',
    });
    expect(prompt).toContain('iteration 2 of 5');
    expect(prompt).toContain('  pnpm test\n  pnpm lint');
    expect(prompt).toContain('`pnpm test` failed');
    expect(prompt).toContain('expected 1 to be 2');
    expect(prompt).toContain('[Task] demo');
    expect(prompt).toContain('Do not commit, push');
    expect(prompt).toContain('Do not weaken, skip, or delete tests');
  });
});

describe('formatIterationLog', () => {
  const verify = { at: '', ok: true, failed: null, summary: '1 passed' };

  test('should record a passing iteration', () => {
    const log = formatIterationLog({
      iteration: 1,
      max: 3,
      command: COMMAND,
      agent: { code: 0, signal: null, output: 'hi', durationMs: 1500 },
      diffStat: null,
      verify,
      progress: 'verify passed',
    });
    expect(log).toContain('# Iteration 1/3 — codex');
    expect(log).toContain(
      '`codex exec --sandbox workspace-write --ephemeral -` (prompt on stdin)'
    );
    expect(log).toContain('Agent exit: 0 in 2s');
    expect(log).toContain('Diff vs HEAD: none');
    expect(log).toContain('Verify: pass');
  });

  test('should record a timeout and a failure, keeping only the output tail', () => {
    const output = Array.from({ length: OUTPUT_TAIL_LINES + 5 }, (_, i) =>
      String(i)
    ).join('\n');
    const log = formatIterationLog({
      iteration: 2,
      max: 3,
      command: COMMAND,
      agent: { code: null, signal: 'SIGTERM', output, durationMs: 0 },
      diffStat: '2 files changed',
      verify: { ...verify, ok: false, failed: 'pnpm test' },
      progress: 'new failure',
    });
    expect(log).toContain('Agent exit: stopped by SIGTERM');
    expect(log).toContain('Diff vs HEAD: 2 files changed');
    expect(log).toContain('Verify: fail — `pnpm test`');
    expect(log).not.toContain('\n4\n');
    expect(log).toContain(`\n${OUTPUT_TAIL_LINES + 4}\n`);
  });
});

describe('runLoop', () => {
  test('should refuse a task without verify commands', () => {
    seedTask({ verify: [] });
    expect(() => loop(makeDeps({ outcomes: [true] }))).toThrow(
      /no verify commands.*\nFix: pnpm task set --task demo-261117/s
    );
  });

  test('should refuse a hand-written task without state.json', () => {
    fs.mkdirSync(path.join(tasksRoot(root), NAME), { recursive: true });
    expect(() => loop(makeDeps({ outcomes: [true] }))).toThrow(
      /no verify commands/
    );
  });

  test('should stop at once when the baseline verify already passes', () => {
    const dir = seedTask();
    const deps = makeDeps({ outcomes: [true] });

    const result = loop(deps);

    expect(result).toMatchObject({ ok: true, reason: 'green', iterations: 0 });
    expect(deps.runAgent).not.toHaveBeenCalled();
    const notes = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8');
    expect(notes).toContain('(auto: outer loop)');
    expect(notes).toContain('verify passed (0 agent iteration(s))');
    expect(notes).not.toContain('Logs:');
  });

  test('should run the agent until verify passes and log each iteration', () => {
    const dir = seedTask();
    const deps = makeDeps({ outcomes: ['fail A', 'fail B', true] });

    const result = loop(deps);

    expect(result).toMatchObject({ ok: true, reason: 'green', iterations: 2 });
    expect(loadTask(root, NAME).state?.lastVerify?.ok).toBe(true);
    expect(fs.readdirSync(result.logDir).sort()).toEqual([
      'iter-1.md',
      'iter-2.md',
    ]);
    expect(path.basename(result.logDir)).toBe('run-202611170930');
    expect(
      fs.readFileSync(path.join(result.logDir, 'iter-1.md'), 'utf-8')
    ).toContain('Progress: new failure');
    const notes = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8');
    expect(notes).toContain(
      'verify passed (2 agent iteration(s)). Logs: tasks/'
    );
    expect(notes).toContain('State: branch loop/demo');
  });

  test('should run the agent with the inner loop off and the prompt on stdin', () => {
    seedTask();
    const deps = makeDeps({ outcomes: ['fail A', true] });

    loop(deps, { iterationTimeoutMs: 1000 });

    expect(deps.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        command: COMMAND,
        cwd: root,
        timeoutMs: 1000,
        env: { HOME: '/home/t', TASK_INNER_LOOP: 'off', TASK_AGENT: 'codex' },
        prompt: expect.stringContaining('fail A'),
      })
    );
  });

  test('should stop with no progress when the same failure repeats', () => {
    const dir = seedTask();
    const deps = makeDeps({ outcomes: ['same 12ms'] });

    const result = loop(deps);

    expect(result).toMatchObject({
      ok: false,
      reason: 'no-progress',
      iterations: 2,
    });
    expect(
      fs.readFileSync(path.join(result.logDir, 'iter-2.md'), 'utf-8')
    ).toContain('Progress: none (same failure; 2/2)');
    expect(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8')).toContain(
      'stopped: no progress in 2 iteration(s) in a row (2 agent iteration(s)). Logs: tasks/'
    );
  });

  test('should stop with no progress when the agent changes no files', () => {
    seedTask();
    const deps = makeDeps({
      outcomes: ['a', 'b', 'c', 'd'],
      prints: ['same'],
    });

    const result = loop(deps);

    expect(result).toMatchObject({ reason: 'no-progress', iterations: 2 });
    expect(
      fs.readFileSync(path.join(result.logDir, 'iter-1.md'), 'utf-8')
    ).toContain('Progress: none (no file changes; 1/2)');
  });

  test('should never treat an unknown fingerprint as unchanged', () => {
    seedTask();
    const deps = makeDeps({ outcomes: ['a', 'b', 'c', 'd'], prints: [null] });

    expect(loop(deps, { max: 3 })).toMatchObject({
      reason: 'max',
      iterations: 3,
    });
  });

  test('should reset the stall count after real progress', () => {
    seedTask();
    const deps = makeDeps({ outcomes: ['a', 'a', 'b', 'b', 'c'] });

    expect(loop(deps, { max: 4 })).toMatchObject({
      reason: 'max',
      iterations: 4,
    });
  });

  test('should stop at the iteration cap and record the last failure', () => {
    const dir = seedTask();
    const deps = makeDeps({ outcomes: ['a', 'b', 'c', 'd'] });

    const result = loop(deps, { max: 3 });

    expect(result).toMatchObject({ ok: false, reason: 'max', iterations: 3 });
    expect(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf-8')).toContain(
      'verify still fails after 3 iteration(s) (3 agent iteration(s)). Logs: tasks/demo-261117/loop/run-202611170930/ Last failure: `pnpm test`.'
    );
  });

  test('should stop before an iteration when the wall clock is used up', () => {
    seedTask();
    let time = 0;
    const deps = makeDeps({ outcomes: ['a'], clock: () => (time += 60) });

    const result = loop(deps, { timeoutMs: 50 });

    expect(result).toMatchObject({ reason: 'timeout', iterations: 0 });
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  test('should stop after an iteration that crosses the wall clock', () => {
    seedTask();
    const times = [0, 10, 100];
    const deps = makeDeps({
      outcomes: ['a', 'b'],
      clock: () => times.shift() ?? 100,
    });

    const result = loop(deps, { timeoutMs: 50, iterationTimeoutMs: 1000 });

    expect(result).toMatchObject({ reason: 'timeout', iterations: 1 });
    expect(deps.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 40 })
    );
  });
});
