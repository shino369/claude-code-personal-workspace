#!/usr/bin/env node
/**
 * `pnpm loop [task] --agent claude|codex|dsh` — the outer loop. Runs a
 * headless agent in a git worktree until the task's verify passes, then stops
 * on green, at --max, on no progress, or at the wall-clock cap. With --review
 * (code tasks) it then runs the quality loop headless: review rounds by a
 * read-only reviewer and triage, and fixes of confirmed must-fix/high findings.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { runIfMain } from '../module-runner.js';
import { main as taskMain } from '../task/cli.js';
import { defaultRunGit } from '../task/review.js';
import { gitInfo } from '../task/git.js';
import { parseMax, scopeFingerprint } from '../task/loop.js';
import { loadTask, resolveTaskName } from '../task/store.js';
import { runCommands } from '../task/verify.js';
import { commandFor } from '../tools/registry.js';
import { ROOT_DIR } from '../workspace-config.js';
import { AGENTS, buildCommand, runAgent } from './adapters.js';
import { fingerprint, runLoop } from './driver.js';
import { runReviewLoop } from './review-loop.js';
import { prepareWorktree, worktreePath } from './worktree.js';

export const HELP = `Usage: pnpm loop [task] --agent ${AGENTS.join('|')} [options]

Re-runs a headless agent until the task's verify commands pass. Runs in a git
worktree: from the main checkout it creates (or reuses) ../<repo>-wt/<task> on
branch loop/<task>, copies the task folder there, and installs dependencies.

Options
  --agent <name>              ${AGENTS.join(' | ')} (required)
  --review                    Code tasks: after verify passes, run the quality
                              loop — review round (reviewer + triage, read-only,
                              fresh agents), fix confirmed must-fix/high
                              findings, at most 2 rounds (AGENTS.md §4.5)
  --reviewer <name>           Agent for the reviewer and the triage (default:
                              --agent; a different one gives a second opinion)
  --max <n>                   Agent iterations at most (default 5; with
                              --review, per build or fix phase)
  --stall <n>                 Stop after n iterations in a row with no progress
                              (no file changes, or the same failure) (default 2)
  --timeout-min <n>           Wall-clock cap for the whole run (default 60)
  --iteration-timeout-min <n> Cap for one agent run (default 20)
  --bin "<cmd>"               Executable to run, split on spaces (no shell),
                              e.g. --bin "npx -y @deepseek-ai/dsh"; default: the
                              tool registry entry (pnpm tools list), else <agent>
  --max-budget-usd <n>        Spend cap per iteration (claude only)
  --dry-run                   Print the plan and the first prompt; run nothing
  --help                      Show this help

Exit code: 0 when verify passes (with --review: when the quality loop is
complete), 1 otherwise. Logs: tasks/<task>/loop/run-*/ (iter-N.md; review
rounds: run-*-review/rN-reviewer.md, rN-triage.md)`;

/**
 * @typedef {{
 *   task?: string, agent?: string, bin?: string, review: boolean, reviewer?: string,
 *   max: number, stall: number, timeoutMin: number, iterationTimeoutMin: number,
 *   maxBudgetUsd?: number, dryRun: boolean, help: boolean,
 * }} LoopOptions
 */

const VALUE_FLAGS = {
  '--agent': 'agent',
  '--reviewer': 'reviewer',
  '--max': 'max',
  '--stall': 'stall',
  '--timeout-min': 'timeoutMin',
  '--iteration-timeout-min': 'iterationTimeoutMin',
  '--bin': 'bin',
  '--max-budget-usd': 'maxBudgetUsd',
};

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
 * @returns {LoopOptions}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const positionals = [];
  let dryRun = false;
  let help = false;
  let review = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${flag} needs a value`);
      values[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)]] =
        value;
    } else if (flag === '--review') {
      review = true;
    } else if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--help' || flag === '-h') {
      help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg} (see pnpm loop --help)`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    throw new Error(
      `pnpm loop takes one task name (got ${positionals.join(', ')})`
    );
  }

  return {
    task: positionals[0],
    agent: values.agent,
    bin: values.bin,
    review,
    reviewer: values.reviewer,
    max: values.max === undefined ? 5 : parseMax(values.max, '--max'),
    stall: values.stall === undefined ? 2 : parseMax(values.stall, '--stall'),
    timeoutMin:
      values.timeoutMin === undefined
        ? 60
        : positiveNumber(values.timeoutMin, '--timeout-min'),
    iterationTimeoutMin:
      values.iterationTimeoutMin === undefined
        ? 20
        : positiveNumber(values.iterationTimeoutMin, '--iteration-timeout-min'),
    maxBudgetUsd:
      values.maxBudgetUsd === undefined
        ? undefined
        : positiveNumber(values.maxBudgetUsd, '--max-budget-usd'),
    dryRun,
    help,
  };
}

/**
 * @typedef {{
 *   rootDir: string,
 *   env: NodeJS.ProcessEnv,
 *   log: (message: string) => void,
 *   clock: () => number,
 *   date: () => Date,
 *   spawn: import('./worktree.js').Spawn,
 *   install?: import('./worktree.js').Install,
 *   runAgent: typeof runAgent,
 *   runCommands: typeof runCommands,
 *   runGit: import('../task/review.js').RunGit,
 * }} CliDeps
 */

/**
 * @param {Partial<CliDeps>} [overrides]
 * @returns {CliDeps}
 */
export function defaultCliDeps(overrides = {}) {
  return {
    rootDir: ROOT_DIR,
    env: process.env,
    log: console.log,
    clock: Date.now,
    date: () => new Date(),
    spawn: /** @type {import('./worktree.js').Spawn} */ (spawnSync),
    runAgent,
    runCommands,
    runGit: defaultRunGit,
    ...overrides,
  };
}

/**
 * @param {{ argv?: string[], deps?: Partial<CliDeps> }} [options]
 * @returns {number}
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const d = defaultCliDeps(deps);
  const options = parseArgs(argv);
  if (options.help) {
    d.log(HELP);
    return 0;
  }
  if (!options.agent) {
    throw new Error(
      `--agent is required.\nFix: pnpm loop ${options.task ?? '<task>'} --agent ${AGENTS.join('|')}`
    );
  }
  const command = buildCommand({
    agent: options.agent,
    bin: options.bin,
    argv: options.bin ? null : commandFor(d.rootDir, options.agent),
    maxBudgetUsd: options.maxBudgetUsd,
  });
  const name = resolveTaskName(d.rootDir, options.task);
  const { state } = loadTask(d.rootDir, name);
  if (!state) {
    throw new Error(
      `${name} has no state.json, so it has no verify commands.\nFix: pnpm task init ${name} --verify "pnpm check"`
    );
  }
  if (state.verify.length === 0) {
    throw new Error(
      `${name} has no verify commands, so the loop has no finish line.\nFix: pnpm task set --task ${name} --verify "pnpm check"`
    );
  }
  if (options.reviewer && !options.review) {
    throw new Error(
      `--reviewer only applies with --review.\nFix: pnpm loop ${name} --agent ${options.agent} --review --reviewer ${options.reviewer}`
    );
  }
  if (options.review && state.kind !== 'code') {
    throw new Error(
      `--review needs a code task (${name} is not one).\nFix: pnpm task set --task ${name} --kind code`
    );
  }
  const reviewerName = options.reviewer ?? options.agent;
  const reviewer = options.review
    ? buildCommand({
        agent: reviewerName,
        mode: 'read',
        bin: reviewerName === options.agent ? options.bin : undefined,
        argv:
          options.bin && reviewerName === options.agent
            ? null
            : commandFor(d.rootDir, reviewerName),
      })
    : null;

  if (options.dryRun) {
    d.log(
      [
        `Task: ${name}`,
        `Agent: ${[command.bin, ...command.args].join(' ')} (prompt on stdin)`,
        `Verify: ${state.verify.join(' && ')}`,
        ...(reviewer
          ? [
              `Review: reviewer + triage: ${[reviewer.bin, ...reviewer.args].join(' ')} (read-only)`,
            ]
          : []),
        `Caps: max ${options.max} iteration(s), stall ${options.stall}, ${options.timeoutMin} min total, ${options.iterationTimeoutMin} min per agent run`,
        `Worktree: ${worktreePath(d.rootDir, name)} (or in place when already in a linked worktree)`,
        'Dry run: nothing was started.',
      ].join('\n')
    );
    return 0;
  }

  const worktree = prepareWorktree({
    rootDir: d.rootDir,
    task: name,
    spawn: d.spawn,
    ...(d.install ? { install: d.install } : {}),
  });
  for (const warning of worktree.warnings) d.log(`! ${warning}`);
  d.log(
    worktree.inPlace
      ? `Running in this worktree: ${worktree.dir}`
      : `Worktree: ${worktree.dir}${worktree.created ? ' (created)' : ' (reused)'}`
  );

  /** @type {import('./driver.js').LoopDeps} */
  const loopDeps = {
    clock: d.clock,
    date: d.date,
    env: d.env,
    log: d.log,
    git: (cwd) => gitInfo(cwd, d.spawn),
    fingerprint: (cwd) => fingerprint(cwd, d.spawn),
    runAgent: (opts) => d.runAgent(opts),
    runCommands: d.runCommands,
  };
  const run = {
    rootDir: worktree.dir,
    name,
    command,
    max: options.max,
    stall: options.stall,
    timeoutMs: options.timeoutMin * 60 * 1000,
    iterationTimeoutMs: options.iterationTimeoutMin * 60 * 1000,
  };
  const taskDir = path.join(worktree.dir, 'tasks', name);
  const review = worktree.inPlace
    ? 'Review the diff here (git diff), then commit it yourself.'
    : `Review: cd ${worktree.dir} && git diff — commit there, then merge branch loop/${name}.`;

  if (reviewer) {
    const outcome = runReviewLoop({
      ...run,
      reviewer,
      deps: {
        ...loopDeps,
        runTask: (argv) => {
          /** @type {string[]} */
          const out = [];
          taskMain({
            argv,
            deps: {
              rootDir: worktree.dir,
              env: d.env,
              now: d.date,
              log: (message) => out.push(message),
              runCommands: d.runCommands,
              runGit: d.runGit,
            },
          });
          return out.join('\n');
        },
        scopeFingerprint: (rootDir, dir, current) =>
          scopeFingerprint(
            /** @type {import('../task/deps.js').Deps} */ ({
              rootDir,
              runGit: d.runGit,
            }),
            dir,
            current
          ),
      },
    });
    d.log(
      [
        `${outcome.ok ? '✓' : '✗'} ${name}: quality loop ${outcome.ok ? 'complete' : `stopped (${outcome.reason})`} — ${outcome.detail}`,
        `Logs: ${path.join(taskDir, 'loop')}/`,
        `Task files: ${taskDir} (findings: reviews/, summary: NOTES.md)`,
        review,
      ].join('\n')
    );
    return outcome.ok ? 0 : 1;
  }

  const result = runLoop({ ...run, deps: loopDeps });

  d.log(
    [
      result.ok
        ? `✓ ${name}: verify passed after ${result.iterations} agent iteration(s).`
        : `✗ ${name}: ${result.reason === 'no-progress' ? 'no progress' : result.reason === 'timeout' ? 'wall-clock cap reached' : `still failing after ${result.iterations} iteration(s)`} — \`${result.lastVerify.failed}\` fails.`,
      `Logs: ${result.logDir}`,
      `Task files: ${taskDir}`,
      review,
    ].join('\n')
  );
  return result.ok ? 0 : 1;
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, () => {
  try {
    process.exit(main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
