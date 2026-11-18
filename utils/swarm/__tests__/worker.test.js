import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { INNER_LOOP_ENV } from '../../task/loop.js';
import { main as taskMain } from '../../task/cli.js';
import { TEMPLATES_DIR } from '../../task/store.js';
import { swarmDir } from '../git.js';
import {
  buildStepPrompt,
  defaultWorkerDeps,
  main,
  runStep,
} from '../worker.js';

const TASK = 'demo-261117';
const NOW = new Date(2026, 10, 17, 9, 30);

/** @type {string} */
let base;
/** @type {string} */
let repo;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** @param {unknown} fn mock calls of a vi.fn passed through deps */
const calls = (fn) => /** @type {any} */ (fn).mock.calls;

const realSpawn = /** @type {import('../git.js').Spawn} */ (spawnSync);

/** @param {boolean[]} outcomes verify results, last one repeats */
function verifier(outcomes) {
  let call = 0;
  return vi.fn(
    /** @param {{ commands: string[] }} options */
    ({ commands }) => {
      const ok = outcomes[Math.min(call++, outcomes.length - 1)];
      return [
        {
          command: commands[0],
          ok,
          code: ok ? 0 : 1,
          durationMs: 1,
          output: ok ? 'ok' : 'boom',
        },
      ];
    }
  );
}

/** @param {(cwd: string) => void} [edit] */
const agent = (edit) =>
  vi.fn(
    /** @param {{ cwd: string }} options */
    ({ cwd }) => {
      edit?.(cwd);
      return {
        code: 0,
        signal: null,
        output: 'done',
        stdout: 'done',
        durationMs: 5,
      };
    }
  );

/** @param {Partial<import('../worker.js').WorkerConfig>} [overrides] */
function config(overrides = {}) {
  return {
    rootDir: repo,
    task: TASK,
    worker: 'claude/swarm-w1',
    step: { id: 's1', title: 'One' },
    done: [],
    slot: 's1',
    branch: `swarm/${TASK}--s1`,
    dir: swarmDir(repo, TASK, 's1'),
    base: git(repo, ['rev-parse', 'HEAD']),
    command: {
      agent: /** @type {const} */ ('claude'),
      bin: 'claude',
      args: ['-p'],
    },
    fixMax: 1,
    stall: 2,
    timeoutMs: 60_000,
    iterationTimeoutMs: 30_000,
    install: true,
    resultFile: path.join(base, 's1.result.json'),
    ...overrides,
  };
}

