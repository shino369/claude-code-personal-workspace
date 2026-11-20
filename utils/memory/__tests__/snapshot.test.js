/**
 * Tests for utils/memory/snapshot.js (copies of the store before a job)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_SNAPSHOTS,
  SNAPSHOTS_DIR,
  SNAPSHOT_FILES,
  listSnapshots,
  markUndone,
  snapshotDir,
  takeSnapshot,
} from '../snapshot.js';

/** @type {string} */
let root;

const NOW = new Date(2026, 10, 20, 14, 3, 9);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-snapshot-'));
  fs.mkdirSync(path.join(root, 'memory'));
  fs.writeFileSync(path.join(root, 'memory', 'log.jsonl'), '{"op":"add"}\n');
  fs.writeFileSync(path.join(root, 'AGENTS.local.md'), '# mine\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('takeSnapshot', () => {
  test('should copy the store files that exist, with a meta file', () => {
    const snapshot = takeSnapshot(root, {
      reason: 'import',
      now: NOW,
      detail: 'memory-export-261120.tar.gz',
    });

    expect(snapshot.id).toBe('20261120-140309-import');
    expect(
      fs.readFileSync(path.join(snapshot.dir, 'memory', 'log.jsonl'), 'utf-8')
    ).toBe('{"op":"add"}\n');
    expect(
      fs.readFileSync(path.join(snapshot.dir, 'AGENTS.local.md'), 'utf-8')
    ).toBe('# mine\n');
    expect(
      fs.existsSync(path.join(snapshot.dir, 'memory', 'personalization.json'))
    ).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(snapshot.dir, 'meta.json'), 'utf-8'))
    ).toEqual({
      id: snapshot.id,
      reason: 'import',
      at: NOW.toISOString(),
      detail: 'memory-export-261120.tar.gz',
      files: ['memory/log.jsonl', 'AGENTS.local.md'],
      logBytes: 13,
    });
  });

  test('should keep two snapshots taken in the same second apart', () => {
    const first = takeSnapshot(root, { reason: 'import', now: NOW });
    const second = takeSnapshot(root, { reason: 'import', now: NOW });

    expect(second.id).toBe(`${first.id}-2`);
  });

  test('should refuse a reason that is not a word', () => {
    expect(() => takeSnapshot(root, { reason: '../x' })).toThrow(/reason/);
  });

  test('should keep the files it copies under memory/', () => {
    expect(SNAPSHOT_FILES).toContain('memory/log.jsonl');
    const { dir } = takeSnapshot(root, { reason: 'import' });

    expect(path.dirname(dir)).toBe(path.join(root, 'memory', SNAPSHOTS_DIR));
  });
});

describe('listSnapshots', () => {
  test('should list snapshots newest first, skipping broken ones', () => {
    takeSnapshot(root, { reason: 'import', now: NOW });
    takeSnapshot(root, {
      reason: 'consolidate',
      now: new Date(NOW.getTime() + 60_000),
    });
    fs.mkdirSync(path.join(root, 'memory', SNAPSHOTS_DIR, 'broken'));

    expect(listSnapshots(root).map((s) => s.reason)).toEqual([
      'consolidate',
      'import',
    ]);
  });

  test('should list nothing before the first snapshot', () => {
    expect(listSnapshots(root)).toEqual([]);
  });
});

describe('snapshot upkeep', () => {
  test('should record an empty log as zero bytes', () => {
    fs.rmSync(path.join(root, 'memory', 'log.jsonl'));

    takeSnapshot(root, { reason: 'import', now: NOW });

    expect(listSnapshots(root)[0].logBytes).toBe(0);
  });

  test('should keep only the newest snapshots', () => {
    for (let i = 0; i <= MAX_SNAPSHOTS; i++) {
      takeSnapshot(root, {
        reason: 'extract',
        now: new Date(NOW.getTime() + i * 1000),
      });
    }

    const kept = listSnapshots(root);

    expect(kept).toHaveLength(MAX_SNAPSHOTS);
    expect(kept.at(-1)?.at).toBe(new Date(NOW.getTime() + 1000).toISOString());
  });

  test('should mark a snapshot undone', () => {
    const { id, dir } = takeSnapshot(root, { reason: 'import', now: NOW });

    markUndone(root, id, NOW);

    expect(snapshotDir(root, id)).toBe(dir);
    expect(listSnapshots(root)[0].undone).toBe(NOW.toISOString());
  });
});
