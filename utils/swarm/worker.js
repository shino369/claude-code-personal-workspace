#!/usr/bin/env node
/**
 * One `pnpm swarm` worker: runs a single claimed step in its own worktree.
 *
 * The dispatcher claims the step and starts this script as a separate
 * process (`node utils/swarm/worker.js <config.json>`), so several workers
 * run in parallel while each one uses the synchronous loop code. The worker
 * creates the step worktree from the integration branch, runs the agent on
 * the step, then reuses the outer loop (`runLoop`) to verify and fix until
 * the task's verify passes, and commits the result on the step branch. It
 * never touches the main checkout's state.json: the dispatcher records the
 * outcome from the result file.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { runAgent } from '../loop/adapters.js';
import { fingerprint, runLoop } from '../loop/driver.js';
import { runIfMain } from '../module-runner.js';
import { formatBrief, summarizeTask } from '../task/brief.js';
import { gitInfo } from '../task/git.js';
import { INNER_LOOP_ENV } from '../task/loop.js';
import { loadTask } from '../task/store.js';
import { runCommands } from '../task/verify.js';
import { addWorktree, commitAll, copyTask, installIfNeeded } from './git.js';

/**
 * @typedef {import('../loop/adapters.js').AgentCommand} AgentCommand
 * @typedef {import('../loop/worktree.js').Spawn} Spawn
 * @typedef {import('../loop/worktree.js').Install} Install
 * @typedef {{
 *   rootDir: string, task: string, worker: string,
 *   step: { id: string, title: string },
 *   done: Array<{ id: string, title: string }>,
 *   slot: string, branch: string, dir: string, base: string,
 *   command: AgentCommand,
 *   fixMax: number, stall: number, timeoutMs: number, iterationTimeoutMs: number,
 *   install: boolean, resultFile: string,
 * }} WorkerConfig
 * @typedef {{
 *   ok: boolean,
 *   id: string,
 *   worker: string,
 *   branch: string,
 *   dir: string,
 *   commit: string | null,
 *   reason: 'green' | 'max' | 'no-progress' | 'timeout' | 'commit' | 'error',
 *   iterations: number,
 *   failed: string | null,
 *   detail: string,
 *   logDir: string | null,
 *   durationMs: number,
 * }} StepResult
 * @typedef {{
 *   clock: () => number,
 *   date: () => Date,
 *   env: NodeJS.ProcessEnv,
 *   log: (message: string) => void,
 *   spawn: Spawn,
 *   install: Install,
 *   runAgent: typeof runAgent,
 *   runCommands: typeof runCommands,
 * }} WorkerDeps
 */

/**
 * The prompt for the first agent run on a step.
 *
 * @param {{ config: WorkerConfig, brief: string, verify: string[] }} input
 * @returns {string}
 */
export function buildStepPrompt({ config, brief, verify }) {
  const { task, worker, step, done } = config;
  return [
    `You are ${worker} in \`pnpm swarm\` for task ${task}, running unattended in a git worktree.`,
    '',
    `Your step: ${step.id}. ${step.title}`,
    '',
    'Other workers handle the other steps in parallel. Do only this step.',
    done.length > 0
      ? `Steps already done (their changes are in this worktree): ${done.map((s) => `${s.id}. ${s.title}`).join('; ')}`
      : 'No step is done yet.',
    '',
    'When you finish, these verify commands must pass (run from the repository root):',
    ...verify.map((command) => `  ${command}`),
    '',
    'Task brief:',
    brief,
    '',
    'Rules:',
    '- Work only in this directory. Do not commit, push, merge, or create branches; the swarm commits your work.',
    '- Do not run pnpm task step/claim/done/note: the swarm records progress in the main checkout.',
    '- Do not weaken, skip, or delete tests or checks, and do not change the verify commands.',
    '- Run the verify commands yourself before you finish.',
    '- Nobody will answer questions. If something blocks you, say what it is and stop.',
    '- Finish with a short summary: what you changed, and what still fails.',
  ].join('\n');
}

/**
 * Run one step: worktree, agent, verify-and-fix loop, commit.
 *
 * @param {{ config: WorkerConfig, deps: WorkerDeps }} options
 * @returns {StepResult}
 */
