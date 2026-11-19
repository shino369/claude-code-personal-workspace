import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { main as taskMain } from '../../task/cli.js';
import { TEMPLATES_DIR } from '../../task/store.js';
import { ROOT_DIR } from '../../workspace-config.js';
import {
  HELP,
  MAX_WORKERS,
  WORKER_SCRIPT,
  defaultCliDeps,
  isAlive,
  main,
  parseArgs,
  startWorker,
} from '../cli.js';

const TASK = 'demo-261117';
const NOW = new Date(2026, 10, 17, 9, 30);

/** @type {string} */
let base;
/** @type {string} */
let repo;
/** @type {string[]} */
let logs;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

/** @param {string[]} argv */
function task(argv) {
  taskMain({
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

/**
 * A fake worker that passes (no changes) unless the step id is in `fail`.
 *
 * @param {string[]} [fail]
 */
const worker = (fail = []) =>
  vi.fn(
    /** @param {import('../worker.js').WorkerConfig} config */
    async (config) => ({
      ok: !fail.includes(config.step.id),
      id: config.step.id,
      worker: config.worker,
      branch: config.branch,
      dir: config.dir,
      commit: null,
      reason: /** @type {'max' | 'green'} */ (
        fail.includes(config.step.id) ? 'max' : 'green'
      ),
      iterations: 0,
      failed: fail.includes(config.step.id) ? 'node check.mjs' : null,
      detail: 'd',
      logDir: null,
      durationMs: 0,
    })
  );

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
        output: '',
      }))
  );

/**
 * @param {string[]} argv
 * @param {Partial<import('../cli.js').CliDeps>} [deps]
 */
