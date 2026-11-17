import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { main as taskMain } from '../../task/cli.js';
import { setStepStatus } from '../../task/state.js';
import { TEMPLATES_DIR, loadTask, updateState } from '../../task/store.js';
import {
  LOCK_FILE,
  SWARM_OWNER_RE,
  acquireSwarmLock,
  releaseStaleClaims,
  runSwarm,
} from '../dispatcher.js';
import { addWorktree, commitAll, swarmBranch, swarmDir } from '../git.js';

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

const spawn = /** @type {import('../git.js').Spawn} */ (spawnSync);
const taskDir = () => path.join(repo, 'tasks', TASK);
const state = () =>
  /** @type {import('../../task/state.js').TaskState} */ (
    loadTask(repo, TASK).state
  );
const notes = () => fs.readFileSync(path.join(taskDir(), 'NOTES.md'), 'utf-8');

/** @param {string[]} argv */
function task(argv) {
  return taskMain({
    argv,
    deps: {
      rootDir: repo,
      templatesDir: TEMPLATES_DIR,
      env: { TASK_AGENT: 't' },
      now: () => NOW,
      log: () => {},
      git: () => ({ branch: 'main', changed: 0, diffStat: null }),
    },
  });
}

/** @param {string[]} [extra] */
function newTask(extra = ['--verify', 'node check.mjs']) {
  task([
    'new',
    'demo',
    '--goal',
    'G',
    '--step',
    'One',
    '--step',
    'Two',
    ...extra,
  ]);
}

/**
 * @typedef {'commit' | 'readme' | 'nochange' | 'fail'} Behavior
 * @param {Record<string, Behavior>} [behaviors] by step id (default commit)
 * @param {Record<string, number>} [delays] ms by step id
 */
function fakeWorker(behaviors = {}, delays = {}) {
  return vi.fn(
    /**
     * @param {import('../worker.js').WorkerConfig} config
     * @returns {Promise<import('../worker.js').StepResult>}
     */
    async (config) => {
      const { id } = config.step;
      const behavior = behaviors[id] ?? 'commit';
      /** @type {import('../worker.js').StepResult} */
      const result = {
        ok: true,
        id,
        worker: config.worker,
        branch: config.branch,
        dir: config.dir,
        commit: null,
        reason: 'green',
        iterations: 0,
        failed: null,
        detail: 'verify passed',
        logDir: null,
        durationMs: 1500,
      };
      await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0));
      if (behavior === 'fail') {
        return {
          ...result,
          ok: false,
          reason: 'max',
          failed: 'node check.mjs',
          detail: 'boom\nmore',
          logDir: '/logs/s',
        };
      }
      if (behavior === 'nochange') return result;
      addWorktree({
        rootDir: config.rootDir,
        dir: config.dir,
        branch: config.branch,
        base: config.base,
        spawn,
      });
      const file = behavior === 'readme' ? 'README.md' : `${id}.txt`;
      fs.writeFileSync(path.join(config.dir, file), `${id}\n`);
      const committed = commitAll({
        dir: config.dir,
        subject: `chore: swarm step ${id}`,
        body: 'b',
        spawn,
      });
      return {
        ...result,
        commit: /** @type {{ sha: string }} */ (committed).sha,
      };
    }
  );
}

/** @param {boolean} ok */
const verify = (ok) =>
  vi.fn(
    /** @param {{ commands: string[] }} options */
    ({ commands }) =>
      commands.map((command) => ({
        command,
        ok,
        code: ok ? 0 : 1,
        durationMs: 1,
        output: ok ? 'ok' : 'nope',
      }))
  );

/** @param {Partial<import('../dispatcher.js').SwarmDeps>} [overrides] */
function deps(overrides = {}) {
  return {
    clock: () => 0,
    date: () => NOW,
    log: vi.fn(),
    spawn,
    install: vi.fn(() => ({ status: 0 })),
    git: () => ({ branch: 'main', changed: 0, diffStat: null }),
    runCommands: verify(true),
    startWorker: fakeWorker(),
    pid: 4242,
    isAlive: () => false,
    ...overrides,
  };
}

/**
 * @param {Partial<import('../dispatcher.js').SwarmOptions>} [overrides]
 */
