#!/usr/bin/env node
/**
 * SessionStart hook: inject the task resume brief.
 *
 * Fires on startup, resume, /clear, and after compaction. When a task is
 * active it adds `pnpm task status` output as context, so a fresh session
 * knows the goal and the next step without being told. With no active task it
 * lists open tasks to pick from. Either way it adds one `Tools:` line from the
 * machine's tool registry (`pnpm tools`), so the session knows which other
 * agents and CLIs it can call.
 *
 * Fails open: any error means no output and exit 0.
 */
import {
  agyInjectOutput,
  normalizeHookInput,
  parseHarness,
} from '#utils/harness/input.js';
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
 * @typedef {{ source?: string, session_id?: string, conversationId?: string }} HookInput
 * @typedef {{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: string } }} StandardHookOutput
 * @typedef {StandardHookOutput | import('#utils/harness/input.js').AgyInjectOutput} HookOutput
 */

/**
 * @template {import('#utils/harness/input.js').Harness} [H='claude']
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, harness?: H, brief?: typeof sessionBrief, tools?: (rootDir: string) => string | null }} [options]
 *   brief gets the deps and the session id
 * @returns {(H extends 'agy' ? import('#utils/harness/input.js').AgyInjectOutput : StandardHookOutput) | null}
 */
export function processHookInput(
  input,
  {
    rootDir = ROOT_DIR,
    harness = /** @type {H} */ ('claude'),
    brief = sessionBrief,
    tools = registryLine,
  } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  const session = normalized.session_id ?? null;
  let text;
  try {
    bindNewSession(rootDir, session);
    text = brief(defaultDeps({ rootDir }), session);
  } catch (error) {
    text = `[Task] Could not read the active task — ${error}`;
  }
  const toolText = tools(rootDir);
  if (!text && !toolText) return null;

  const source = normalized.source ?? 'startup';
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
  return /** @type {any} */ (
    harness === 'agy'
      ? agyInjectOutput(parts.join('\n'))
      : {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: parts.join('\n'),
          },
        }
  );
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

/* c8 ignore start - stdin/stdout wiring; logic is tested through processHookInput */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  const failOpen = () => {
    if (harness === 'agy') {
      process.stdout.write('{}', () => process.exit(0));
      return;
    }
    process.exit(0);
  };
  process.stdin.on('end', () => {
    try {
      const output = processHookInput(data.trim() ? JSON.parse(data) : {}, {
        harness,
      });
      if (output || harness === 'agy') {
        process.stdout.write(JSON.stringify(output ?? {}), () =>
          process.exit(0)
        );
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