/** @param {Partial<import('../worker.js').WorkerDeps>} [overrides] */
function deps(overrides = {}) {
  let now = 1000;
  return {
    clock: () => (now += 10),
    date: () => NOW,
    env: { PATH: process.env.PATH },
    log: vi.fn(),
    spawn: realSpawn,
    install: vi.fn(() => ({ status: 0 })),
    runAgent: agent((cwd) => fs.writeFileSync(path.join(cwd, 'one.txt'), '1')),
    runCommands: verifier([true]),
    ...overrides,
  };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-worker-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tasks/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  taskMain({
    argv: [
      'new',
      'demo',
      '--goal',
      'G',
      '--step',
      'One',
      '--verify',
      'node check.mjs',
    ],
    deps: {
      rootDir: repo,
      templatesDir: TEMPLATES_DIR,
      env: { TASK_AGENT: 't' },
      now: () => NOW,
      log: () => {},
      git: () => ({ branch: 'main', changed: 0, diffStat: null }),
    },
  });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('buildStepPrompt', () => {
  test('should name the step, the verify commands, and the rules', () => {
    const prompt = buildStepPrompt({
      config: config(),
      brief: 'BRIEF',
      verify: ['pnpm check'],
    });
    expect(prompt).toContain('You are claude/swarm-w1 in `pnpm swarm`');
    expect(prompt).toContain('Your step: s1. One');
    expect(prompt).toContain('No step is done yet.');
    expect(prompt).toContain('  pnpm check');
    expect(prompt).toContain('BRIEF');
    expect(prompt).toContain('Do not run pnpm task step/claim/done/note');
  });

  test('should list steps already done', () => {
    const prompt = buildStepPrompt({
      config: config({
        done: [
          { id: 's1', title: 'One' },
          { id: 's2', title: 'Two' },
        ],
      }),
      brief: '',
      verify: [],
    });
    expect(prompt).toContain(
      'Steps already done (their changes are in this worktree): s1. One; s2. Two'
    );
  });
});

describe('runStep', () => {
  test('should run the agent, verify, and commit on the step branch', () => {
    const d = deps();
    const c = config();
    const result = runStep({ config: c, deps: d });
    expect(result).toMatchObject({
      ok: true,
      id: 's1',
      worker: 'claude/swarm-w1',
      branch: c.branch,
      dir: c.dir,
      reason: 'green',
      iterations: 0,
      failed: null,
      logDir: null,
      detail: 'verify passed',
    });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.commit).toBe(git(c.dir, ['rev-parse', 'HEAD']));
    expect(git(c.dir, ['log', '-1', '--format=%s%n%b'])).toBe(
      `chore: swarm step s1\ns1. One\n\nTask: ${TASK} (claude/swarm-w1, claude)`
    );
    expect(git(repo, ['branch', '--show-current'])).toBe('main');
    const [call] = /** @type {any[]} */ (calls(d.runAgent)[0]);
    expect(call).toMatchObject({
      cwd: c.dir,
      timeoutMs: 30_000,
      env: { [INNER_LOOP_ENV]: 'off', TASK_AGENT: 'claude/swarm-w1' },
    });
    expect(call.prompt).toContain('Your step: s1. One');
    expect(call.prompt).toContain('  node check.mjs');
    expect(d.log).toHaveBeenCalledWith('▶ claude/swarm-w1 s1: claude');
  });

  test('should pass with no commit when the agent changed nothing', () => {
    const result = runStep({
      config: config({ install: false, timeoutMs: 5 }),
      deps: deps({ runAgent: agent() }),
    });
    expect(result).toMatchObject({
      ok: true,
      commit: null,
      detail: 'verify passed; no changes',
    });
  });

  test('should install in a new worktree with a package.json', () => {
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'pkg']);
    const d = deps();
    runStep({ config: config(), deps: d });
    expect(d.install).toHaveBeenCalledWith(config().dir);
  });

  test('should fail with the last verify after the fix iterations', () => {
    const d = deps({ runCommands: verifier([false]) });
    const result = runStep({ config: config(), deps: d });
    expect(result).toMatchObject({
      ok: false,
      reason: 'max',
      iterations: 1,
      failed: 'node check.mjs',
      commit: null,
    });
    expect(result.detail).toContain('boom');
    expect(result.logDir).toContain(path.join('tasks', TASK, 'loop', 'run-'));
    expect(d.runAgent).toHaveBeenCalledTimes(2);
    const [fix] = /** @type {any[]} */ (calls(d.runAgent)[1]);
    expect(fix.env.TASK_AGENT).toBe('claude/swarm-w1');
  });

  test('should report no log dir when no fix iteration ran', () => {
    const result = runStep({
      config: config({ fixMax: 0 }),
      deps: deps({ runCommands: verifier([false]) }),
    });
    expect(result).toMatchObject({ ok: false, iterations: 0, logDir: null });
  });

  test('should report a commit failure', () => {
    const spawn = vi.fn(
      /** @type {import('../git.js').Spawn} */ (
        (command, args, options) =>
          args[0] === 'commit'
            ? { status: 1, stderr: 'hook rejected' }
            : spawnSync(command, args, options)
      )
    );
    const result = runStep({ config: config(), deps: deps({ spawn }) });
    expect(result).toMatchObject({
      ok: false,
      reason: 'commit',
      detail: 'git commit failed: hook rejected',
    });
  });

  test('should turn a thrown error into a result', () => {
    const c = config();
    fs.mkdirSync(c.dir, { recursive: true });
    expect(runStep({ config: c, deps: deps() })).toMatchObject({
      ok: false,
      reason: 'error',
      detail: expect.stringMatching(/is not a worktree of this repository/),
    });
    const thrower = vi.fn(() => {
      // eslint-disable-next-line no-throw-literal -- covers non-Error throws
      throw 'plain string';
    });
    expect(
      runStep({
        config: config({ slot: 's1-2', dir: swarmDir(repo, TASK, 's1-2') }),
        deps: deps({ runAgent: thrower }),
      })
    ).toMatchObject({ ok: false, reason: 'error', detail: 'plain string' });
  });

  test('should fail when the copied task has no state.json', () => {
    const other = 'hand-261117';
    fs.mkdirSync(path.join(repo, 'tasks', other));
    fs.writeFileSync(path.join(repo, 'tasks', other, 'plan.md'), 'Goal: G\n');
    const d = deps();
    const result = runStep({ config: config({ task: other }), deps: d });
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(result.detail).toMatch(/no verify commands/);
    const [call] = /** @type {any[]} */ (calls(d.runAgent)[0]);
    expect(call.prompt).toContain('When you finish, these verify commands');
  });
});

describe('defaultWorkerDeps', () => {
  test('should use real defaults and install through the given spawn', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const d = defaultWorkerDeps({ spawn });
    expect(d.env).toBe(process.env);
    expect(d.date()).toBeInstanceOf(Date);
    expect(typeof d.clock()).toBe('number');
    expect(d.install('/x')).toEqual({ status: 0 });
    // Through crossSpawn: `pnpm …` here, `cmd.exe /d /s /c "…pnpm.CMD …"` on Windows
    const call = /** @type {unknown[]} */ (spawn.mock.calls[0]);
    expect(call.flat().join(' ')).toMatch(
      /pnpm\S* install --frozen-lockfile --prefer-offline/i
    );
    expect(call[2]).toMatchObject({
      cwd: '/x',
      stdio: 'inherit',
    });
    expect(defaultWorkerDeps().spawn).toBe(spawnSync);
  });
});

describe('main', () => {
  test('should read the config, run the step, and write the result file', () => {
    const c = config();
    const file = path.join(base, 's1.config.json');
    fs.writeFileSync(file, JSON.stringify(c));
    const result = main({ argv: [file], deps: deps() });
    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(c.resultFile, 'utf-8'))).toEqual(result);
  });

  test('should require a config file', () => {
    expect(() => main({ argv: [] })).toThrow(
      'Usage: node utils/swarm/worker.js <config.json>'
    );
  });
});