async function run(argv, deps = {}) {
  logs = [];
  const code = await main({
    argv,
    deps: {
      rootDir: repo,
      env: {},
      log: (message) => logs.push(message),
      clock: () => 0,
      date: () => NOW,
      install: () => ({ status: 0 }),
      runCommands: verify(true),
      startWorker: worker(),
      pid: 4242,
      isAlive: () => false,
      ...deps,
    },
  });
  return { code, out: logs.join('\n') };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tasks/\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@example.com']);
  git(repo, ['config', 'user.name', 't']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('should use defaults', () => {
    expect(parseArgs([])).toEqual({
      task: undefined,
      agent: undefined,
      bin: undefined,
      workers: 2,
      fix: 3,
      stall: 2,
      timeoutMin: 120,
      iterationTimeoutMin: 20,
      maxBudgetUsd: undefined,
      install: true,
      dryRun: false,
      help: false,
    });
  });

  test('should read every flag, in both forms', () => {
    expect(
      parseArgs([
        'demo',
        '--agent=codex',
        '--workers',
        '3',
        '--fix',
        '0',
        '--stall=1',
        '--timeout-min',
        '1.5',
        '--iteration-timeout-min',
        '2',
        '--bin',
        'npx x',
        '--max-budget-usd',
        '0.5',
        '--no-install',
        '--dry-run',
        '-h',
      ])
    ).toEqual({
      task: 'demo',
      agent: 'codex',
      bin: 'npx x',
      workers: 3,
      fix: 0,
      stall: 1,
      timeoutMin: 1.5,
      iterationTimeoutMin: 2,
      maxBudgetUsd: 0.5,
      install: false,
      dryRun: true,
      help: true,
    });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  test('should reject bad input', () => {
    expect(() => parseArgs(['--agent'])).toThrow('--agent needs a value');
    expect(() => parseArgs(['--nope'])).toThrow(
      'Unknown option: --nope (see pnpm swarm --help)'
    );
    expect(() => parseArgs(['a', 'b'])).toThrow(
      'pnpm swarm takes one task name (got a, b)'
    );
    expect(() => parseArgs(['--workers', String(MAX_WORKERS + 1)])).toThrow(
      `--workers must be a whole number from 1 to ${MAX_WORKERS}`
    );
    expect(() => parseArgs(['--workers', '1.5'])).toThrow(/--workers/);
    expect(() => parseArgs(['--fix', '-1'])).toThrow(/--fix must be/);
    expect(() => parseArgs(['--stall', '0'])).toThrow(/--stall/);
    expect(() => parseArgs(['--timeout-min', '0'])).toThrow(
      '--timeout-min must be a positive number (got "0")'
    );
    expect(() => parseArgs(['--iteration-timeout-min', 'x'])).toThrow(
      /--iteration-timeout-min/
    );
    expect(() => parseArgs(['--max-budget-usd', '-1'])).toThrow(
      /--max-budget-usd/
    );
  });
});

describe('main', () => {
  test('should print help', async () => {
    expect(await run(['--help'])).toEqual({ code: 0, out: HELP });
  });

  test('should require an agent', async () => {
    await expect(run([])).rejects.toThrow(
      /--agent is required\.\nFix: pnpm swarm <task> --agent/
    );
    await expect(run(['demo'])).rejects.toThrow(/pnpm swarm demo --agent/);
  });

  test('should refuse a hand-written task or one without verify', async () => {
    fs.mkdirSync(path.join(repo, 'tasks', 'hand-261117'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'tasks', 'hand-261117', 'plan.md'), 'x');
    await expect(run(['hand', '--agent', 'claude'])).rejects.toThrow(
      /has no state\.json.*\nFix: pnpm task init hand-261117/
    );
    task(['new', 'demo', '--goal', 'G', '--step', 'One']);
    await expect(run(['demo', '--agent', 'claude'])).rejects.toThrow(
      /has no verify commands/
    );
  });

  test('should refuse a task that works in another repository', async () => {
    task(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'x']);
    const file = path.join(repo, 'tasks', TASK, 'state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(
      file,
      JSON.stringify({ ...saved, repo: path.resolve(repo, '..', 'elsewhere') })
    );
    await expect(run(['demo', '--agent', 'claude'])).rejects.toThrow(
      /works in .*elsewhere, not this workspace/
    );
  });

  test('should print a dry run', async () => {
    task(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v']);
    const { code, out } = await run([
      'demo',
      '--agent',
      'codex',
      '--dry-run',
      '--bin',
      'my-codex',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('Agent: my-codex exec --sandbox workspace-write');
    expect(out).toContain('Workers: 2; per step: 1 run + up to 3 fix');
    expect(out).toContain('Ready now: s1. One');
    expect(out).toContain(`on swarm/${TASK}`);
    task(['step', 's1', 'done']);
    expect(
      (await run(['demo', '--agent', 'codex', '--dry-run'])).out
    ).toContain('Ready now: none');
  });

  test('should refuse task-folder code even on a dry run', async () => {
    task(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v']);
    fs.writeFileSync(path.join(repo, 'tasks', TASK, 'app.js'), 'export {};\n');
    await expect(
      run(['demo', '--agent', 'codex', '--dry-run'])
    ).rejects.toThrow(/keeps code in its task folder \(app\.js\)/);
  });

  test('should run the swarm and exit 0 when everything passes', async () => {
    task(['new', 'demo', '--goal', 'G', '--step', 'One', '--verify', 'v']);
    const { code, out } = await run(['demo', '--agent', 'claude']);
    expect(code).toBe(0);
    expect(out).toContain(`✓ ${TASK}: 1 step(s) done, 0 blocked.`);
    expect(out).toContain(`Final verify on swarm/${TASK}: pass`);
    expect(out).toContain(`Review: git log --oneline HEAD..swarm/${TASK}`);
    expect(out).not.toContain('Left:');
  });

  test('should exit 1 and list blocked steps and a failing final verify', async () => {
    task([
      'new',
      'demo',
      '--goal',
      'G',
      '--step',
      'One',
      '--step',
      'Two',
      '--verify',
      'v',
    ]);
    const { code, out } = await run(['demo', '--agent', 'claude'], {
      startWorker: worker(['s1']),
      runCommands: verify(false),
    });
    expect(code).toBe(1);
    expect(out).toContain(`✗ ${TASK}: 1 step(s) done, 1 blocked.`);
    expect(out).toContain('  s1: max — `node check.mjs` fails: d');
    expect(out).toContain('Left: blocked: s1');
    expect(out).toContain(`Final verify on swarm/${TASK}: fail — \`v\``);
  });

  test('should report the wall-clock cap', async () => {
    task([
      'new',
      'demo',
      '--goal',
      'G',
      '--step',
      'One',
      '--step',
      'Two',
      '--verify',
      'v',
    ]);
    let now = 0;
    const inner = worker(['s1']);
    const { code, out } = await run(
      ['demo', '--agent', 'claude', '--workers', '1', '--timeout-min', '1'],
      {
        clock: () => now,
        startWorker: vi.fn(
          /** @param {import('../worker.js').WorkerConfig} config */
          async (config) => {
            now = 10 * 60 * 1000;
            return inner(config);
          }
        ),
      }
    );
    expect(code).toBe(1);
    expect(out).toContain(
      '0 step(s) done, 1 blocked (wall-clock cap reached).'
    );
    expect(out).toContain('Left: blocked: s1; ready: s2');
    expect(out).not.toContain('Final verify');
  });
});

/**
 * @typedef {EventEmitter & { args?: unknown[] }} FakeChild
 * @param {(child: FakeChild) => void} behave
 */
function fakeSpawn(behave) {
  return vi.fn((...args) => {
    /** @type {FakeChild} */
    const child = new EventEmitter();
    child.args = args;
    setImmediate(() => behave(child));
    return /** @type {any} */ (child);
  });
}

describe('startWorker', () => {
  /** @returns {import('../worker.js').WorkerConfig} */
  const config = () =>
    /** @type {any} */ ({
      rootDir: repo,
      worker: 'claude/swarm-w1',
      step: { id: 's1', title: 'One' },
      branch: 'b',
      dir: '/wt',
      resultFile: path.join(base, 's1.result.json'),
    });
  const logFile = () => path.join(base, 's1.log');

  test('should run the worker script and resolve with its result file', async () => {
    fs.writeFileSync(config().resultFile, '{"ok":true,"id":"s1"}');
    const spawn = fakeSpawn((child) => child.emit('close', 0));
    const result = await startWorker(config(), logFile(), {
      spawn,
      script: '/w.js',
    });
    expect(result).toEqual({ ok: true, id: 's1' });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/w.js', path.join(base, 's1.config.json')],
      expect.objectContaining({ cwd: repo })
    );
    expect(fs.existsSync(logFile())).toBe(true);
  });

  test('should report a worker that left no result', async () => {
    const spawn = fakeSpawn((child) => child.emit('close', 3));
    expect(await startWorker(config(), logFile(), { spawn })).toMatchObject({
      ok: false,
      id: 's1',
      worker: 'claude/swarm-w1',
      reason: 'error',
      detail: `the worker exited 3 without a result; see ${logFile()}`,
    });
  });

  test('should settle once when the process cannot start', async () => {
    const spawn = fakeSpawn((child) => {
      child.emit('error', new Error('spawn EACCES'));
      child.emit('close', null);
    });
    expect(await startWorker(config(), logFile(), { spawn })).toMatchObject({
      reason: 'error',
      detail: 'could not start the worker: spawn EACCES',
    });
  });

  test('should run the real worker script by default', async () => {
    expect(WORKER_SCRIPT).toMatch(/worker\.js$/);
    const result = await defaultCliDeps().startWorker(config(), logFile());
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(fs.readFileSync(logFile(), 'utf-8')).toContain('ENOENT');
  });
});

describe('isAlive', () => {
  test('should tell a live process from a gone one', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
  });

  test('should count a process we may not signal as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'EPERM' });
    });
    expect(isAlive(1)).toBe(true);
  });
});

describe('defaultCliDeps', () => {
  test('should use the workspace and install through the given spawn', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const d = defaultCliDeps({ spawn });
    expect(d.rootDir).toBe(ROOT_DIR);
    expect(d.pid).toBe(process.pid);
    expect(d.date()).toBeInstanceOf(Date);
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
    expect(defaultCliDeps().spawn).toBe(spawnSync);
  });
});
