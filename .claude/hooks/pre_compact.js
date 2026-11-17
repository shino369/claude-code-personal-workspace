#!/usr/bin/env node
/**
 * PreCompact hook: append a mechanical NOTES.md entry to the active task
 * before the conversation is compacted, recording git state and the diff
 * size at that moment. The summary that survives compaction may drop
 * details; this entry keeps a timestamped checkpoint on disk.
 *
 * No active task means nothing to do. Fails open: errors exit 0 silently.
 */
import { runIfMain } from '#utils/module-runner.js';
import { stateLine, writeNote } from '#utils/task/cli.js';
import { gitInfo } from '#utils/task/git.js';
import { defaultDeps } from '#utils/task/deps.js';
import { loadTask, readActive } from '#utils/task/store.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ trigger?: string }} HookInput
 * @typedef {import('#utils/task/git.js').GitInfo} GitInfo
 */

/**
 * @param {HookInput | undefined} input
 * @param {{ rootDir?: string, now?: Date, git?: (cwd: string) => GitInfo }} [options]
 * @returns {string | null} the task that received the entry, or null
 */
export function processHookInput(
  input,
  { rootDir = ROOT_DIR, now = new Date(), git = (cwd) => gitInfo(cwd) } = {}
) {
  try {
    const name = readActive(rootDir);
    if (!name) return null;

    const deps = defaultDeps({ rootDir, git });
    const task = loadTask(rootDir, name);
    const info = git(rootDir);
    writeNote(deps, task, {
      at: now,
      agent: 'claude',
      label: `auto: pre-compact, ${input?.trigger ?? 'unknown'}`,
      message:
        'Context was compacted. Mechanical checkpoint — the latest manual entry above holds Done/Next.',
      state: `${stateLine(deps, task)}${info.diffStat ? `; diff ${info.diffStat}` : ''}`,
    });
    return name;
  } catch {
    return null;
  }
}

/* c8 ignore start - stdin wiring; logic is tested through processHookInput */
function main() {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    try {
      processHookInput(data.trim() ? JSON.parse(data) : {});
    } catch {
      // Fail open.
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