const swarm = (overrides = {}) =>
  runSwarm({
    rootDir: repo,
    name: TASK,
    command: { agent: 'claude', bin: 'claude', args: [] },
    workers: 2,
    fixMax: 1,
    stall: 2,
    timeoutMs: 60_000,
    iterationTimeoutMs: 30_000,
    install: true,
    deps: deps(),
    ...overrides,
  });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-dispatch-'));
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
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('acquireSwarmLock', () => {
  test('should take a free lock and release it', () => {
    fs.mkdirSync(base, { recursive: true });
    const release = acquireSwarmLock(base, { pid: 7, isAlive: () => true });
    expect(fs.readFileSync(path.join(base, LOCK_FILE), 'utf-8')).toBe('7\n');
    release();
    expect(fs.existsSync(path.join(base, LOCK_FILE))).toBe(false);
  });

  test('should refuse a lock held by a running swarm', () => {
    fs.writeFileSync(path.join(base, LOCK_FILE), '99\n');
    expect(() =>
      acquireSwarmLock(base, { pid: 7, isAlive: (pid) => pid === 99 })
    ).toThrow(/Another pnpm swarm \(pid 99\) is running this task/);
  });

  test('should take over a lock from a dead process or with junk inside', () => {
    fs.writeFileSync(path.join(base, LOCK_FILE), '99\n');
    acquireSwarmLock(base, { pid: 7, isAlive: () => false });
    expect(fs.readFileSync(path.join(base, LOCK_FILE), 'utf-8')).toBe('7\n');
    fs.writeFileSync(path.join(base, LOCK_FILE), 'junk');
    const isAlive = vi.fn(() => true);
    acquireSwarmLock(base, { pid: 8, isAlive });
    expect(isAlive).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(base, LOCK_FILE), '-3');
    acquireSwarmLock(base, { pid: 9, isAlive });
    expect(fs.readFileSync(path.join(base, LOCK_FILE), 'utf-8')).toBe('9\n');
  });

  test('should treat an empty lock as free and let its owner re-take it', () => {
    fs.writeFileSync(path.join(base, LOCK_FILE), '');
    const isAlive = vi.fn(() => true);
    acquireSwarmLock(base, { pid: 7, isAlive });
    acquireSwarmLock(base, { pid: 7, isAlive });
    expect(isAlive).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(base, LOCK_FILE), 'utf-8')).toBe('7\n');
  });

  test('should not release a lock another swarm has taken over', () => {
    const release = acquireSwarmLock(base, { pid: 7, isAlive: () => false });
    fs.writeFileSync(path.join(base, LOCK_FILE), '8\n');
    release();
    expect(fs.readFileSync(path.join(base, LOCK_FILE), 'utf-8')).toBe('8\n');
  });

  test('should rethrow other errors', () => {
    expect(() =>
      acquireSwarmLock(path.join(base, 'missing'), {
        pid: 7,
        isAlive: () => false,
      })
    ).toThrow(/ENOENT/);
  });
});

describe('releaseStaleClaims', () => {
  test('should give back only steps owned by swarm workers', () => {
    newTask();
    task(['step', 'add', 'Three']);
    task(['claim', 's1', '--agent', 'claude/swarm-w1']);
    task(['claim', 's2', '--agent', 'codex']);
    updateState(
      repo,
      TASK,
      (s) =>
        setStepStatus(s, { id: 's3', status: 'in_progress', agent: null }).state
    );
    expect(releaseStaleClaims(repo, TASK, NOW)).toEqual(['s1']);
    expect(state().steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      's1:todo',
      's2:in_progress',
      's3:in_progress',
    ]);
    expect(SWARM_OWNER_RE.test('dsh/swarm-w12')).toBe(true);
  });
});

