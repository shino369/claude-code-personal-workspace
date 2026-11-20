/**
 * `pnpm memory undo`: revert the last job that changed the store (an
 * extraction run, a consolidation, an import) from the snapshot it took
 * just before (snapshot.js), newest first, one job per call.
 *
 * Restoring the snapshot alone would also drop what was saved after the
 * job, so the log becomes the snapshot's log plus every later op except the
 * job's own (they carry the job's time) and ops on notes the job created.
 * When the job replaced the log (`import --replace`), later ops cannot be
 * kept and are counted as lost. Only the files the job could change are put
 * back: for an import the settings, memory/persona.md, and AGENTS.local.md;
 * for a consolidation the profile; an extraction changes notes only. The
 * state before the undo is kept as an `undo` snapshot,
 * which undo itself never picks.
 */
import fs from 'fs';
import path from 'path';
import { formatLocal } from '../task/markdown.js';
import { readIfExists, withLock, writeFileAtomic } from '../task/store.js';
import { refreshAfterWrite } from './context.js';
import { AGENTS_LOCAL_FILE } from './render.js';
import {
  SNAPSHOTS_DIR,
  listSnapshots,
  markUndone,
  snapshotDir,
  takeSnapshot,
} from './snapshot.js';
import {
  CACHE_DIR,
  LOG_FILE,
  MEMORY_DIR,
  NOTES_CACHE_FILE,
  memoryDir,
  parseLog,
} from './store.js';

/**
 * The files each job may change, put back as they were. A file the job
 * created is removed, except the user's own (AGENTS.local.md, persona.md).
 */
const RESTORED = {
  import: [
    `${MEMORY_DIR}/personalization.json`,
    `${MEMORY_DIR}/persona.md`,
    AGENTS_LOCAL_FILE,
  ],
  consolidate: [`${MEMORY_DIR}/profile.md`],
};
const NEVER_REMOVED = [AGENTS_LOCAL_FILE, `${MEMORY_DIR}/persona.md`];
const JOBS = {
  extract: 'extraction',
  consolidate: 'consolidation',
  import: 'import',
};

/**
 * @typedef {import('./snapshot.js').SnapshotMeta} SnapshotMeta
 * @typedef {{ snapshot: SnapshotMeta, log: string, undone: number, kept: number, lost: number }} UndoPlan
 * @typedef {UndoPlan & { backup: string | null, warnings: string[] }} UndoResult
 */

/**
 * What undoing the newest job would do; writes nothing.
 *
 * @param {string} rootDir
 * @returns {UndoPlan | null} null when there is nothing to undo
 */
export function planUndo(rootDir) {
  const snapshot = listSnapshots(rootDir).find(
    (meta) => meta.reason !== 'undo' && !meta.undone
  );
  if (!snapshot) return null;
  const before =
    readIfExists(
      path.join(snapshotDir(rootDir, snapshot.id), MEMORY_DIR, LOG_FILE)
    ) ?? '';
  const current = readIfExists(path.join(memoryDir(rootDir), LOG_FILE)) ?? '';
  const appended = current.startsWith(before);
  const { ops } = parseLog(appended ? current.slice(before.length) : current);
  /** @param {import('./store.js').Op} op */
  const target = (op) => (op.op === 'add' ? op.note?.id : op.id);
  const created = new Set(
    ops.filter((op) => op.at === snapshot.at && op.op === 'add').map(target)
  );
  const kept = [];
  let undone = 0;
  let lost = 0;
  for (const op of ops) {
    if (op.at === snapshot.at) undone += 1;
    else if (appended && !created.has(target(op))) kept.push(op);
    else lost += 1;
  }
  return {
    snapshot,
    log: before + kept.map((op) => `${JSON.stringify(op)}\n`).join(''),
    undone,
    kept: kept.length,
    lost,
  };
}

/**
 * Undo the newest job (see the module comment).
 *
 * @param {string} rootDir the checkout that holds memory/
 * @param {{ now?: Date, dryRun?: boolean }} [options]
 * @returns {UndoResult | null} null when there is nothing to undo
 */
export function undoLast(rootDir, { now = new Date(), dryRun = false } = {}) {
  const dir = memoryDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const result = withLock(
    dir,
    () => {
      const plan = planUndo(rootDir);
      if (!plan || dryRun)
        return plan && { ...plan, backup: null, warnings: [] };
      const from = snapshotDir(rootDir, plan.snapshot.id);
      const files =
        RESTORED[/** @type {keyof typeof RESTORED} */ (plan.snapshot.reason)] ??
        [];
      // Read what to put back before the backup snapshot may prune old ones.
      const restore = files.map((file) => ({
        file,
        content: plan.snapshot.files.includes(file)
          ? fs.readFileSync(path.join(from, file))
          : null,
      }));
      const backup = takeSnapshot(rootDir, {
        reason: 'undo',
        now,
        detail: `before undoing ${plan.snapshot.id}`,
      }).id;
      writeFileAtomic(path.join(dir, LOG_FILE), plan.log);
      for (const { file, content } of restore) {
        const target = path.join(rootDir, file);
        if (content !== null) fs.writeFileSync(target, content);
        else if (!NEVER_REMOVED.includes(file)) {
          fs.rmSync(target, { force: true });
        }
      }
      fs.rmSync(path.join(dir, CACHE_DIR, NOTES_CACHE_FILE), { force: true });
      markUndone(rootDir, plan.snapshot.id, now);
      return { ...plan, backup, warnings: /** @type {string[]} */ ([]) };
    },
    { label: 'Memory' }
  );
  if (result?.backup) result.warnings.push(...refreshAfterWrite(rootDir));
  return result;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {UndoResult | null} result
 * @returns {string[]}
 */
export function formatUndo(result) {
  if (!result) {
    return [
      'Nothing to undo: no extraction, consolidation, or import left to revert.',
    ];
  }
  const { snapshot, undone, kept, lost, backup } = result;
  const job =
    JOBS[/** @type {keyof typeof JOBS} */ (snapshot.reason)] ?? snapshot.reason;
  const when = formatLocal(new Date(snapshot.at), { withTime: true });
  const what = `the ${job} of ${when}${snapshot.detail ? ` (${snapshot.detail})` : ''}`;
  const parts = [
    count(undone, 'change reverted', 'changes reverted'),
    count(kept, 'later change kept', 'later changes kept'),
    ...(lost > 0
      ? [
          `${count(lost, 'later change lost', 'later changes lost')} (${lost === 1 ? 'it touched a note' : 'they touched notes'} the job created, or the store was replaced)`,
        ]
      : []),
  ].join('; ');
  if (backup === null) {
    return [`Would undo ${what}: ${parts}. Nothing was changed.`];
  }
  return [
    `Undid ${what}: ${parts}.`,
    `The state before the undo: ${MEMORY_DIR}/${SNAPSHOTS_DIR}/${backup}`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ];
}
