/**
 * Loop safety shared by the inner loop (the Claude `Stop` hook) and the outer
 * loop (`pnpm loop`): failure signatures for no-progress detection, and the
 * inner loop's stop/continue decision.
 *
 * The decision is pure; `runInnerLoop` adds the I/O (verify, state.json,
 * NOTES.md) so the hook stays a thin stdin/stdout wrapper.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ANY_LEVEL_SKIP, TASK_FILES, isCodeFile, withCheck } from './check.js';
import { formatGit } from './git.js';
import { appendSeparator, formatNoteEntry } from './markdown.js';
import { decideQuality } from './quality.js';
import { fingerprint, scopeRoot, taskReviewScope } from './review.js';
import {
  appendNotes,
  loadTask,
  sessionTask,
  taskRepoDir,
  updateState,
} from './store.js';
import { stripAnsi, summarize } from './verify.js';

/** Identical failures in a row (after the first) that count as no progress. */
export const STALL_LIMIT = 2;
/** Upper bound for `--loop-max`, so a typo cannot start a long unattended run. */
export const MAX_ITERATIONS = 50;
/** Verify timeout inside the Stop hook; settings.json gives the hook 300 s. */
export const INNER_VERIFY_TIMEOUT_MS = 240 * 1000;
/** Env switch the outer loop sets so child sessions do not run the inner loop. */
export const INNER_LOOP_ENV = 'TASK_INNER_LOOP';
/** Loop counters after a pass or a reset. */
export const FRESH_LOOP = Object.freeze({
  iteration: 0,
  signature: null,
  repeats: 0,
  halted: false,
});

/**
 * Remove run-to-run noise (color codes, timing lines, timestamps, clock times,
 * durations) so the same failure produces the same text.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeFailure(text) {
  return stripAnsi(text)
    .replace(/^\s*(?:Duration|Start at|Time|Ran all|Done in)\b.*$/gim, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g, '<dur>')
    .replace(/[ \t]+$/gm, '');
}

/**
 * A short, stable fingerprint of a failed verify; null when it passed.
 *
 * @param {import('./state.js').VerifyResult | null | undefined} verify
 * @returns {string | null}
 */
