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
import { runIfMain } from '#utils/module-runner.js';
import { defaultDeps } from '#utils/task/deps.js';
import { resetInnerLoop, runInnerLoop } from '#utils/task/loop.js';
import { pendingReviewAgents } from '#utils/task/quality.js';
import { touchSession } from '#utils/task/store.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ prompt?: unknown, session_id?: string, background_tasks?: unknown }} HookInput
 * @typedef {{ decision?: 'block', reason?: string, systemMessage?: string }} HookOutput
 * @typedef {Partial<import('#utils/task/deps.js').Deps>} DepsOverrides
 */

/**
 * Stop: run the inner loop and turn its decision into hook output.
 *
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, run?: typeof runInnerLoop, deps?: DepsOverrides }} [options]
 * @returns {HookOutput | null}
 */
export function processHookInput(
  input,
  { rootDir = ROOT_DIR, run = runInnerLoop, deps = {} } = {}
) {
  let decision;
  try {
    decision = run({
      deps: defaultDeps({ rootDir, ...deps }),
      session: input?.session_id ?? null,
      pendingAgents: pendingReviewAgents(input?.background_tasks),
    });
  } catch {
    return null;
  }
  if (decision.action === 'block') {
    return { decision: 'block', reason: decision.reason };
  }
  if (decision.action === 'allow' && decision.message) {
    return { systemMessage: decision.message };
  }
  return null;
}

/**
 * UserPromptSubmit (`--reset`): start the loop count over on a typed prompt.
 * Never outputs anything and never blocks the prompt.
 *
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, reset?: typeof resetInnerLoop, deps?: DepsOverrides }} [options]
 * @returns {boolean} true when the count was reset
 */
export function processResetInput(
  input,
  { rootDir = ROOT_DIR, reset = resetInnerLoop, deps = {} } = {}
) {
  try {
    // A prompt means the session is in use: keep its binding from pruning.
    touchSession(rootDir, input?.session_id);
    return reset({
      deps: defaultDeps({ rootDir, ...deps }),
      prompt: input?.prompt,
      session: input?.session_id ?? null,
    });
  } catch {
    return false;
  }
}

/* c8 ignore start - stdin/stdout wiring; logic is tested through processHookInput */
function main() {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const input = data.trim() ? JSON.parse(data) : {};
      if (process.argv.includes('--reset')) {
        processResetInput(input);
        process.exit(0);
        return;
      }
      const output = processHookInput(input);
      if (output) {
        process.stdout.write(JSON.stringify(output), () => process.exit(0));
        return;
      }
    } catch {
      // Fail open.
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