export function runStep({ config, deps }) {
  const started = deps.clock();
  /** @type {Omit<StepResult, 'ok' | 'reason' | 'detail' | 'durationMs'>} */
  const base = {
    id: config.step.id,
    worker: config.worker,
    branch: config.branch,
    dir: config.dir,
    commit: null,
    iterations: 0,
    failed: null,
    logDir: null,
  };
  /**
   * @param {Partial<StepResult> & Pick<StepResult, 'ok' | 'reason' | 'detail'>} fields
   * @returns {StepResult}
   */
  const finish = (fields) => ({
    ...base,
    ...fields,
    durationMs: deps.clock() - started,
  });

  try {
    addWorktree({
      rootDir: config.rootDir,
      dir: config.dir,
      branch: config.branch,
      base: config.base,
      spawn: deps.spawn,
    });
    copyTask({ rootDir: config.rootDir, dir: config.dir, task: config.task });
    if (config.install) installIfNeeded(config.dir, deps.install);

    const task = loadTask(config.dir, config.task);
    const verify = task.state?.verify ?? [];
    deps.log(`▶ ${config.worker} ${config.step.id}: ${config.command.agent}`);
    // The verify loop below decides; a failed or timed-out first run still
    // leaves its edits for the fix iterations.
    deps.runAgent({
      command: config.command,
      cwd: config.dir,
      prompt: buildStepPrompt({
        config,
        brief: formatBrief(
          summarizeTask(task, gitInfo(config.dir, deps.spawn))
        ),
        verify,
      }),
      timeoutMs: Math.min(config.iterationTimeoutMs, config.timeoutMs),
      env: {
        ...deps.env,
        [INNER_LOOP_ENV]: 'off',
        TASK_AGENT: config.worker,
      },
    });
    const loop = runLoop({
      rootDir: config.dir,
      name: config.task,
      command: config.command,
      max: config.fixMax,
      stall: config.stall,
      timeoutMs: Math.max(1, config.timeoutMs - (deps.clock() - started)),
      iterationTimeoutMs: config.iterationTimeoutMs,
      deps: {
        clock: deps.clock,
        date: deps.date,
        env: deps.env,
        log: deps.log,
        git: (cwd) => gitInfo(cwd, deps.spawn),
        fingerprint: (cwd) => fingerprint(cwd, deps.spawn),
        runAgent: (opts) =>
          deps.runAgent({
            ...opts,
            env: { ...opts.env, TASK_AGENT: config.worker },
          }),
        runCommands: deps.runCommands,
      },
    });
    base.iterations = loop.iterations;
    base.logDir = loop.iterations > 0 ? loop.logDir : null;
    if (!loop.ok) {
      return finish({
        ok: false,
        reason: loop.reason,
        failed: loop.lastVerify.failed,
        detail: loop.lastVerify.summary,
      });
    }

    const committed = commitAll({
      dir: config.dir,
      subject: `chore: swarm step ${config.step.id}`,
      body: `${config.step.id}. ${config.step.title}\n\nTask: ${config.task} (${config.worker}, ${config.command.agent})`,
      spawn: deps.spawn,
    });
    if (!committed.ok) {
      return finish({ ok: false, reason: 'commit', detail: committed.error });
    }
    base.commit = committed.sha;
    return finish({
      ok: true,
      reason: 'green',
      detail: committed.sha ? 'verify passed' : 'verify passed; no changes',
    });
  } catch (error) {
    return finish({
      ok: false,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * @param {Partial<WorkerDeps>} [overrides]
 * @returns {WorkerDeps}
 */
export function defaultWorkerDeps(overrides = {}) {
  const spawn = overrides.spawn ?? /** @type {Spawn} */ (spawnSync);
  return {
    clock: Date.now,
    date: () => new Date(),
    env: process.env,
    log: console.log,
    spawn,
    install: (dir) =>
      spawn('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
        cwd: dir,
        stdio: 'inherit',
      }),
    runAgent,
    runCommands,
    ...overrides,
  };
}

/**
 * Read the config, run the step, write the result file.
 *
 * @param {{ argv?: string[], deps?: Partial<WorkerDeps> }} [options]
 * @returns {StepResult}
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const [configFile] = argv;
  if (!configFile)
    throw new Error('Usage: node utils/swarm/worker.js <config.json>');
  /** @type {WorkerConfig} */
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
  const result = runStep({ config, deps: defaultWorkerDeps(deps) });
  fs.writeFileSync(config.resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/* c8 ignore next 8 - process entry point; the dispatcher reads the result file */
runIfMain(import.meta.url, () => {
  try {
    main();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
