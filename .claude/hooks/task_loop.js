#!/usr/bin/env node
/**
 * Stop hook: the opt-in inner loop.
 *
 * When the session's task has the loop on (`pnpm task set --loop on`), every
 * stop runs the task's fast verify. The session's task is the one it worked
 * on (`tasks/.sessions/<session_id>.json`, see utils/task/store.js), so a
 * session that never touched a task never runs another session's loop. If it fails, the hook blocks the stop and hands
 * the failure back to the agent, up to `loop.max` times; it lets the stop
 * through when verify passes, at the cap, or when the same failure keeps
 * repeating (no progress), and then stays paused until the user's next prompt.
 * Off by default: with no active task, no state.json, or the loop off, it exits
 * without running anything.
 *
 * Run with `--reset` on UserPromptSubmit: a prompt the user types starts the
 * count over. Stop events never reset it (see decideInner for why).
 *
 * The quality loop's "open review round" reminder waits while the Stop
 * input's `background_tasks` lists a running reviewer or verifier subagent
 * (see pendingReviewAgents): its completion notice leads to another stop.
 *
 * Fails open: any error means no output and exit 0, so a broken hook never
 * traps a session.
 */
import { flushFormatQueue, taskRepoRoots } from '#utils/harness/format.js';
import { normalizeHookInput, parseHarness } from '#utils/harness/input.js';
import { runIfMain } from '#utils/module-runner.js';
import { defaultDeps } from '#utils/task/deps.js';
import { resetInnerLoop, runInnerLoop } from '#utils/task/loop.js';
import { pendingReviewAgents } from '#utils/task/quality.js';
import { touchSession } from '#utils/task/store.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ prompt?: unknown, lastUserInput?: unknown, session_id?: string, conversationId?: string, background_tasks?: unknown, terminationReason?: string, fullyIdle?: boolean, invocationNum?: number }} HookInput
 * @typedef {{ decision?: 'block' | 'continue' | 'allow', reason?: string, systemMessage?: string }} HookOutput
 * @typedef {Partial<import('#utils/task/deps.js').Deps>} DepsOverrides
 */

/**
 * Stop: run the inner loop and turn its decision into hook output. In Codex
 * it first formats the files edits queued (see utils/harness/format.js):
 * Codex runs an event's hooks concurrently, so this keeps the formatting
 * ahead of the verify. Notes the loop writes are signed with the harness
 * name unless TASK_AGENT says otherwise.
 *
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, harness?: import('#utils/harness/input.js').Harness, run?: typeof runInnerLoop, flush?: typeof flushFormatQueue, deps?: DepsOverrides }} [options]
 * @returns {HookOutput | null}
 */
export function processHookInput(
  input,
  {
    rootDir = ROOT_DIR,
    harness = 'claude',
    run = runInnerLoop,
    flush = flushFormatQueue,
    deps = {},
  } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  const agyAllow = /** @type {HookOutput} */ ({ decision: 'allow' });
  if (
    harness === 'agy' &&
    normalized.terminationReason &&
    normalized.terminationReason !== 'NO_TOOL_CALL'
  ) {
    return agyAllow;
  }
  if (harness === 'codex') {
    try {
      flush(normalized.session_id, {
        projectDir: rootDir,
        extraRoots: taskRepoRoots(rootDir, normalized.session_id),
      });
    } catch {
      // Formatting is best effort; the verify reports what is left.
    }
  }
  let decision;
  try {
    const env = deps.env ?? process.env;
    const pendingAgents =
      harness === 'agy'
        ? normalized.fullyIdle === false
          ? ['background']
          : []
        : pendingReviewAgents(normalized.background_tasks);
    decision = run({
      deps: defaultDeps({
        rootDir,
        ...deps,
        ...(harness === 'claude'
          ? {}
          : { env: { ...env, TASK_AGENT: env.TASK_AGENT ?? harness } }),
      }),
      session: normalized.session_id ?? null,
      pendingAgents,
    });
  } catch {
    return harness === 'agy' ? agyAllow : null;
  }
  if (decision.action === 'block') {
    return harness === 'agy'
      ? { decision: 'continue', reason: decision.reason }
      : { decision: 'block', reason: decision.reason };
  }
  if (harness === 'agy') return agyAllow;
  if (decision.action === 'allow' && decision.message) {
    return { systemMessage: decision.message };
  }
  return null;
}

/**
 * UserPromptSubmit / Antigravity PreInvocation (`--reset`): start the loop
 * count over on a typed prompt. In Antigravity, only `invocationNum === 0`
 * (the start of a user turn) resets the count. Never outputs anything and
 * never blocks the prompt.
 *
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, harness?: import('#utils/harness/input.js').Harness, reset?: typeof resetInnerLoop, deps?: DepsOverrides }} [options]
 * @returns {boolean} true when the count was reset
 */
export function processResetInput(
  input,
  {
    rootDir = ROOT_DIR,
    harness = 'claude',
    reset = resetInnerLoop,
    deps = {},
  } = {}
) {
  try {
    const normalized = normalizeHookInput(input, harness);
    if (
      harness === 'agy' &&
      typeof normalized.invocationNum === 'number' &&
      normalized.invocationNum !== 0
    ) {
      return false;
    }
    // A prompt means the session is in use: keep its binding from pruning.
    touchSession(rootDir, normalized.session_id);
    const env = deps.env ?? process.env;
    return reset({
      deps: defaultDeps({
        rootDir,
        ...deps,
        ...(harness === 'claude'
          ? {}
          : { env: { ...env, TASK_AGENT: env.TASK_AGENT ?? harness } }),
      }),
      prompt: normalized.prompt,
      session: normalized.session_id ?? null,
    });
  } catch {
    return false;
  }
}

/* c8 ignore start - stdin/stdout wiring; logic is tested through processHookInput */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  const isReset = process.argv.includes('--reset');
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  const failOpen = () => {
    if (harness === 'agy') {
      const fallback = isReset ? '{}' : JSON.stringify({ decision: 'allow' });
      process.stdout.write(fallback, () => process.exit(0));
      return;
    }
    process.exit(0);
  };
  process.stdin.on('end', () => {
    try {
      const input = data.trim() ? JSON.parse(data) : {};
      if (isReset) {
        processResetInput(input, { harness });
        if (harness === 'agy') {
          process.stdout.write('{}', () => process.exit(0));
          return;
        }
        process.exit(0);
        return;
      }
      const output = processHookInput(input, { harness });
      if (output) {
        process.stdout.write(JSON.stringify(output), () => process.exit(0));
        return;
      }
    } catch {
      failOpen();
      return;
    }
    process.exit(0);
  });
  process.stdin.on('error', failOpen);
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
