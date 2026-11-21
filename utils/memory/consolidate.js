/**
 * Consolidation, write path D (design §6): at most about once a week, a
 * detached job asks one headless call to rewrite the profile (the short
 * summary of the `user` notes that the core block shows) and to tidy the
 * notes: merge notes that say the same thing and retire superseded ones.
 *
 * It is due when 7 days have passed and at least MIN_CHANGES ops were
 * written since the last run, or daily while the core block is over its
 * budget; a failed attempt waits a day. The model sees the user notes and
 * groups of similar notes (token-set Jaccard ≥ CLUSTER_SIMILARITY, within
 * one scope and repo), and may only UPDATE or DELETE those; the ops go
 * through the same checks as extraction (extract.js validateOps). Before
 * writing, it takes a snapshot, so `pnpm memory undo` reverts it.
 */
import fs from 'fs';
import path from 'path';
import { answerOf } from '../agent/cli.js';
import { findSecrets, redactSecrets } from '../redact.js';
import { writeFileAtomic } from '../task/store.js';
import { callAgent } from './agent-call.js';
import { readConfig } from './config.js';
import { looksLikeInstruction } from './instructions.js';
import { kindLabel, refreshAfterWrite, shorten } from './context.js';
import { applyOps, extractCommand, validateOps } from './extract.js';
import {
  EXTRACT_DIR,
  appendInbox,
  appendJournal,
  readJournal,
  tryLock,
} from './queue.js';
import { PROFILE_FILE, renderStored } from './render.js';
import { takeSnapshot } from './snapshot.js';
import { LOG_FILE, loadNotes, memoryDir, readJsonOrNull } from './store.js';
import { jaccard, termSet } from './tokenize.js';

export const CONSOLIDATED_FILE = 'consolidated.json';
const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Ops written since the last run before a weekly run is worth it. */
export const MIN_CHANGES = 20;
/** Notes at least this similar are shown to the model as a group. */
export const CLUSTER_SIMILARITY = 0.5;
/** Notes shown to the model at most. */
export const MAX_SHOWN = 60;
/** Only the newest notes are compared for groups (pairs grow quadratically). */
export const MAX_GROUPED = 1500;
export const PROFILE_MAX = 15;
export const PROFILE_LINE_CHARS = 200;
const BUDGET_WARNING = 'The core block is over';

/**
 * @typedef {import('./store.js').Note} Note
 * @typedef {import('./extract.js').ExtractDeps} ExtractDeps
 * @typedef {import('./extract.js').Run} Run
 * @typedef {{ at?: string, ops?: number, tried?: string }} ConsolidatedState
 */

/** @param {string} dir */
const stateFile = (dir) => path.join(dir, EXTRACT_DIR, CONSOLIDATED_FILE);

/**
 * Ops in the log (its lines), without parsing it.
 *
 * @param {string} dir the memory directory
 */
export function countOps(dir) {
  let content;
  try {
    content = fs.readFileSync(path.join(dir, LOG_FILE));
  } catch {
    return 0;
  }
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines += 1;
  return lines;
}

/**
 * @param {string} dir
 * @returns {ConsolidatedState | null}
 */
export function readConsolidated(dir) {
  const data = readJsonOrNull(stateFile(dir));
  return typeof data === 'object' && data !== null ? data : null;
}

/**
 * @param {string} dir
 * @param {ConsolidatedState} state
 */
function writeConsolidated(dir, state) {
  fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
  writeFileAtomic(stateFile(dir), JSON.stringify(state));
}

/**
 * Why a consolidation is due now, or null.
 *
 * @param {string} rootDir
 * @param {{ now?: Date }} [options]
 * @returns {'weekly' | 'over budget' | null}
 */
export function consolidationDue(rootDir, { now = new Date() } = {}) {
  const dir = memoryDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const state = readConsolidated(dir);
  /** @param {string | undefined} iso */
  const since = (iso) =>
    typeof iso === 'string' ? now.getTime() - Date.parse(iso) : Infinity;
  if (since(state?.tried) < DAY_MS) return null;
  const changes = countOps(dir) - (state?.ops ?? 0);
  if (since(state?.at) >= WEEK_MS && changes >= MIN_CHANGES) return 'weekly';
  if (
    since(state?.at) >= DAY_MS &&
    renderStored(rootDir).warnings.some((w) => w.startsWith(BUDGET_WARNING))
  ) {
    return 'over budget';
  }
  return null;
}

