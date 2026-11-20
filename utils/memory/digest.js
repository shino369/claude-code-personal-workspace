/**
 * Task memory (design §6, path C): when `pnpm task done` closes a task, a
 * digest note records it: goal, repository, outcome (`-m`), what was still
 * open (the last session note's Open line), and the `--learn` lines. Built
 * mechanically, without a model call. Closing a reopened task replaces its
 * digest. `--learn "…"` on `pnpm task note` and `done` saves each line as a
 * fact with the task as its source.
 *
 * Digests are machine-scope episodes, so they are recalled by content in
 * any repository (the repository is in the text and tags). Saving respects
 * `pnpm memory off`, and memory never blocks the task command: failures
 * come back as warnings. Writes go to the main checkout's store, also from
 * a `pnpm loop` or `pnpm swarm` worktree.
 */
import path from 'path';
import { sessionFromEnv } from '../task/store.js';
import { DATE_SUFFIX_RE } from '../task/state.js';
import { parseNotes } from '../task/markdown.js';
import { readConfig, savingOff } from './config.js';
import {
  ANNOUNCE_CHARS,
  announceSave,
  refreshAfterWrite,
  shorten,
  writerSource,
} from './context.js';
import { mainCheckout, repoName } from './repo.js';
import {
  LIMITS,
  MemoryError,
  addNote,
  assertNoSecrets,
  loadNotes,
  memoryDir,
  normalizeInput,
  updateNote,
} from './store.js';

/** Open lines that mean nothing is open. */
const NOTHING_OPEN = /^(none|n\/a|-|—)\.?$/i;

/**
 * @typedef {import('./store.js').Note} Note
 * @typedef {import('./store.js').NoteInput} NoteInput
 * @typedef {{ goal: string, repoDir: string | null, notes: string | null, outcome?: string }} DigestInput
 * @typedef {object} TaskMemory
 * @property {{ action: 'added' | 'replaced', note: Note } | null} digest
 * @property {{ action: 'added' | 'merged' | 'unchanged', note: Note }[]} learned
 * @property {'global' | 'session' | null} off saving was off, so nothing was saved
 * @property {string[]} warnings
 */

/**
 * The Open line of the last session note (one with Done or Next; step log
 * entries have neither), or null when nothing is open.
 *
 * @param {string | null} notes NOTES.md
 * @returns {string | null}
 */
export function lastOpen(notes) {
  if (!notes) return null;
  const session = parseNotes(notes)
    .reverse()
    .find((entry) => /^(Done|Next):/m.test(entry.body));
  const open = session?.body.match(/^Open:\s*(.+)$/m)?.[1].trim();
  return open && !NOTHING_OPEN.test(open) ? open : null;
}