describe('runSwarm', () => {
  test('should run steps in parallel, honor deps, merge, and verify the result', async () => {
    newTask();
    task(['step', 'add', 'Three', '--deps', 's1']);
    /** @type {(value?: unknown) => void} */
    let openGate = () => {};
    const gate = new Promise((resolve) => (openGate = resolve));
    const inner = fakeWorker();
    // s2 finishes only after s3, which can start only after s1 is merged.
    const startWorker = vi.fn(
      /** @param {import('../worker.js').WorkerConfig} config */
      async (config) => {
        if (config.step.id === 's2') await gate;
        const result = await inner(config);
        if (config.step.id === 's3') openGate();
        return result;
      }
    );
    const d = deps({ startWorker });
    const result = await swarm({ deps: d });

    expect(result).toMatchObject({
      ok: true,
      done: ['s1', 's3', 's2'],
      blocked: [],
      left: '',
      timedOut: false,
      claims: [
        { id: 's1', worker: 'claude/swarm-w1' },
        { id: 's2', worker: 'claude/swarm-w2' },
        { id: 's3', worker: 'claude/swarm-w1' },
      ],
      integration: { dir: swarmDir(repo, TASK), branch: swarmBranch(TASK) },
      finalVerify: { ok: true },
    });
    const configs = startWorker.mock.calls.map(([config]) => config);
    expect(configs[2].done).toEqual([{ id: 's1', title: 'One' }]);
    expect(configs[2].base).not.toBe(configs[0].base);
    const integration = swarmDir(repo, TASK);
    for (const file of ['s1.txt', 's2.txt', 's3.txt']) {
      expect(fs.existsSync(path.join(integration, file))).toBe(true);
    }
    expect(fs.existsSync(path.join(result.runDir, 's1.config.json'))).toBe(
      true
    );
    expect(startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 's1' }),
      path.join(result.runDir, 's1.log')
    );
    expect(state().steps.every((s) => s.status === 'done')).toBe(true);
    expect(state().steps[0].note).toMatch(
      new RegExp(
        `^merged swarm/${TASK}--s1 \\([0-9a-f]{7}\\) into swarm/${TASK} by claude/swarm-w1$`
      )
    );
    expect(d.runCommands).toHaveBeenCalledWith({
      commands: ['node check.mjs'],
      cwd: integration,
    });
    expect(fs.existsSync(path.join(taskDir(), LOCK_FILE))).toBe(false);
    expect(notes()).toContain('(2s)');
    expect(notes()).toContain(
      'pnpm swarm --agent claude --workers 2: 3 step(s) done (s1, s3, s2), 0 blocked. Final verify on swarm/demo-261117: pass.'
    );
    expect(d.log).toHaveBeenCalledWith(
      `Integration: ${integration} on swarm/${TASK} (created)`
    );
  });

  test('should block a failed step and leave its dependents waiting', async () => {
    newTask();
    task(['step', 'add', 'Three', '--deps', 's1']);
    const d = deps({
      startWorker: fakeWorker({ s1: 'fail', s2: 'nochange' }),
      runCommands: verify(false),
    });
    const result = await swarm({ deps: d, install: false });
    expect(result).toMatchObject({
      ok: false,
      done: ['s2'],
      blocked: [{ id: 's1', reason: 'max — `node check.mjs` fails: boom' }],
      left: 'blocked: s1; waiting on dependencies: s3 (needs s1)',
      finalVerify: { ok: false },
    });
    expect(state().steps[0]).toMatchObject({
      status: 'blocked',
      note: `swarm claude/swarm-w1: max — \`node check.mjs\` fails: boom. Worktree ${swarmDir(repo, TASK, 's1')}; logs /logs/s`,
    });
    expect(state().steps[1].note).toBe(
      'verify passed with no changes by claude/swarm-w2'
    );
    expect(d.log).toHaveBeenCalledWith(
      '✗ final verify: `node check.mjs` fails'
    );
    expect(notes()).toContain(
      '1 step(s) done (s2), 1 blocked (s1). Final verify on swarm/demo-261117: fail — `node check.mjs`. Left: blocked: s1;'
    );
  });

  test('should block a step whose worker cannot start and keep going', async () => {
    newTask();
    task(['step', 'add', 'Three']);
    const working = fakeWorker();
    const d = deps({
      startWorker: (config) => {
        if (config.step.id === 's1') throw new Error('disk full');
        if (config.step.id === 's3') throw 'no slot'; // eslint-disable-line no-throw-literal
        return working(config);
      },
    });
    const result = await swarm({ deps: d, install: false });
    expect(result.blocked).toEqual([
      { id: 's1', reason: 'error: could not start the worker: disk full' },
      { id: 's3', reason: 'error: could not start the worker: no slot' },
    ]);
    expect(result.done).toEqual(['s2']);
    expect(state().steps[0]).toMatchObject({
      status: 'blocked',
      note: 'swarm claude/swarm-w1: error: could not start the worker: disk full.',
    });
  });

  test('should keep running when recording a result fails', async () => {
    newTask();
    const working = fakeWorker();
    const log = vi.fn();
    const startWorker = vi.fn(async (/** @type {any} */ config) => {
      const result = await working(config);
      // A result for a step the task does not have makes the state update throw.
      return config.step.id === 's1' ? { ...result, id: 's9' } : result;
    });
    const result = await swarm({
      deps: deps({ log, startWorker }),
      install: false,
    });
    expect(result.blocked).toEqual([
      {
        id: 's9',
        reason:
          'could not record the result: Unknown step "s9" (steps: s1, s2)',
      },
    ]);
    expect(result.done).toEqual(['s2']);
    expect(log).toHaveBeenCalledWith(
      '✗ claude/swarm-w1 s9: could not record the result: Unknown step "s9" (steps: s1, s2)'
    );
  });

  test('should block a step whose merge conflicts', async () => {
    newTask();
    const d = deps({
      startWorker: fakeWorker({ s1: 'readme', s2: 'readme' }, { s2: 30 }),
    });
    const result = await swarm({ deps: d });
    expect(result.done).toEqual(['s1']);
    expect(result.blocked).toEqual([
      {
        id: 's2',
        reason: expect.stringMatching(
          new RegExp(`^commit: git merge swarm/${TASK}--s2 failed`)
        ),
      },
    ]);
    expect(state().steps[1].note).not.toContain('; logs');
    expect(
      fs.readFileSync(path.join(swarmDir(repo, TASK), 'README.md'), 'utf-8')
    ).toBe('s1\n');
  });

  test('should report a run where every step fails, with no final verify', async () => {
    newTask();
    const d = deps({
      startWorker: fakeWorker({ s1: 'fail', s2: 'fail' }),
    });
    const result = await swarm({ deps: d, workers: 1 });
    expect(result).toMatchObject({ ok: false, done: [], finalVerify: null });
    expect(d.runCommands).not.toHaveBeenCalled();
    expect(notes()).toContain('No step merged, so no final verify.');
    expect(notes()).toContain('verify not run (on swarm/demo-261117)');
  });

  test('should stop claiming at the wall-clock cap', async () => {
    newTask();
    let now = 0;
    const startWorker = fakeWorker();
    const clock = () => now;
    startWorker.mockImplementationOnce(async (config) => {
      now = 999_999;
      return fakeWorker()(config);
    });
    const result = await swarm({
      workers: 1,
      deps: deps({ clock, startWorker }),
    });
    expect(result).toMatchObject({
      ok: false,
      done: ['s1'],
      timedOut: true,
      left: 'ready: s2',
    });
    expect(notes()).toContain('; stopped at the wall-clock cap.');
  });

  test('should reuse the integration worktree and release stale claims', async () => {
    newTask();
    await swarm();
    task(['step', 'add', 'Three']);
    task(['claim', 's3', '--agent', 'claude/swarm-w2']);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'x');
    const d = deps();
    const result = await swarm({ deps: d });
    expect(result.done).toEqual(['s3']);
    expect(d.log).toHaveBeenCalledWith(
      '! released steps left by an earlier swarm: s3'
    );
    expect(d.log).toHaveBeenCalledWith(
      expect.stringContaining('! The main checkout has uncommitted changes')
    );
    expect(d.log).toHaveBeenCalledWith(
      expect.stringMatching(/ on swarm\/demo-261117 \(reused\)$/)
    );
  });

  test('should refuse a task that keeps code in its task folder', async () => {
    newTask();
    for (const file of ['a.js', 'b.js', 'c.js', 'd.js']) {
      fs.mkdirSync(path.join(taskDir(), 'app'), { recursive: true });
      fs.writeFileSync(path.join(taskDir(), 'app', file), 'export {};\n');
    }
    await expect(swarm()).rejects.toThrow(
      /keeps code in its task folder \(app\/a\.js, app\/b\.js, app\/c\.js, … 4 files\)\..*\nFix: put the product code in a git-tracked place/s
    );
    fs.rmSync(path.join(taskDir(), 'app', 'd.js'));
    await expect(swarm()).rejects.toThrow(
      /\(app\/a\.js, app\/b\.js, app\/c\.js\)\. tasks\/ is git-ignored/
    );
    expect(fs.existsSync(path.join(taskDir(), LOCK_FILE))).toBe(false);
  });

  test('should be ok with nothing to do when every step is already done', async () => {
    newTask();
    task(['step', 's1', 'done']);
    task(['step', 's2', 'done']);
    const result = await swarm();
    expect(result).toMatchObject({ ok: true, done: [], finalVerify: null });
  });

  test('should install in the integration worktree when it has a package.json', async () => {
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'pkg']);
    newTask();
    const d = deps();
    await swarm({ deps: d });
    expect(d.install).toHaveBeenCalledWith(swarmDir(repo, TASK));
  });

  test('should refuse a task without verify commands or state', async () => {
    newTask([]);
    await expect(swarm()).rejects.toThrow(/has no verify commands/);
    fs.mkdirSync(path.join(repo, 'tasks', 'hand-261117'));
    fs.writeFileSync(path.join(repo, 'tasks', 'hand-261117', 'plan.md'), 'x');
    await expect(swarm({ name: 'hand-261117' })).rejects.toThrow(
      /has no verify commands/
    );
  });

  test('should refuse a repository without a commit and release the lock', async () => {
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    git(empty, ['init', '-q']);
    repo = empty;
    newTask();
    await expect(swarm()).rejects.toThrow(/has no commit to start the swarm/);
    expect(fs.existsSync(path.join(taskDir(), LOCK_FILE))).toBe(false);
  });
});