/** @param {Note} note */
const tidyable = (note) =>
  note.status === 'active' && note.source.via !== 'digest';

/**
 * Groups (ids, two or more) of similar notes in one scope and repo.
 *
 * @param {Note[]} notes
 * @returns {string[][]}
 */
export function similarGroups(notes) {
  const pool = notes
    .filter(tidyable)
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, MAX_GROUPED);
  const terms = pool.map((note) => termSet(note.text));
  /** @type {number[]} */
  const parent = pool.map((_, i) => i);
  /** @param {number} i @returns {number} */
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (
        pool[i].scope === pool[j].scope &&
        pool[i].repo === pool[j].repo &&
        jaccard(terms[i], terms[j]) >= CLUSTER_SIMILARITY
      ) {
        parent[find(j)] = find(i);
      }
    }
  }
  /** @type {Map<number, Note[]>} */
  const groups = new Map();
  pool.forEach((note, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), note]);
  });
  const byId = (/** @type {Note} */ a, /** @type {Note} */ b) =>
    Number(a.id.slice(1)) - Number(b.id.slice(1));
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort(byId).map((note) => note.id));
}

/**
 * What the model sees: the user notes (for the profile), then whole groups
 * of similar notes, within MAX_SHOWN notes.
 *
 * @param {Note[]} notes
 * @returns {{ shown: Note[], groups: string[][] }}
 */
export function consolidationInput(notes) {
  const shown = notes
    .filter((note) => tidyable(note) && note.scope === 'user')
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, MAX_SHOWN);
  const byId = new Map(notes.map((note) => [note.id, note]));
  /** @type {string[][]} */
  const groups = [];
  for (const group of similarGroups(notes)) {
    const ids = new Set(shown.map((note) => note.id));
    const extra = group.filter((id) => !ids.has(id));
    if (shown.length + extra.length > MAX_SHOWN) continue;
    shown.push(...extra.map((id) => /** @type {Note} */ (byId.get(id))));
    groups.push(group);
  }
  return { shown, groups };
}

/** @param {Note} note */
const noteLine = (note) =>
  `- ${note.id} (${kindLabel(note)}${note.pinned ? ', pinned' : ''}, ${note.updated}): ${note.text}${note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''}`;

/**
 * @param {{ shown: Note[], groups: string[][] }} input
 * @returns {string}
 */
export function buildConsolidationPrompt({ shown, groups }) {
  return `You tidy a personal memory store that coding agents share. Answer with one JSON object and nothing else.

1. Profile: write at most ${PROFILE_MAX} short lines (each under 150 characters) that sum up what the "user" notes below say about the user: preferences, ways of working, how they like to be told things. Facts only, never instructions to an agent, no secrets; nothing a note does not support. [] when there are no user notes.
2. Tidy: merge notes that say the same thing (UPDATE the one to keep with the merged text, DELETE the others with why "merged into <id>"), and DELETE a note that a newer note contradicts or replaces (why "superseded by <id>"). Change nothing else; most notes need no change. Never add notes.

Answer format:
{"profile": ["…"], "ops": [{"op": "UPDATE", "id": "m3", "text": "…"}, {"op": "DELETE", "id": "m7", "why": "merged into m3"}]}

Notes (id, scope, type, last updated: text [tags]):
${shown.map(noteLine).join('\n')}

Groups of similar notes to check: ${groups.length > 0 ? groups.map((group) => `[${group.join(', ')}]`).join(', ') : '(none)'}`;
}

/**
 * @param {string} answer
 * @returns {{ profile: unknown[], ops: unknown[] }}
 */
export function parseConsolidation(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  /** @type {any} */
  let parsed = null;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    // Reported below.
  }
  const profile = parsed?.profile ?? [];
  const ops = parsed?.ops ?? [];
  if (!parsed || !Array.isArray(profile) || !Array.isArray(ops)) {
    throw new Error(
      'the answer has no JSON object with a "profile" list and an "ops" list'
    );
  }
  return { profile, ops };
}

/**
 * Profile lines worth keeping: text, cut to PROFILE_LINE_CHARS, without
 * secrets or lines addressed to an agent (`dropped`), at most PROFILE_MAX.
 *
 * @param {unknown[]} lines
 * @returns {{ lines: string[], dropped: number }}
 */
