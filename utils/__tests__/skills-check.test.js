import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { formatResult, main, summarize } from '../skills-check.js';

/** @type {string[]} */
let tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-check-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {string} name
 * @param {string} [frontmatterName]
 */
async function writeSkill(root, name, frontmatterName = name) {
  const skillDir = path.join(root, '.claude', 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: test\n---\n`
  );
}

/**
 * @param {string} root
 * @param {Record<string, { computedHash?: string }>} skills
 */
async function writeLock(root, skills) {
  await writeFile(
    path.join(root, 'skills-lock.json'),
    JSON.stringify({ version: 1, skills })
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

describe('formatResult', () => {
  test('formats a match', () => {
    expect(formatResult({ name: 'alpha', ok: true })).toBe('✓ alpha');
  });

  test('formats a missing skill', () => {
    expect(formatResult({ name: 'alpha', ok: false, missing: true })).toBe(
      '✗ alpha (missing)'
    );
  });

  test('formats a frontmatter mismatch', () => {
    expect(
      formatResult({
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: 'beta',
      })
    ).toBe('✗ alpha (frontmatter name: beta)');
  });

  test('formats a missing frontmatter name', () => {
    expect(
      formatResult({
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: null,
      })
    ).toBe('✗ alpha (frontmatter name: none)');
  });
});

describe('summarize', () => {
  test('summarizes all matches', () => {
    expect(summarize([{ ok: true }, { ok: true }])).toBe(
      '2 skill(s) match skills-lock.json'
    );
  });

  test('summarizes failures', () => {
    expect(summarize([{ ok: true }, { ok: false }])).toBe(
      '1 of 2 skill(s) do not match skills-lock.json'
    );
  });
});

describe('main', () => {
  test('returns 0 and logs matches', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha');
    await writeLock(root, { alpha: { computedHash: 'hash' } });
    /** @type {string[]} */
    const lines = [];

    const code = await main({ rootDir: root, log: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(lines).toContain('✓ alpha');
    expect(lines).toContain('1 skill(s) match skills-lock.json');
  });

  test('returns 1 and logs a frontmatter mismatch', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha', 'beta');
    await writeLock(root, { alpha: { computedHash: 'hash' } });
    /** @type {string[]} */
    const lines = [];

    const code = await main({ rootDir: root, log: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines).toContain('✗ alpha (frontmatter name: beta)');
  });

  test('returns 1 and logs a missing skill', async () => {
    const root = await makeTempDir();
    await writeLock(root, { alpha: { computedHash: 'hash' } });
    /** @type {string[]} */
    const lines = [];

    const code = await main({ rootDir: root, log: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines).toContain('✗ alpha (missing)');
    expect(lines).toContain('1 of 1 skill(s) do not match skills-lock.json');
  });

  test('checks the repository by default', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(main()).resolves.toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