export function failureSignature(verify) {
  if (!verify || verify.ok) return null;
  return crypto
    .createHash('sha256')
    .update(`${verify.failed}\n${normalizeFailure(verify.summary)}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Parse an iteration cap from the CLI.
 *
 * @param {string} value
 * @param {string} flag
 * @returns {number}
 */
export function parseMax(value, flag) {
  const max = Number(value);
  if (!Number.isInteger(max) || max < 1 || max > MAX_ITERATIONS) {
    throw new Error(
      `${flag} must be a whole number from 1 to ${MAX_ITERATIONS} (got "${value}")`
    );
  }
  return max;
}

/**
 * @typedef {import('./state.js').TaskState} TaskState
 * @typedef {import('./state.js').VerifyResult} VerifyResult
 * @typedef {{
 *   action: 'skip' | 'allow' | 'block',
 *   reason?: string,
 *   message?: string,
 *   loop?: TaskState['loop'],
 *   lastVerify?: VerifyResult,
 *   note?: string,
 * }} InnerDecision
 */

/**
 * The verify commands the inner loop runs: the fast subset, else the full list.
 *
 * @param {TaskState} state
 * @returns {string[]}
 */
export function innerCommands(state) {
  return state.verifyFast.length > 0 ? state.verifyFast : state.verify;
}

/**
 * Decide whether the inner loop lets the agent stop.
 *
 * The iteration count only goes up here; a Stop event never resets it.
 * Claude's own guards (`stop_hook_active`, the consecutive-continuation cap)
 * do not reliably catch this loop: a continuation that makes tool calls can
 * look like a fresh stop. Only a pass, `pnpm task set --loop on`, or a prompt
 * the user types (`resetInnerLoop`) starts the count over. Stopping at the cap
 * or on no progress sets `halted`, so later stops skip verify entirely.
 *
 * @param {{ state: TaskState, verify: VerifyResult }} input
 * @returns {InnerDecision}
 */
export function decideInner({ state, verify }) {
  const { iteration, max } = state.loop;

  if (verify.ok) {
    return {
      action: 'allow',
      message: `✓ task verify passed (${state.name})`,
      lastVerify: verify,
      loop: { ...state.loop, ...FRESH_LOOP },
    };
  }

  const signature = failureSignature(verify);
  const repeats =
    signature === (state.loop.signature ?? null)
      ? (state.loop.repeats ?? 0) + 1
      : 0;
  const loop = { ...state.loop, iteration, signature, repeats };
  const halt = (/** @type {string} */ message, /** @type {string} */ note) => ({
    action: /** @type {const} */ ('allow'),
    message: `${message} The loop is paused until your next prompt; see tasks/${state.name}/NOTES.md.`,
    lastVerify: verify,
    loop: { ...loop, halted: true },
    note,
  });

  if (iteration >= max) {
    return halt(
      `Task loop stopped: verify still fails after ${max} iteration(s).`,
      `Inner loop stopped at the cap (${max}). \`${verify.failed}\` still fails.`
    );
  }
  if (repeats >= STALL_LIMIT) {
    return halt(
      `Task loop stopped: no progress (the same failure ${repeats + 1} times in a row).`,
      `Inner loop stopped: no progress — \`${verify.failed}\` failed the same way ${repeats + 1} times in a row (iteration ${iteration}/${max}).`
    );
  }

  const next = iteration + 1;
  return {
    action: 'block',
    reason: [
      `Task verify failed (task loop iteration ${next}/${max}): \`${verify.failed}\``,
      verify.summary,
      '',
      `Fix the cause (do not weaken or skip the check), then finish your turn; the Stop hook re-runs: ${innerCommands(state).join(' && ')}.`,
      'If it cannot be fixed in code (a git, install, or environment error), do not retry: tell the user why and run: pnpm task set --loop off',
    ].join('\n'),
    lastVerify: verify,
    loop: { ...loop, iteration: next },
  };
}

/**
 * The loop of the session's task when the inner loop applies to it, else
 * null: only a task the session has worked on (see `sessionTask`).
 *
 * @param {import('./deps.js').Deps} deps
 * @param {string | null | undefined} session the hook's session id
 * @returns {{ name: string, task: import('./store.js').Task, state: TaskState } | null}
 */
function activeLoop(deps, session) {
  if (deps.env[INNER_LOOP_ENV] === 'off') return null;
  const found = sessionTask(deps.rootDir, session);
  if (!found?.engaged) return null;
  const { name } = found;
  const task = loadTask(deps.rootDir, name);
  const { state } = task;
  if (!state || !state.loop.enabled || state.status === 'done') return null;
  return { name, task, state };
}

/** Git queries whose answers make up the state of a working tree. */
const TREE_QUERIES = [
  ['rev-parse', 'HEAD'],
  ['status', '--porcelain', '--untracked-files=all'],
  ['diff', 'HEAD', '--binary'],
  ['ls-files', '--others', '--exclude-standard'],
];

/**
 * Top-level task entries no verify reads: what `pnpm task`, the review
 * rounds, and `pnpm loop` / `pnpm swarm` write.
 */
const RECORDS = new Set([...TASK_FILES, 'reviews', 'loop', 'swarm']);

/**
 * The task folder's files a verify can read, as sorted POSIX paths: `code`
 * (regular files `pnpm task check` formats) and `other` (fixtures, docs,
 * translations, images, scratch, symlinks). Skips RECORDS, dependency and
 * generated folders (ANY_LEVEL_SKIP), and dot-folders (caches); symlinked
 * folders are not followed.
 *
 * @param {string} taskDir
 * @returns {{ code: string[], other: string[] }}
 */