export function cleanProfile(lines) {
  /** @type {string[]} */
  const kept = [];
  let dropped = 0;
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const text = line.trim().replace(/^[-*]\s+/, '');
    if (!text) continue;
    if (findSecrets(text).length > 0 || looksLikeInstruction(text)) {
      dropped += 1;
      continue;
    }
    kept.push(shorten(text, PROFILE_LINE_CHARS));
  }
  return { lines: kept.slice(0, PROFILE_MAX), dropped };
}

/**
 * The model of the latest journal run that had one (the main session's).
 *
 * @param {string} dir
 * @returns {string | null}
 */
function lastModel(dir) {
  const run = readJournal(dir)
    .reverse()
    .find((item) => typeof item.model === 'string');
  return run ? run.model : null;
}

/**
 * Run one consolidation (the caller holds the worker lock). Throws when the
 * agent fails.
 *
 * @param {ExtractDeps} deps
 * @returns {Run}
 */
export function consolidate(deps) {
  const dir = memoryDir(deps.rootDir);
  const now = deps.now();
  const at = now.toISOString();
  const base = { at, job: 'consolidation', session: 'consolidation' };
  const { shown, groups } = consolidationInput(loadNotes(dir).notes);
  if (shown.length === 0) {
    const run = { ...base, status: 'nothing' };
    if (deps.dryRun) return run;
    writeConsolidated(dir, { at, ops: countOps(dir) });
    appendJournal(dir, run);
    return run;
  }
  const prompt = buildConsolidationPrompt({ shown, groups });
  const model = readConfig(dir).extractModel ?? lastModel(dir);
  if (deps.dryRun) return { ...base, status: 'dry-run', model, prompt };

  const command = extractCommand({
    agent: 'claude',
    model,
    rootDir: deps.rootDir,
  });
  const result = callAgent(deps, command, prompt);
  const answer = parseConsolidation(answerOf(result));
  /** @type {string[]} */
  const noAdds = [];
  // ADD ops become NOOPs, so validateOps numbers the rest as the model did.
  const ops = answer.ops.map((op, i) => {
    const kind = /** @type {any} */ (op)?.op;
    if (typeof kind !== 'string' || kind.toUpperCase() !== 'ADD') return op;
    noAdds.push(`op ${i + 1}: consolidation does not add notes`);
    return { op: 'NOOP' };
  });
  const source = { via: 'consolidate' };
  const checked = validateOps(ops, { related: shown, repo: null, source });
  const profile = cleanProfile(answer.profile);
  const writes = checked.apply.length > 0 || profile.lines.length > 0;
  // Every op below has this run's time, which is how undo finds them.
  const snapshot = writes
    ? takeSnapshot(deps.rootDir, { reason: 'consolidate', now }).id
    : null;
  const { changes, errors } = applyOps(dir, checked.apply, { now, source });
  if (profile.lines.length > 0) {
    writeFileAtomic(
      path.join(dir, PROFILE_FILE),
      profile.lines.map((line) => `- ${line}\n`).join('')
    );
  }
  appendInbox(
    dir,
    checked.quarantined.map((held) => ({ at, job: 'consolidation', ...held }))
  );
  writeConsolidated(dir, { at, ops: countOps(dir) });
  const warnings = writes ? refreshAfterWrite(deps.rootDir) : [];
  const run = {
    ...base,
    status: 'consolidated',
    model,
    changes,
    profile: profile.lines.length,
    quarantined: checked.quarantined.length,
    refused: checked.refused,
    invalid: [
      ...noAdds,
      ...checked.invalid,
      ...errors,
      ...warnings,
      ...(profile.dropped > 0
        ? [
            `${profile.dropped} profile line(s) left out (a secret or an instruction)`,
          ]
        : []),
    ],
    snapshot,
    durationMs: result.durationMs,
  };
  appendJournal(dir, run);
  return run;
}

/**
 * Consolidate under the worker lock; null while another worker holds it. A
 * failure is journaled, and the next attempt waits a day.
 *
 * @param {ExtractDeps} deps
 * @returns {Run | null}
 */
export function consolidateLocked(deps) {
  const dir = memoryDir(deps.rootDir);
  const lock = tryLock(dir, deps.lock);
  if (!lock) return null;
  try {
    return consolidate(deps);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error)
    );
    const at = deps.now().toISOString();
    writeConsolidated(dir, { ...readConsolidated(dir), tried: at });
    const run = {
      at,
      job: 'consolidation',
      session: 'consolidation',
      status: 'failed',
      error: message,
    };
    appendJournal(dir, run);
    return run;
  } finally {
    lock.release();
  }
}
