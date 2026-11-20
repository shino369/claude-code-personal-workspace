/**
 * Tests for utils/memory/worker.js (the detached extraction worker)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { MIN_CHANGES } from '../consolidate.js';
import { tryLock } from '../queue.js';
import { initLocal } from '../render.js';
import { addNote, memoryDir } from '../store.js';
import { work } from '../worker.js';

/** @type {string} */
let root;

const NOW = new Date('2026-11-20T12:00:00.000Z');

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-worker-'))
  );
  initLocal(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {any} [overrides] */
const deps = (overrides = {}) => ({
  rootDir: root,
  env: {},
  now: () => NOW,
  runAgent: vi.fn(() => {
    const stdout = '{"profile": [], "ops": []}';
    return { code: 0, signal: null, stdout, output: stdout, durationMs: 1 };
  }),
  tmpdir: () => root,
  lock: { isAlive: () => true },
  ...overrides,
});

test('should extract only when nothing is due', () => {
  expect(work(deps())).toEqual([]);
});

test('should consolidate after the queue when it is due', () => {
  for (let i = 0; i < MIN_CHANGES; i++) {
    addNote(
      memoryDir(root),
      {
        scope: 'user',
        type: 'preference',
        text: `Preference ${i}: likes item${i}.`,
      },
      { now: NOW }
    );
  }

  const runs = work(deps());

  expect(runs).toEqual([
    expect.objectContaining({ job: 'consolidation', status: 'consolidated' }),
  ]);
});

test('should return null while another worker runs', () => {
  tryLock(memoryDir(root), { pid: 999, isAlive: () => true });

  expect(work(deps())).toBeNull();
});