export function taskInputs(taskDir) {
  /** @type {{ code: string[], other: string[] }} */
  const found = { code: [], other: [] };
  /** @param {string} rel */
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(taskDir, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && RECORDS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !ANY_LEVEL_SKIP.has(entry.name)) {
          walk(child);
        }
      } else if (entry.isFile() && isCodeFile(entry.name)) {
        found.code.push(child);
      } else {
        found.other.push(child);
      }
    }
  };
  if (fs.existsSync(taskDir)) walk('');
  found.code.sort();
  found.other.sort();
  return found;
}

/**
 * @param {string} dir
 * @param {string} file
 * @returns {string} `file` with its size and modification time, read without
 *   opening it (large files, secrets), or `-` when it is gone
 */
const statLine = (dir, file) => {
  const stat = fs.statSync(path.join(dir, file), { throwIfNoEntry: false });
  return `\0${file}:${stat ? `${stat.size}:${stat.mtimeMs}` : '-'}`;
};

/**
 * A fingerprint of everything a verify run depends on: the verify commands,
 * the working tree of the workspace and of the task's repository (HEAD,
 * status, tracked changes, and each untracked file's size and time), and the
 * task folder (git-ignored): its code by content, every other file a verify
 * can read (`taskInputs`) by size and time. The inner loop skips a verify
 * that already passed on the same fingerprint. Null when git cannot answer
 * (no repository, a diff too large), which never matches.
 *
 * @param {Pick<import('./deps.js').Deps, 'rootDir' | 'runGit'>} deps
 * @param {TaskState} state
 * @param {string} taskDir
 * @returns {string | null}
 */
export function workPrint(deps, state, taskDir) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify([state.verify, state.verifyFast]));
  for (const dir of new Set([deps.rootDir, taskRepoDir(deps.rootDir, state)])) {
    const answers = TREE_QUERIES.map((args) => deps.runGit(args, dir));
    if (answers.some((answer) => typeof answer !== 'string')) return null;
    hash.update(`\0${dir}\0${answers.join('\0')}`);
    for (const file of String(answers[3]).split('\n').filter(Boolean)) {
      hash.update(statLine(dir, file));
    }
  }
  const { code, other } = taskInputs(taskDir);
  hash.update(`\0${fingerprint(taskDir, code)}`);
  for (const file of other) hash.update(statLine(taskDir, file));
  return hash.digest('hex').slice(0, 16);
}

/**
 * Fingerprint of the task's review scope now, or null when git cannot say
 * (no merge base) or nothing is in scope: the quality loop then lets the stop
 * through.
 *
 * @param {import('./deps.js').Deps} deps
 * @param {string} taskDir
 * @param {TaskState} state
 * @returns {string | null}
 */
export function scopeFingerprint(deps, taskDir, state) {
  try {
    const scope = taskReviewScope({
      rootDir: deps.rootDir,
      taskDir,
      state,
      runGit: deps.runGit,
    });
    // Nothing in scope: no review to ask for (pnpm task review would refuse).
    return scope.files.length === 0
      ? null
      : fingerprint(scopeRoot(deps.rootDir, state, scope), scope.files);
  } catch {
    return null;
  }
}

/**
 * Run the inner loop for the active task: verify, record the result, and
 * return the decision. Returns `{ action: 'skip' }` when the loop is off or
 * halted.
 *
 * @param {{ deps: import('./deps.js').Deps, session?: string | null, pendingAgents?: string[] }} input
 *   pendingAgents: the session's review agents still running (see
 *   pendingReviewAgents); an open round's reminder waits for them
 * @returns {InnerDecision}
 */
