/**
 * What every memory write path shares: who is writing (the note's source)
 * and the refresh after a write (core block + index cache), so hooks stay on
 * the fast path. Used by `pnpm memory` and `pnpm task` (digests, --learn).
 */
import { currentTask, loadTask, sessionFromEnv } from '../task/store.js';
import { loadIndex } from './recall.js';
import { renderLocal } from './render.js';
import { repoName } from './repo.js';
import { MemoryError, memoryDir } from './store.js';

/** Characters of a note shown when a save is announced. */
export const ANNOUNCE_CHARS = 120;

/**
 * @param {string} text
 * @param {number} max
 */
export const shorten = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * `machine, howto` · `repo web, fact`.
 *
 * @param {Pick<import('./store.js').Note, 'scope' | 'repo' | 'type'>} note
 */
export const kindLabel = (note) =>
  `${note.scope === 'repo' ? `repo ${note.repo}` : note.scope}, ${note.type}`;

/**
 * The one line every save prints (design §13: each save is announced).
 *
 * @param {{ action: 'added' | 'merged' | 'unchanged', note: import('./store.js').Note }} saved
 */
export function announceSave({ action, note }) {
  const shown = shorten(note.text, ANNOUNCE_CHARS);
  if (action === 'added') {
    return `Saved to memory: ${note.id} (${kindLabel(note)}) ${shown}`;
  }
  if (action === 'merged') {
    return `Updated memory: ${note.id} (merged into a similar note) ${shown}`;
  }
  return `Already in memory: ${note.id} ${shown}`;
}

/**
 * Who is writing: an agent (from $TASK_AGENT, or Claude Code), else the
 * user, with the session and the task when known.
 *
 * @param {{ env: NodeJS.ProcessEnv, rootDir: string, task?: string | null }} context
 *   `task` defaults to the caller's current task
 * @returns {import('./store.js').Source}
 */
export function writerSource({
  env,
  rootDir,
  task = currentTask(rootDir, sessionFromEnv(env)),
}) {
  const harness = env.TASK_AGENT || (env.CLAUDECODE === '1' ? 'claude' : '');
  const session = sessionFromEnv(env);
  return {
    via: harness ? 'agent' : 'user',
    ...(harness ? { harness } : {}),
    ...(session ? { session } : {}),
    ...(task ? { task } : {}),
  };
}

/**
 * After a write: re-render the core block in AGENTS.local.md and warm the
 * index cache. A broken AGENTS.local.md is a warning; the write stands.
 *
 * @param {string} rootDir the checkout that holds memory/
 * @returns {string[]} warnings
 */
export function refreshAfterWrite(rootDir) {
  /** @type {string[]} */
  let warnings;
  try {
    warnings = renderLocal(rootDir).warnings;
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    warnings = [error.message];
  }
  loadIndex(memoryDir(rootDir));
  return warnings;
}

/**
 * The caller's task (its session's, else the workspace default), its goal,
 * and the repository it works in: the task's --repo, else the folder the
 * command ran in. Recall uses the goal in its query and the repo for repo
 * notes; a repo note is saved with this name.
 *
 * @param {{ rootDir: string, session: string | null, cwd: string }} context
 * @returns {{ task: string | null, goal: string | null, repo: string | null }}
 */
export function taskContext({ rootDir, session, cwd }) {
  const task = currentTask(rootDir, session);
  let state = null;
  if (task) {
    try {
      state = loadTask(rootDir, task).state;
    } catch {
      // A broken task state is pnpm task's to report; use the folder.
    }
  }
  return {
    task,
    goal: state?.goal ?? null,
    repo: repoName(state?.repo ?? cwd),
  };
}
