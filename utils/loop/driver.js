/**
 * The outer loop: re-run a headless agent until the task's verify passes, the
 * iteration cap is reached, no progress is made, or the wall clock runs out.
 *
 * Every side effect comes in through `deps`, so the loop is tested without
 * real agents. Verification is the task's own `verify` list (the same check as
 * `pnpm task verify`), never the agent's opinion.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { formatBrief, summarizeTask } from '../task/brief.js';
import { withCheck } from '../task/check.js';
import { formatGit } from '../task/git.js';
import { INNER_LOOP_ENV, failureSignature } from '../task/loop.js';
import {
  appendSeparator,
  formatLocal,
  formatNoteEntry,
} from '../task/markdown.js';
import {
  appendNotes,
  loadTask,
  tasksRoot,
  updateState,
} from '../task/store.js';
import { summarize, tail } from '../task/verify.js';
import { gitText } from './worktree.js';
import { relPosix } from '../paths.js';

/** Lines of agent output kept in each iteration log. */
export const OUTPUT_TAIL_LINES = 60;

/**
 * @typedef {import('../task/state.js').VerifyResult} VerifyResult
 * @typedef {import('./adapters.js').AgentCommand} AgentCommand
 * @typedef {import('./adapters.js').AgentResult} AgentResult
 * @typedef {'green' | 'max' | 'no-progress' | 'timeout'} StopReason
 * @typedef {{
 *   clock: () => number,
 *   date: () => Date,
 *   env: NodeJS.ProcessEnv,
 *   log: (message: string) => void,
 *   git: (cwd: string) => import('../task/git.js').GitInfo,
 *   fingerprint: (cwd: string) => string | null,
 *   runAgent: (options: { command: AgentCommand, cwd: string, prompt: string, timeoutMs: number, env: NodeJS.ProcessEnv }) => AgentResult,
 *   runCommands: typeof import('../task/verify.js').runCommands,
 * }} LoopDeps
 * @typedef {{ ok: boolean, reason: StopReason, iterations: number, lastVerify: VerifyResult, logDir: string }} LoopResult
 */

/**
 * Hash of the working tree's uncommitted state (status + diff against HEAD).
 * Null when git cannot answer, which never counts as "unchanged".
 *
 * @param {string} cwd
 * @param {import('./worktree.js').Spawn} spawn
 * @returns {string | null}
 */
export function fingerprint(cwd, spawn) {
  const status = gitText(spawn, cwd, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  const diff = gitText(spawn, cwd, ['diff', 'HEAD', '--no-color']);
  if (status === null || diff === null) return null;
  return crypto
    .createHash('sha256')
    .update(`${status}\n\0\n${diff}`)
    .digest('hex');
}

/**
 * The prompt for one iteration. `pending` lists work besides a green verify
 * (the open `fix:` steps of a review round), one line each.
 *
 * @param {{ name: string, iteration: number, max: number, verify: string[], lastVerify: VerifyResult, brief: string, pending?: string[] }} input
 * @returns {string}
 */
export function buildPrompt({
  name,
  iteration,
  max,
  verify,
  lastVerify,
  brief,
  pending = [],
}) {
  return [
    `You are running unattended: iteration ${iteration} of ${max} of \`pnpm loop\` for task ${name}.`,
    '',
    ...(pending.length > 0
      ? [
          'Your goal: fix these confirmed review findings test-first (first a failing test that shows the problem, then the fix), and mark each step done once it is fixed:',
          ...pending.map((line) => `  ${line}`),
          '',
          'Fix only these; the other findings were recorded and are out of scope. Then make these verify commands pass (run from the repository root):',
        ]
      : [
          'Your goal: make these verify commands pass (run from the repository root):',
        ]),
    ...verify.map((command) => `  ${command}`),
    '',
    ...(lastVerify.ok
      ? ['Last verify: passed.']
      : [
          `Last verify: \`${lastVerify.failed}\` failed. Output tail:`,
          '```',
          lastVerify.summary,
          '```',
        ]),
    '',
    'Task brief:',
    brief,
    '',
    'Rules:',
    '- Work only in this directory (a git worktree). Do not commit, push, or create branches.',
    '- Fix the cause. Do not weaken, skip, or delete tests or checks, and do not change the verify commands.',
    '- Run the verify commands yourself before you finish.',
    '- Nobody will answer questions. If something blocks you, say what it is and stop.',
    '- Finish with a short summary: what you changed, and what still fails.',
  ].join('\n');
}

/**
 * The markdown log for one iteration.
 *
 * @param {{ iteration: number, max: number, command: AgentCommand, agent: AgentResult, diffStat: string | null, verify: VerifyResult, progress: string }} input
 * @returns {string}
 */
export function formatIterationLog({
  iteration,
  max,
  command,
  agent,
  diffStat,
  verify,
  progress,
}) {
  return [
    `# Iteration ${iteration}/${max} — ${command.agent}`,
    '',
    `- Command: \`${[command.bin, ...command.args].join(' ')}\` (prompt on stdin)`,
    `- Agent exit: ${agent.signal ? `stopped by ${agent.signal}` : agent.code} in ${Math.round(agent.durationMs / 1000)}s`,
    `- Diff vs HEAD: ${diffStat ?? 'none'}`,
    `- Verify: ${verify.ok ? 'pass' : `fail — \`${verify.failed}\``}`,
    `- Progress: ${progress}`,
    '',
    '## Verify output',
    '',
    '```',
    verify.summary,
    '```',
    '',
    '## Agent output (tail)',
    '',
    '```',
    tail(agent.output, OUTPUT_TAIL_LINES),
    '```',
    '',
  ].join('\n');
}

