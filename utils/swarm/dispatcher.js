/**
 * The `pnpm swarm` dispatcher: N workers share one task's plan.
 *
 * The dispatcher runs in the main checkout, which owns state.json. It claims
 * ready steps atomically (`claimStep` under the task lock, the same code as
 * `pnpm task claim`), starts one worker process per claimed step, and as each
 * worker finishes it merges the step branch into the integration branch
 * `swarm/<task>` (one merge at a time) and records the step as done or
 * blocked. A step's worktree branches from the integration branch at claim
 * time, so it contains every dependency it waited for.
 *
 * When nothing is left to claim or run, it re-runs the task's verify on the
 * integration worktree: steps that pass alone must also pass together.
 */
import fs from 'fs';
import path from 'path';
import { formatGit } from '../task/git.js';
import {
  appendSeparator,
  formatLocal,
  formatNoteEntry,
} from '../task/markdown.js';
import { claimStep, idleReason, setStepStatus } from '../task/state.js';
import {
  appendNotes,
  loadTask,
  readIfExists,
  tasksRoot,
  updateState,
  withLock,
  writeFileAtomic,
} from '../task/store.js';
import { summarize } from '../task/verify.js';
import { gitText } from '../loop/worktree.js';
import {
  addWorktree,
  copyTask,
  freeStepSlot,
  installIfNeeded,
  mergeBranch,
  swarmBranch,
  swarmDir,
} from './git.js';

/**
 * @param {unknown} error
 * @returns {string}
 */
const errorText = (error) =>
  error instanceof Error ? error.message : String(error);

/** Owners the swarm gives its workers: `<agent>/swarm-w<n>`. */
export const SWARM_OWNER_RE = /\/swarm-w\d+$/;
export const LOCK_FILE = 'swarm.lock';

/**
 * @typedef {import('./worker.js').WorkerConfig} WorkerConfig
 * @typedef {import('./worker.js').StepResult} StepResult
 * @typedef {import('../loop/adapters.js').AgentCommand} AgentCommand
 * @typedef {import('../task/state.js').VerifyResult} VerifyResult
 * @typedef {{
 *   clock: () => number,
 *   date: () => Date,
 *   log: (message: string) => void,
 *   spawn: import('../loop/worktree.js').Spawn,
 *   install: import('../loop/worktree.js').Install,
 *   git: (cwd: string) => import('../task/git.js').GitInfo,
 *   runCommands: typeof import('../task/verify.js').runCommands,
 *   startWorker: (config: WorkerConfig, logFile: string) => Promise<StepResult>,
 *   pid: number,
 *   isAlive: (pid: number) => boolean,
 * }} SwarmDeps
 * @typedef {{
 *   rootDir: string, name: string, command: AgentCommand, workers: number,
 *   fixMax: number, stall: number, timeoutMs: number, iterationTimeoutMs: number,
 *   install: boolean, deps: SwarmDeps,
 * }} SwarmOptions
 * @typedef {{
 *   ok: boolean,
 *   done: string[],
 *   blocked: Array<{ id: string, reason: string }>,
 *   left: string,
 *   claims: Array<{ id: string, worker: string }>,
 *   integration: { dir: string, branch: string },
 *   finalVerify: VerifyResult | null,
 *   runDir: string,
 *   timedOut: boolean,
 * }} SwarmResult
 */

/**
 * Take the task's swarm lock (one swarm per task). A lock whose process is
 * gone is taken over. The check and the write happen under the task's state
 * lock (`withLock`), so two swarms starting at once cannot both win, and the
 * pid is written atomically, so a reader never sees a half-written lock.
 *
 * @param {string} taskDir
 * @param {{ pid: number, isAlive: (pid: number) => boolean }} deps
 * @returns {() => void} release (removes the lock only while it is ours)
 */
