#!/usr/bin/env node
/**
 * `pnpm swarm [task] --agent claude|codex|dsh --workers N` — run a task's
 * plan with N parallel headless workers, one git worktree per step, merged
 * into the integration branch `swarm/<task>` for you to review.
 */
import { spawn as spawnAsync, spawnSync } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { AGENTS, buildCommand } from '../loop/adapters.js';
import { runIfMain } from '../module-runner.js';
import { gitInfo } from '../task/git.js';
import { MAX_ITERATIONS, parseMax } from '../task/loop.js';
import { readySteps } from '../task/state.js';
import { loadTask, resolveTaskName } from '../task/store.js';
import { runCommands } from '../task/verify.js';
import { commandFor } from '../tools/registry.js';
import { ROOT_DIR } from '../workspace-config.js';
import { assertNoTaskCode, runSwarm } from './dispatcher.js';
import { swarmBranch, swarmDir } from './git.js';

export const MAX_WORKERS = 8;
export const WORKER_SCRIPT = fileURLToPath(
  new URL('./worker.js', import.meta.url)
);

export const HELP = `Usage: pnpm swarm [task] --agent ${AGENTS.join('|')} [options]

Runs the task's steps with parallel headless workers. Each worker claims a
ready step (dependencies done; same lock as pnpm task claim), works in its own
worktree ../<repo>-wt/swarm-<task>--<step> branched from the integration
branch swarm/<task>, and must leave the task's verify passing. The swarm
commits each finished step on its step branch and merges it into
swarm/<task>; at the end it runs verify there. Review and merge swarm/<task>
yourself. Failed steps are marked blocked (their dependents wait).
Only git-tracked code moves between workers: a task that keeps code in its
(git-ignored) task folder is refused — use pnpm loop for it instead.

Options
  --agent <name>              ${AGENTS.join(' | ')} (required)
  --workers <n>               Parallel workers, 1–${MAX_WORKERS} (default 2)
  --fix <n>                   Fix-until-green iterations per step after the
                              first run, 0–${MAX_ITERATIONS} (default 3)
  --stall <n>                 Stop a step after n fix iterations with no
                              progress (default 2)
  --timeout-min <n>           Wall-clock cap; no new claims after it (default 120)
  --iteration-timeout-min <n> Cap for one agent run (default 20)
  --bin "<cmd>"               Executable to run, split on spaces (no shell);
                              default: the tool registry entry, else <agent>
  --max-budget-usd <n>        Spend cap per agent run (claude only)
  --no-install                Skip pnpm install in new worktrees
  --dry-run                   Print what would run; start nothing
  --help                      Show this help

Exit code: 0 when every step is done and the final verify passes, else 1.
Logs: tasks/<task>/swarm/run-*/ (<step>.log, <step>.result.json)`;

/**
 * @typedef {{
 *   task?: string, agent?: string, bin?: string,
 *   workers: number, fix: number, stall: number,
 *   timeoutMin: number, iterationTimeoutMin: number,
 *   maxBudgetUsd?: number, install: boolean, dryRun: boolean, help: boolean,
 * }} SwarmCliOptions
 */

const VALUE_FLAGS = {
  '--agent': 'agent',
  '--workers': 'workers',
  '--fix': 'fix',
  '--stall': 'stall',
  '--timeout-min': 'timeoutMin',
  '--iteration-timeout-min': 'iterationTimeoutMin',
  '--bin': 'bin',
  '--max-budget-usd': 'maxBudgetUsd',
};

/**
 * @param {string} value
 * @param {string} flag
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function wholeNumber(value, flag, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(
      `${flag} must be a whole number from ${min} to ${max} (got "${value}")`
    );
  }
  return number;
}

/**
 * @param {string} value
 * @param {string} flag
 * @returns {number}
 */
