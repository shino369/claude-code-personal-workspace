#!/usr/bin/env node
/**
 * SessionStart hook: inject the task resume brief.
 *
 * Fires on startup, resume, /clear, and after compaction. When a task is
 * active it adds `pnpm task status` output as context, so a fresh session
 * knows the goal and the next step without being told. With no active task it
 * lists open tasks to pick from. Either way it adds one `Tools:` line from the
 * machine's tool registry (`pnpm tools`), so the session knows which other
 * agents and CLIs it can call. When kyoten started the session from inside
 * another git repository (`KYOTEN_CALLER_DIR`), one more line says how to
 * work on it from this workspace.
 *
 * Fails open: any error means no output and exit 0.
 */
import path from 'path';
import { findGitDirs } from '#utils/memory/repo.js';
import { runIfMain } from '#utils/module-runner.js';
import { sessionBrief } from '#utils/task/cli.js';
import { defaultDeps } from '#utils/task/deps.js';
import {
  pruneSessions,
  readActive,
  readSession,
  touchSession,
  writeSession,
} from '#utils/task/store.js';
import { toolsLine } from '#utils/tools/format.js';
import { readRegistry } from '#utils/tools/registry.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ source?: string, session_id?: string }} HookInput
 * @typedef {{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: string } }} HookOutput
 */

/**
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, brief?: typeof sessionBrief, tools?: (rootDir: string) => string | null, caller?: (rootDir: string) => string | null }} [options]
 *   brief gets the deps and the session id
 * @returns {HookOutput | null}
 */
export function processHookInput(
  input,
  {
    rootDir = ROOT_DIR,
    brief = sessionBrief,
    tools = registryLine,
    caller = callerLine,
  } = {}
) {
  const session = input?.session_id ?? null;
  let text;
  try {
    bindNewSession(rootDir, session);
    text = brief(defaultDeps({ rootDir }), session);
  } catch (error) {
    text = `[Task] Could not read the active task — ${error}`;
  }
  const toolText = tools(rootDir);
  const callerText = caller(rootDir);
  if (!text && !toolText && !callerText) return null;

  const source = input?.source ?? 'startup';
  const parts = [];
  if (text) {
    parts.push(
      text,
      text.startsWith('[Task] No active task')
        ? `(Injected on session ${source}. If the user asks to resume work, switch to the matching task first.)`
        : `(Task brief injected on session ${source}. If the user's request is about this task, continue from "Next step"; its verify loop and notes apply to this session once a pnpm task command changes the task. Refresh with: pnpm task status.)`
    );
  }
  if (toolText) parts.push(toolText);
  if (callerText) parts.push(callerText);
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n'),
    },
  };
}

/**
 * Give a new session a dormant binding to the workspace default task (or to
 * no task), so later changes to `tasks/.active` by other sessions do not move
 * it, and its hooks stay off until it works on a task. A resumed or compacted
 * session keeps its binding. Stale bindings are pruned here.
 *
 * @param {string} rootDir
 * @param {string | null} session
 */
export function bindNewSession(rootDir, session) {
  if (!session) return;
  // Touch before pruning: a resumed session is in use, however long it slept.
  touchSession(rootDir, session);
  pruneSessions(rootDir);
  if (readSession(rootDir, session)) return;
  writeSession(rootDir, session, {
    task: readActive(rootDir),
    engaged: false,
  });
}

/**
 * The registry's one-line summary; null when it cannot be read (fail open).
 *
 * @param {string} rootDir
 * @returns {string | null}
 */
export function registryLine(rootDir) {
  try {
    return toolsLine(readRegistry(rootDir));
  } catch {
    return null;
  }
}

/**
 * The kyoten hint: kyoten starts every agent in the workspace and passes the
 * directory it was started from as KYOTEN_CALLER_DIR. When that directory is
 * in another git repository, the session should know how to work on it.
 * Null otherwise, or on any error (fail open). Only reads the filesystem.
 *
 * @param {string} rootDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function callerLine(rootDir, env = process.env) {
  const dir = env.KYOTEN_CALLER_DIR;
  if (!dir) return null;
  try {
    const repo = findGitDirs(dir)?.top;
    if (!repo || path.resolve(repo) === path.resolve(rootDir)) return null;
    return `[kyoten] Started from ${repo}, a git repository outside this workspace. If the user's request is about it, work on it through a task: pnpm task new <name> --goal "…" --repo "${repo}" (or pnpm task set --repo for the current task).`;
  } catch {
    return null;
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
      const output = processHookInput(data.trim() ? JSON.parse(data) : {});
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