/** @param {string} text */
const sentence = (text) => {
  const trimmed = text.trim();
  return /[.!?。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * @param {{ goal: string, repo?: string | null, outcome?: string, open?: string | null, learned?: string[] }} parts
 * @returns {string} within the note limit
 */
export function digestText({
  goal,
  repo = null,
  outcome = '',
  open = null,
  learned = [],
}) {
  const parts = [
    sentence(goal),
    ...(repo ? [`Repo: ${repo}.`] : []),
    ...(outcome.trim() ? [`Outcome: ${sentence(outcome)}`] : []),
    ...(open ? [`Open: ${sentence(open)}`] : []),
    ...(learned.length > 0
      ? [`Learned: ${learned.map(sentence).join(' ')}`]
      : []),
  ];
  return shorten(parts.join(' '), LIMITS.text);
}

/**
 * @param {string} task
 * @param {string | null} repo
 * @returns {string[]}
 */
export const digestTags = (task, repo) => [
  task.replace(DATE_SUFFIX_RE, ''),
  ...(repo ? [repo] : []),
];

/**
 * A task repository's name for memory (its folder name outside git).
 *
 * @param {string} repoDir
 */
export const repoLabel = (repoDir) =>
  repoName(repoDir) ?? path.basename(repoDir);

/**
 * `--learn` lines as validated notes: facts about this machine, or about
 * the task's repository when it works in another one. Throws a
 * MemoryError naming the bad line (by number: it may hold a secret).
 *
 * @param {string[]} lines
 * @param {{ env: NodeJS.ProcessEnv, rootDir: string, task: string, repoDir?: string | null }} context
 * @returns {NoteInput[]}
 */
export function learnedNotes(lines, { env, rootDir, task, repoDir = null }) {
  const repo = repoDir ? repoLabel(repoDir) : null;
  const source = writerSource({ env, rootDir, task });
  return lines.map((text, i) => {
    const input = {
      text,
      scope: repo ? 'repo' : 'machine',
      repo,
      type: 'fact',
      source,
    };
    try {
      assertNoSecrets(normalizeInput(input));
    } catch (error) {
      const { code, message } = /** @type {MemoryError} */ (error);
      throw new MemoryError(code, `--learn line ${i + 1}: ${message}`);
    }
    return input;
  });
}

/**
 * Add the task's digest, or replace the one an earlier close wrote.
 *
 * @param {string} dir
 * @param {{ task: string, text: string, tags: string[], now: Date }} digest
 * @returns {{ action: 'added' | 'replaced', note: Note }}
 */
function upsertDigest(dir, { task, text, tags, now }) {
  const source = { via: 'digest', task };
  const existing = loadNotes(dir).notes.find(
    (note) =>
      note.status === 'active' &&
      note.source.via === 'digest' &&
      note.source.task === task
  );
  if (existing) {
    return {
      action: 'replaced',
      note: updateNote(dir, existing.id, { text, tags }, { now, source }),
    };
  }
  const { note } = addNote(
    dir,
    { text, scope: 'machine', type: 'episode', tags, source },
    { now, merge: false }
  );
  return { action: 'added', note };
}

/**
 * Save the `--learn` notes and (when closing) the digest. Never throws for
 * memory problems: they come back as warnings, so the task command stands.
 *
 * @param {{ rootDir: string, env: NodeJS.ProcessEnv, now: Date, task: string, learned?: NoteInput[], digest?: DigestInput | null }} options
 * @returns {TaskMemory}
 */
export function saveTaskMemory({
  rootDir,
  env,
  now,
  task,
  learned = [],
  digest = null,
}) {
  /** @type {TaskMemory} */
  const result = { digest: null, learned: [], off: null, warnings: [] };
  if (!digest && learned.length === 0) return result;
  const root = mainCheckout(rootDir);
  const dir = memoryDir(root);
  try {
    result.off = savingOff(readConfig(dir), sessionFromEnv(env));
    if (result.off) return result;
    for (const input of learned) {
      result.learned.push(addNote(dir, input, { now }));
    }
    if (digest) {
      const repo = digest.repoDir ? repoLabel(digest.repoDir) : null;
      result.digest = upsertDigest(dir, {
        task,
        text: digestText({
          goal: digest.goal,
          repo,
          outcome: digest.outcome,
          open: lastOpen(digest.notes),
          learned: learned.map((input) => input.text),
        }),
        tags: digestTags(task, repo),
        now,
      });
    }
    result.warnings.push(...refreshAfterWrite(root));
  } catch (error) {
    result.warnings.push(
      `Memory not saved: ${/** @type {Error} */ (error).message}`
    );
  }
  return result;
}

/**
 * The lines a task command prints for what it saved to memory.
 *
 * @param {TaskMemory} memory
 * @returns {string[]}
 */
export function formatTaskMemory({ digest, learned, off, warnings }) {
  /** @type {string[]} */
  const lines = [];
  if (off) {
    lines.push(
      `Memory saving is off ${off === 'global' ? 'everywhere' : 'for this session'}: nothing was saved to memory (pnpm memory on).`
    );
  }
  lines.push(...learned.map(announceSave));
  if (digest) {
    const shown = shorten(digest.note.text, ANNOUNCE_CHARS);
    lines.push(
      digest.action === 'added'
        ? `Saved to memory: ${digest.note.id} (task digest) ${shown}`
        : `Updated memory: ${digest.note.id} (task digest, replaces the earlier one) ${shown}`
    );
  }
  lines.push(...warnings.map((warning) => `Warning: ${warning}`));
  return lines;
}