export function acquireSwarmLock(taskDir, { pid, isAlive }) {
  const file = path.join(taskDir, LOCK_FILE);
  /** @returns {number} */
  const holder = () => Number(readIfExists(file)?.trim() || 0);
  withLock(taskDir, () => {
    const current = holder();
    if (
      Number.isInteger(current) &&
      current > 0 &&
      current !== pid &&
      isAlive(current)
    ) {
      throw new Error(
        `Another pnpm swarm (pid ${current}) is running this task.\nFix: wait for it, or stop it; if it is gone, delete ${file}`
      );
    }
    writeFileAtomic(file, `${pid}\n`);
  });
  return () => {
    if (holder() === pid) fs.rmSync(file, { force: true });
  };
}

/**
 * Give back steps that a dead swarm run left in progress.
 *
 * @param {string} rootDir
 * @param {string} name
 * @param {Date} now
 * @returns {string[]} released step ids
 */
export function releaseStaleClaims(rootDir, name, now) {
  /** @type {string[]} */
  const released = [];
  updateState(
    rootDir,
    name,
    (state) => {
      let next = state;
      for (const step of state.steps) {
        if (
          step.status === 'in_progress' &&
          step.owner &&
          SWARM_OWNER_RE.test(step.owner)
        ) {
          next = setStepStatus(next, {
            id: step.id,
            status: 'todo',
            now,
          }).state;
          released.push(step.id);
        }
      }
      return next;
    },
    { now }
  );
  return released;
}

/**
 * Run the swarm until no step can be claimed and no worker is running.
 *
 * @param {SwarmOptions} options
 * @returns {Promise<SwarmResult>}
 */