function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number (got "${value}")`);
  }
  return number;
}

/**
 * @param {string[]} argv
 * @returns {SwarmCliOptions}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  const flags = { install: true, dryRun: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${flag} needs a value`);
      values[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)]] =
        value;
    } else if (flag === '--no-install') {
      flags.install = false;
    } else if (flag === '--dry-run') {
      flags.dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      flags.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg} (see pnpm swarm --help)`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    throw new Error(
      `pnpm swarm takes one task name (got ${positionals.join(', ')})`
    );
  }

  return {
    task: positionals[0],
    agent: values.agent,
    bin: values.bin,
    workers:
      values.workers === undefined
        ? 2
        : wholeNumber(values.workers, '--workers', 1, MAX_WORKERS),
    fix:
      values.fix === undefined
        ? 3
        : wholeNumber(values.fix, '--fix', 0, MAX_ITERATIONS),
    stall: values.stall === undefined ? 2 : parseMax(values.stall, '--stall'),
    timeoutMin:
      values.timeoutMin === undefined
        ? 120
        : positiveNumber(values.timeoutMin, '--timeout-min'),
    iterationTimeoutMin:
      values.iterationTimeoutMin === undefined
        ? 20
        : positiveNumber(values.iterationTimeoutMin, '--iteration-timeout-min'),
    maxBudgetUsd:
      values.maxBudgetUsd === undefined
        ? undefined
        : positiveNumber(values.maxBudgetUsd, '--max-budget-usd'),
    ...flags,
  };
}

/**
 * @typedef {import('./worker.js').WorkerConfig} WorkerConfig
 * @typedef {import('./worker.js').StepResult} StepResult
 * @typedef {(command: string, args: string[], options: object) => import('child_process').ChildProcess} SpawnAsync
 */

/**
 * Start a worker process with its output in `logFile`; resolve with the
 * result it wrote (or a crash result). Never rejects.
 *
 * @param {WorkerConfig} config
 * @param {string} logFile
 * @param {{ spawn?: SpawnAsync, script?: string }} [options]
 * @returns {Promise<StepResult>}
 */
export function startWorker(
  config,
  logFile,
  { spawn = spawnAsync, script = WORKER_SCRIPT } = {}
) {
  const configFile = config.resultFile.replace(
    /\.result\.json$/,
    '.config.json'
  );
  /** @param {string} detail @returns {StepResult} */
  const crashed = (detail) => ({
    ok: false,
    id: config.step.id,
    worker: config.worker,
    branch: config.branch,
    dir: config.dir,
    commit: null,
    reason: 'error',
    iterations: 0,
    failed: null,
    detail,
    logDir: null,
    durationMs: 0,
  });
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [script, configFile], {
      cwd: config.rootDir,
      stdio: ['ignore', fd, fd],
    });
    let settled = false;
    /** @param {StepResult} result */
    const settle = (result) => {
      if (settled) return;
      settled = true;
      fs.closeSync(fd);
      resolve(result);
    };
    child.on('error', (error) =>
      settle(crashed(`could not start the worker: ${error.message}`))
    );
    child.on('close', (code) => {
      try {
        settle(JSON.parse(fs.readFileSync(config.resultFile, 'utf-8')));
      } catch {
        settle(
          crashed(`the worker exited ${code} without a result; see ${logFile}`)
        );
      }
    });
  });
}

/**
 * @typedef {{
 *   rootDir: string,
 *   env: NodeJS.ProcessEnv,
 *   log: (message: string) => void,
 *   clock: () => number,
 *   date: () => Date,
 *   spawn: import('../loop/worktree.js').Spawn,
 *   install: import('../loop/worktree.js').Install,
 *   runCommands: typeof runCommands,
 *   startWorker: (config: WorkerConfig, logFile: string) => Promise<StepResult>,
 *   pid: number,
 *   isAlive: (pid: number) => boolean,
 * }} CliDeps
 */

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * @param {Partial<CliDeps>} [overrides]
 * @returns {CliDeps}
 */
export function defaultCliDeps(overrides = {}) {
  const spawn =
    overrides.spawn ??
    /** @type {import('../loop/worktree.js').Spawn} */ (spawnSync);
  return {
    rootDir: ROOT_DIR,
    env: process.env,
    log: console.log,
    clock: Date.now,
    date: () => new Date(),
    spawn,
    install: (dir) =>
      spawn('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
        cwd: dir,
        stdio: 'inherit',
      }),
    runCommands,
    startWorker: (config, logFile) => startWorker(config, logFile),
    pid: process.pid,
    isAlive,
    ...overrides,
  };
}

/**
 * @param {{ argv?: string[], deps?: Partial<CliDeps> }} [options]
 * @returns {Promise<number>}
 */
export async function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const d = defaultCliDeps(deps);
  const options = parseArgs(argv);
  if (options.help) {
    d.log(HELP);
    return 0;
  }
  if (!options.agent) {
    throw new Error(
      `--agent is required.\nFix: pnpm swarm ${options.task ?? '<task>'} --agent ${AGENTS.join('|')}`
    );
  }
  const command = buildCommand({
    agent: options.agent,
    bin: options.bin,
    argv: options.bin ? null : commandFor(d.rootDir, options.agent),
    maxBudgetUsd: options.maxBudgetUsd,
  });
  const name = resolveTaskName(d.rootDir, options.task);
  const { state, dir } = loadTask(d.rootDir, name);
  if (!state) {
    throw new Error(
      `${name} has no state.json, so the swarm has no steps to share.\nFix: pnpm task init ${name} --verify "pnpm check"`
    );
  }
  if (state.verify.length === 0) {
    throw new Error(
      `${name} has no verify commands, so swarm steps have no finish line.\nFix: pnpm task set --task ${name} --verify "pnpm check"`
    );
  }

  assertNoTaskCode(dir, name);
  if (options.dryRun) {
    const ready = readySteps(state);
    d.log(
      [
        `Task: ${name}`,
        `Agent: ${[command.bin, ...command.args].join(' ')} (prompt on stdin)`,
        `Workers: ${options.workers}; per step: 1 run + up to ${options.fix} fix iteration(s)`,
        `Verify: ${state.verify.join(' && ')}`,
        `Ready now: ${ready.length > 0 ? ready.map((s) => `${s.id}. ${s.title}`).join('; ') : 'none'}`,
        `Integration: ${swarmDir(d.rootDir, name)} on ${swarmBranch(name)}`,
        'Dry run: nothing was started.',
      ].join('\n')
    );
    return 0;
  }

  const result = await runSwarm({
    rootDir: d.rootDir,
    name,
    command,
    workers: options.workers,
    fixMax: options.fix,
    stall: options.stall,
    timeoutMs: options.timeoutMin * 60 * 1000,
    iterationTimeoutMs: options.iterationTimeoutMin * 60 * 1000,
    install: options.install,
    deps: {
      clock: d.clock,
      date: d.date,
      log: d.log,
      spawn: d.spawn,
      install: d.install,
      git: (cwd) => gitInfo(cwd, d.spawn),
      runCommands: d.runCommands,
      startWorker: d.startWorker,
      pid: d.pid,
      isAlive: d.isAlive,
    },
  });

  d.log(
    [
      `${result.ok ? '✓' : '✗'} ${name}: ${result.done.length} step(s) done, ${result.blocked.length} blocked${result.timedOut ? ' (wall-clock cap reached)' : ''}.`,
      ...result.blocked.map((b) => `  ${b.id}: ${b.reason}`),
      result.left ? `Left: ${result.left}` : '',
      result.finalVerify
        ? `Final verify on ${result.integration.branch}: ${result.finalVerify.ok ? 'pass' : `fail — \`${result.finalVerify.failed}\``}`
        : '',
      `Review: git log --oneline HEAD..${result.integration.branch} (worktree ${result.integration.dir}); merge it yourself.`,
      `Logs: ${result.runDir}`,
    ]
      .filter(Boolean)
      .join('\n')
  );
  return result.ok ? 0 : 1;
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, async () => {
  try {
    process.exit(await main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
