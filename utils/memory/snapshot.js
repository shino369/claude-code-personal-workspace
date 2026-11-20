/**
 * Snapshots: a copy of the store files taken before a job rewrites them
 * (`pnpm memory import --replace`, and consolidation), so `pnpm memory undo`
 * can put them back (design §6 path D, §12). Kept in memory/snapshots/
 * (gitignored), one folder per snapshot with a meta.json.
 */
import fs from 'fs';
import path from 'path';
import { writeFileAtomic } from '../task/store.js';
import { MEMORY_DIR, readJsonOrNull } from './store.js';

export const SNAPSHOTS_DIR = 'snapshots';
/** What a snapshot keeps, relative to the checkout. */
export const SNAPSHOT_FILES = [
  `${MEMORY_DIR}/log.jsonl`,
  `${MEMORY_DIR}/personalization.json`,
  `${MEMORY_DIR}/profile.md`,
  'AGENTS.local.md',
];
const REASON_RE = /^[a-z][a-z-]*$/;

/**
 * @typedef {{ id: string, reason: string, at: string, detail: string, files: string[] }} SnapshotMeta
 */

/** @param {string} rootDir */
const snapshotsDir = (rootDir) => path.join(rootDir, MEMORY_DIR, SNAPSHOTS_DIR);

/** @param {Date} date yyyymmdd-hhmmss in local time */
function stamp(date) {
  const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * Copy the store files that exist into a new snapshot.
 *
 * @param {string} rootDir the checkout that holds memory/
 * @param {{ reason: string, now?: Date, detail?: string }} options
 * @returns {{ id: string, dir: string }}
 */
export function takeSnapshot(
  rootDir,
  { reason, now = new Date(), detail = '' }
) {
  if (!REASON_RE.test(reason)) {
    throw new Error(`Invalid snapshot reason "${reason}".`);
  }
  const base = `${stamp(now)}-${reason}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(snapshotsDir(rootDir), id)); n++) {
    id = `${base}-${n}`;
  }
  const dir = path.join(snapshotsDir(rootDir), id);
  fs.mkdirSync(dir, { recursive: true });
  const files = SNAPSHOT_FILES.filter((file) =>
    fs.existsSync(path.join(rootDir, file))
  );
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(rootDir, file), path.join(dir, file));
  }
  /** @type {SnapshotMeta} */
  const meta = { id, reason, at: now.toISOString(), detail, files };
  writeFileAtomic(
    path.join(dir, 'meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`
  );
  return { id, dir };
}

/**
 * @param {string} rootDir
 * @returns {SnapshotMeta[]} newest first; folders without a meta.json are skipped
 */
export function listSnapshots(rootDir) {
  const dir = snapshotsDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map(
      (name) =>
        /** @type {any} */ (readJsonOrNull(path.join(dir, name, 'meta.json')))
    )
    .filter(
      (meta) => typeof meta?.id === 'string' && typeof meta.at === 'string'
    )
    .sort((a, b) => b.at.localeCompare(a.at));
}