export async function runSwarm({
  rootDir,
  name,
  command,
  workers,
  fixMax,
  stall,
  timeoutMs,
  iterationTimeoutMs,
  install,
  deps,
}) {
  const started = deps.clock();
  const taskDir = path.join(tasksRoot(rootDir), name);
  const initial = loadTask(rootDir, name).state;
  if (!initial || initial.verify.length === 0) {
    throw new Error(
      `${name} has no verify commands, so swarm steps have no finish line.\nFix: pnpm task set --task ${name} --verify "pnpm check"`
    );
  }
  const release = acquireSwarmLock(taskDir, deps);
  try {
    const released = releaseStaleClaims(rootDir, name, deps.date());
    if (released.length > 0) {
      deps.log(
        `! released steps left by an earlier swarm: ${released.join(', ')}`
      );
    }

    const runDir = path.join(
      taskDir,
      'swarm',
      `run-${formatLocal(deps.date(), { withTime: true }).replace(/[^0-9]/g, '')}`
    );
    fs.mkdirSync(runDir, { recursive: true });

    const branch = swarmBranch(name);
    const dir = swarmDir(rootDir, name);
    const head = gitText(deps.spawn, rootDir, ['rev-parse', 'HEAD']);
    if (!head) {
      throw new Error(
        `${rootDir} has no commit to start the swarm from.\nFix: commit first, then re-run pnpm swarm`
      );
    }
    if (gitText(deps.spawn, rootDir, ['status', '--porcelain'])) {
      deps.log(
        '! The main checkout has uncommitted changes; they are NOT in the swarm worktrees (they start from HEAD).'
      );
    }
    const { created } = addWorktree({
      rootDir,
      dir,
      branch,
      base: head,
      spawn: deps.spawn,
    });
    deps.log(
      `Integration: ${dir} on ${branch}${created ? ' (created)' : ' (reused)'}`
    );

    /** @type {Map<number, Promise<{ slot: number, result: StepResult }>>} */
    const running = new Map();
    /** @type {SwarmResult['claims']} */
    const claims = [];
    /** @type {string[]} */
    const done = [];
    /** @type {SwarmResult['blocked']} */
    const blocked = [];
    let timedOut = false;

    /** @param {number} slot */
    const claimNext = (slot) => {
      const worker = `${command.agent}/swarm-w${slot}`;
      /** @type {import('../task/state.js').Step | null} */
      let step = null;
      const state = updateState(
        rootDir,
        name,
        (current) => {
          const result = claimStep(current, {
            agent: worker,
            now: deps.date(),
          });
          step = result.step;
          return result.state;
        },
        { now: deps.date(), agent: worker }
      );
      const claimed = /** @type {import('../task/state.js').Step | null} */ (
        step
      );
      if (!claimed) return 'none';
      claims.push({ id: claimed.id, worker });
      try {
        start(slot, worker, claimed, state);
        return 'started';
      } catch (error) {
        // The step is claimed but has no worker: block it so it is not left
        // in progress, and keep going with the other steps and workers.
        safeRecord({
          ok: false,
          id: claimed.id,
          worker,
          branch: '',
          dir: '',
          commit: null,
          reason: 'error',
          iterations: 0,
          failed: null,
          detail: `could not start the worker: ${errorText(error)}`,
          logDir: null,
          durationMs: 0,
        });
        return 'failed';
      }
    };

    /**
     * @param {number} slot
     * @param {string} worker
     * @param {import('../task/state.js').Step} claimed
     * @param {import('../task/state.js').TaskState} state
     */
    const start = (slot, worker, claimed, state) => {
      const target = freeStepSlot({
        rootDir,
        task: name,
        id: claimed.id,
        spawn: deps.spawn,
      });
      const base = /** @type {string} */ (
        gitText(deps.spawn, dir, ['rev-parse', 'HEAD'])
      );
      /** @type {WorkerConfig} */
      const config = {
        rootDir,
        task: name,
        worker,
        step: { id: claimed.id, title: claimed.title },
        done: state.steps
          .filter((s) => s.status === 'done')
          .map((s) => ({ id: s.id, title: s.title })),
        ...target,
        base,
        command,
        fixMax,
        stall,
        timeoutMs: Math.max(1, timeoutMs - (deps.clock() - started)),
        iterationTimeoutMs,
        install,
        resultFile: path.join(runDir, `${target.slot}.result.json`),
      };
      const configFile = path.join(runDir, `${target.slot}.config.json`);
      fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
      deps.log(
        `▶ ${worker} claimed ${claimed.id}. ${claimed.title} → ${target.dir}`
      );
      running.set(
        slot,
        deps
          .startWorker(config, path.join(runDir, `${target.slot}.log`))
          .then((result) => ({ slot, result }))
      );
    };

    /** @param {StepResult} result */
    const record = (result) => {
      let outcome = result;
      /** @type {string} */
      let note;
      if (result.ok) {
        if (result.commit) {
          const merged = mergeBranch({
            dir,
            branch: result.branch,
            subject: `chore: merge swarm step ${result.id}`,
            spawn: deps.spawn,
          });
          if (!merged.ok) {
            outcome = {
              ...result,
              ok: false,
              reason: 'commit',
              detail: merged.error,
            };
          }
        }
        note = result.commit
          ? `merged ${result.branch} (${result.commit.slice(0, 7)}) into ${branch}`
          : 'verify passed with no changes';
      } else {
        note = '';
      }
      const failure = `${outcome.reason}${outcome.failed ? ` — \`${outcome.failed}\` fails` : ''}: ${outcome.detail.split('\n')[0]}`;
      const message = outcome.ok
        ? `${note} by ${result.worker}`
        : `swarm ${result.worker}: ${failure}.${result.dir ? ` Worktree ${result.dir}` : ''}${result.logDir ? `; logs ${result.logDir}` : ''}`;
      updateState(
        rootDir,
        name,
        (state) =>
          setStepStatus(state, {
            id: result.id,
            status: outcome.ok ? 'done' : 'blocked',
            agent: result.worker,
            note: message,
            now: deps.date(),
          }).state,
        { now: deps.date(), agent: result.worker }
      );
      appendNotes(
        taskDir,
        formatNoteEntry({
          at: deps.date(),
          agent: result.worker,
          label: `step ${result.id} ${outcome.ok ? 'done' : 'blocked'}`,
          message: `${result.id} → ${outcome.ok ? 'done' : 'blocked'}: ${message} (${Math.round(result.durationMs / 1000)}s)`,
        }),
        appendSeparator
      );
      if (outcome.ok) {
        done.push(result.id);
        deps.log(`✓ ${result.worker} ${result.id}: ${note}`);
      } else {
        blocked.push({ id: result.id, reason: failure });
        deps.log(`✗ ${result.worker} ${result.id} blocked: ${failure}`);
      }
    };

    /**
     * Record a result without ending the run: other workers may still be
     * running, and an aborted dispatcher would leave their steps unrecorded.
     *
     * @param {StepResult} result
     */
    const safeRecord = (result) => {
      try {
        record(result);
      } catch (error) {
        const reason = `could not record the result: ${errorText(error)}`;
        blocked.push({ id: result.id, reason });
        deps.log(`✗ ${result.worker} ${result.id}: ${reason}`);
      }
    };

    for (;;) {
      for (let slot = 1; slot <= workers; slot++) {
        if (running.has(slot)) continue;
        if (deps.clock() - started >= timeoutMs) {
          timedOut = true;
          break;
        }
        let claimed = claimNext(slot);
        while (claimed === 'failed') claimed = claimNext(slot);
        if (claimed === 'none') break;
      }
      if (running.size === 0) break;
      const { slot, result } = await Promise.race(running.values());
      running.delete(slot);
      safeRecord(result);
    }

    // state.json existed at the start (checked above) and is never deleted.
    const left = /** @type {import('../task/state.js').TaskState} */ (
      loadTask(rootDir, name).state
    );
    const remaining = idleReason(left);
    /** @type {VerifyResult | null} */
    let finalVerify = null;
    if (done.length > 0) {
      copyTask({ rootDir, dir, task: name });
      if (install) installIfNeeded(dir, deps.install);
      deps.log(`▶ final verify on ${branch}: ${initial.verify.join(' && ')}`);
      finalVerify = summarize(
        deps.runCommands({ commands: initial.verify, cwd: dir }),
        deps.date()
      );
      deps.log(
        finalVerify.ok
          ? '✓ final verify passed'
          : `✗ final verify: \`${finalVerify.failed}\` fails`
      );
    }
    const allDone = left.steps.every((s) => s.status === 'done');
    const ok = allDone && blocked.length === 0 && (finalVerify?.ok ?? true);

    appendNotes(
      taskDir,
      formatNoteEntry({
        at: deps.date(),
        agent: command.agent,
        label: 'auto: swarm',
        message: [
          `pnpm swarm --agent ${command.agent} --workers ${workers}: ${done.length} step(s) done${done.length ? ` (${done.join(', ')})` : ''}, ${blocked.length} blocked${blocked.length ? ` (${blocked.map((b) => b.id).join(', ')})` : ''}${timedOut ? '; stopped at the wall-clock cap' : ''}.`,
          finalVerify
            ? `Final verify on ${branch}: ${finalVerify.ok ? 'pass' : `fail — \`${finalVerify.failed}\``}.`
            : 'No step merged, so no final verify.',
          allDone ? '' : `Left: ${remaining}.`,
          `Review: git log --oneline HEAD..${branch} (worktree ${dir}); merge it yourself. Logs: ${path.relative(rootDir, runDir)}/`,
        ]
          .filter(Boolean)
          .join(' '),
        state: `${formatGit(deps.git(rootDir))}; verify ${finalVerify ? (finalVerify.ok ? 'pass' : 'fail') : 'not run'} (on ${branch})`,
      }),
      appendSeparator
    );

    return {
      ok,
      done,
      blocked,
      left: allDone ? '' : remaining,
      claims,
      integration: { dir, branch },
      finalVerify,
      runDir,
      timedOut,
    };
  } finally {
    release();
  }
}
