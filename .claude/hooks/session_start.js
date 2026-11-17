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
import { runIfMain } from '#utils/module-runner.js';
import { sessionBrief } from '#utils/task/cli.js';
import { defaultDeps } from '#utils/task/deps.js';
import { toolsLine } from '#utils/tools/format.js';
import { readRegistry } from '#utils/tools/registry.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ source?: string }} HookInput
 * @typedef {{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: string } }} HookOutput
 */

/**
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, brief?: typeof sessionBrief, tools?: (rootDir: string) => string | null }} [options]
 * @returns {HookOutput | null}
 */
export function processHookInput(
  input,
  { rootDir = ROOT_DIR, brief = sessionBrief, tools = registryLine } = {}
) {
  let text;
  try {
    text = brief(defaultDeps({ rootDir }));
  } catch (error) {
    text = `[Task] Could not read the active task — ${error}`;
  }
  const toolText = tools(rootDir);
  if (!text && !toolText) return null;

  const source = input?.source ?? 'startup';
  const parts = [];
  if (text) {
    parts.push(
      text,
      text.startsWith('[Task] No active task')
        ? `(Injected on session ${source}. If the user asks to resume work, switch to the matching task first.)`
        : `(Task brief injected on session ${source}. If the user's request is about this task, continue from "Next step"; refresh with: pnpm task status.)`
    );
  }
  if (toolText) parts.push(toolText);
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: parts.join('\n'),
    },
  };
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