/**
 * Run the outer loop for one task in `rootDir` (already a worktree).
 *
 * The loop is done when verify passes and `pending(state)` (default: none)
 * lists nothing; `label` names the phase in the log folder and the note.
 *
 * @param {{ rootDir: string, name: string, command: AgentCommand, max: number, stall: number, timeoutMs: number, iterationTimeoutMs: number, deps: LoopDeps, pending?: (state: import('../task/state.js').TaskState) => string[], label?: string }} options
 * @returns {LoopResult}
 */
export function runLoop({
  rootDir,
  name,
  command,
  max,
  stall,
  timeoutMs,
  iterationTimeoutMs,
  deps,
  pending = () => [],
  label,
}) {
  const started = deps.clock();
  const startedAt = deps.date();
  const taskDir = path.join(tasksRoot(rootDir), name);
  const logDir = path.join(
    taskDir,
    'loop',
    `run-${formatLocal(startedAt, { withTime: true }).replace(/[^0-9]/g, '')}${label ? `-${label}` : ''}`
  );
  const initial = loadTask(rootDir, name).state;
  if (!initial || initial.verify.length === 0) {
    throw new Error(
      `${name} has no verify commands, so the loop has no finish line.\nFix: pnpm task set --task ${name} --verify "pnpm check"`
    );
  }
  const verify = withCheck(initial.verify, { name, taskDir });

  /** @returns {VerifyResult} */
  const check = () => {
    const result = summarize(
      deps.runCommands({ commands: verify, cwd: rootDir }),
      deps.date()
    );
    updateState(rootDir, name, (state) => ({ ...state, lastVerify: result }), {
      now: deps.date(),
      agent: command.agent,
    });
    return result;
  };

  deps.log(`▶ baseline verify: ${verify.join(' && ')}`);
  let lastVerify = check();
  /** @returns {string[]} */
  const open = () =>
    pending(
      /** @type {import('../task/state.js').TaskState} */ (
        loadTask(rootDir, name).state
      )
    );
  let todo = open();
  const finished = () => lastVerify.ok && todo.length === 0;
  /** @type {StopReason} */
  let reason = finished() ? 'green' : 'max';
  let iterations = 0;
  let previous = failureSignature(lastVerify);
  let stalls = 0;

  while (!finished() && iterations < max) {
    const remaining = timeoutMs - (deps.clock() - started);
    if (remaining <= 0) {
      reason = 'timeout';
      break;
    }
    iterations += 1;
    const before = deps.fingerprint(rootDir);
    const brief = formatBrief(
      summarizeTask(loadTask(rootDir, name), deps.git(rootDir))
    );
    deps.log(`▶ iteration ${iterations}/${max}: ${command.agent}`);
    const agent = deps.runAgent({
      command,
      cwd: rootDir,
      prompt: buildPrompt({
        name,
        iteration: iterations,
        max,
        verify,
        lastVerify,
        brief,
        pending: todo,
      }),
      timeoutMs: Math.min(remaining, iterationTimeoutMs),
      env: { ...deps.env, [INNER_LOOP_ENV]: 'off', TASK_AGENT: command.agent },
    });
    const after = deps.fingerprint(rootDir);
    lastVerify = check();
    todo = open();

    const signature = failureSignature(lastVerify);
    const unchanged = before !== null && before === after;
    const repeated = signature !== null && signature === previous;
    stalls = !finished() && (unchanged || repeated) ? stalls + 1 : 0;
    previous = signature;

    const progress = finished()
      ? 'verify passed'
      : lastVerify.ok
        ? `verify passed, ${todo.length} step(s) still open${unchanged ? ` (no file changes; ${stalls}/${stall})` : ''}`
        : unchanged || repeated
          ? `none (${[unchanged && 'no file changes', repeated && 'same failure'].filter(Boolean).join(', ')}; ${stalls}/${stall})`
          : 'new failure';
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, `iter-${iterations}.md`),
      formatIterationLog({
        iteration: iterations,
        max,
        command,
        agent,
        diffStat: deps.git(rootDir).diffStat,
        verify: lastVerify,
        progress,
      }),
      'utf-8'
    );
    deps.log(
      `  ${lastVerify.ok ? '✓ verify passed' : `✗ \`${lastVerify.failed}\` failed`} — progress: ${progress}`
    );

    if (finished()) {
      reason = 'green';
    } else if (stalls >= stall) {
      reason = 'no-progress';
      break;
    } else if (deps.clock() - started >= timeoutMs) {
      reason = 'timeout';
      break;
    }
  }

  /** @type {Record<StopReason, string>} */
  const outcome = {
    green: label ? 'verify passed, nothing left open' : 'verify passed',
    max: lastVerify.ok
      ? `${todo.length} step(s) still open after ${max} iteration(s)`
      : `verify still fails after ${max} iteration(s)`,
    'no-progress': `stopped: no progress in ${stall} iteration(s) in a row`,
    timeout: `stopped: wall-clock cap (${Math.round(timeoutMs / 60000)} min)`,
  };
  const relativeLogs = relPosix(rootDir, logDir);
  appendNotes(
    taskDir,
    formatNoteEntry({
      at: deps.date(),
      agent: command.agent,
      label: 'auto: outer loop',
      message: `pnpm loop --agent ${command.agent}${label ? ` (${label})` : ''}: ${outcome[reason]} (${iterations} agent iteration(s)).${iterations > 0 ? ` Logs: ${relativeLogs}/` : ''}${lastVerify.ok ? '' : ` Last failure: \`${lastVerify.failed}\`.`}`,
      state: `${formatGit(deps.git(rootDir))}; verify ${lastVerify.ok ? 'pass' : 'fail'}`,
    }),
    appendSeparator
  );

  return { ok: finished(), reason, iterations, lastVerify, logDir };
}