export function runInnerLoop({ deps, session = null, pendingAgents = [] }) {
  const active = activeLoop(deps, session);
  if (!active || active.state.loop.halted) return { action: 'skip' };
  const { name, task, state } = active;

  const commands = withCheck(innerCommands(state), { name, taskDir: task.dir });
  if (commands.length === 0) {
    return {
      action: 'allow',
      message: `Task loop is on for ${name} but it has no verify commands. Fix: pnpm task set --verify "pnpm check"`,
    };
  }

  const now = deps.now();
  // Nothing changed since a passing verify (a turn that only talked, or a
  // second stop): do not run it again.
  const print = workPrint(deps, state, task.dir);
  const reused =
    print !== null && state.lastVerify?.ok === true
      ? state.lastVerify.print === print
      : false;
  /** @type {VerifyResult} */
  const verify = reused
    ? /** @type {VerifyResult} */ (state.lastVerify)
    : {
        ...summarize(
          deps.runCommands({
            commands,
            cwd: deps.rootDir,
            timeoutMs: INNER_VERIFY_TIMEOUT_MS,
          }),
          now
        ),
        ...(print ? { print } : {}),
      };
  // The fingerprint reads git and files: work it out before taking the lock.
  const scopePrint =
    verify.ok && state.kind === 'code'
      ? scopeFingerprint(deps, task.dir, state)
      : null;
  const agent = deps.env.TASK_AGENT ?? 'claude';
  /** @type {InnerDecision} */
  let decision = { action: 'skip' };
  /** @type {import('./quality.js').QualityDecision | null} */
  let quality = null;
  // Decide from the state on disk, under the lock: verify can take minutes,
  // and another agent may have changed the task meanwhile (turned the loop
  // off, recorded a review). Deciding from the copy read before verify
  // would write those changes back over.
  updateState(
    deps.rootDir,
    name,
    (current) => {
      if (!current.loop.enabled || current.status === 'done') {
        return { ...current, lastVerify: verify };
      }
      const inner = decideInner({ state: current, verify });
      quality =
        verify.ok && current.kind === 'code'
          ? decideQuality({
              state: { ...current, lastVerify: verify },
              fingerprint: scopePrint,
              pendingAgents,
            })
          : null;
      decision = !quality
        ? inner
        : quality.action === 'block'
          ? {
              ...inner,
              action: 'block',
              reason: quality.reason,
              message: undefined,
            }
          : { ...inner, message: quality.message ?? inner.message };
      return {
        ...current,
        lastVerify: verify,
        loop: /** @type {TaskState['loop']} */ (decision.loop),
        ...(quality ? { quality: quality.quality } : {}),
      };
    },
    { now, agent }
  );
  quality = /** @type {import('./quality.js').QualityDecision | null} */ (
    quality
  );
  decision = /** @type {InnerDecision} */ (decision);
  if (reused && decision.action === 'allow' && !quality?.message) {
    decision = { ...decision, message: undefined };
  }
  if (quality?.note) {
    appendNotes(
      task.dir,
      formatNoteEntry({
        at: now,
        agent,
        label: 'auto: quality loop',
        message: quality.note,
        state: `${formatGit(deps.git(taskRepoDir(deps.rootDir, state)))}; verify pass`,
      }),
      appendSeparator
    );
  }
  if (decision.note) {
    appendNotes(
      task.dir,
      formatNoteEntry({
        at: now,
        agent,
        label: 'auto: inner loop',
        message: decision.note,
        state: `${formatGit(deps.git(taskRepoDir(deps.rootDir, state)))}; verify fail`,
      }),
      appendSeparator
    );
  }
  return decision;
}

/**
 * Start the inner-loop count over when the user types a prompt.
 *
 * UserPromptSubmit also fires for queued `<task-notification>` messages
 * (background tasks, rewakes); resetting on those would undo the cap, so they
 * are ignored. A missing prompt does not reset either (fail closed).
 *
 * @param {{ deps: import('./deps.js').Deps, prompt: unknown, session?: string | null }} input
 * @returns {boolean} true when the count was reset
 */
export function resetInnerLoop({ deps, prompt, session = null }) {
  const text = typeof prompt === 'string' ? prompt.trimStart() : '';
  if (!text || text.startsWith('<task-notification>')) return false;
  const active = activeLoop(deps, session);
  if (!active) return false;
  const { loop } = active.state;
  if (loop.iteration === 0 && !loop.signature && !loop.halted) return false;
  updateState(
    deps.rootDir,
    active.name,
    (current) => ({ ...current, loop: { ...current.loop, ...FRESH_LOOP } }),
    { now: deps.now(), agent: deps.env.TASK_AGENT ?? 'claude' }
  );
  return true;
}
