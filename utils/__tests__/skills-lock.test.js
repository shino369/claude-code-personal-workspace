import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { checkSkills, readSkillsLock } from '../skills-lock.js';

/** @type {string[]} */
let tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-lock-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {string} name
 * @param {string | null} [frontmatterName]
 */
async function writeSkill(root, name, frontmatterName = name) {
  const dir = path.join(root, '.claude', 'skills', name);
  await mkdir(dir, { recursive: true });
  const body =
    frontmatterName === null
      ? 'no frontmatter\n'
      : `---\nname: ${frontmatterName}\ndescription: test\n---\n`;
  await writeFile(path.join(dir, 'SKILL.md'), body);
}

/**
 * @param {string} root
 * @param {Record<string, { computedHash?: string }>} skills
 * @returns {Promise<string>}
 */
async function writeLock(root, skills) {
  const lockPath = path.join(root, 'skills-lock.json');
  await writeFile(lockPath, JSON.stringify({ version: 1, skills }));
  return lockPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

describe('readSkillsLock', () => {
  test('reads a valid lock', async () => {
    const dir = await makeTempDir();
    const lockPath = await writeLock(dir, {
      alpha: { computedHash: 'abc' },
    });

    await expect(readSkillsLock(lockPath)).resolves.toEqual({
      version: 1,
      skills: { alpha: { computedHash: 'abc' } },
    });
  });

  test.each([
    ['null', 'null'],
    ['missing skills', '{}'],
    ['non-object skills', JSON.stringify({ skills: 'nope' })],
    ['array skills', JSON.stringify({ skills: [] })],
  ])('rejects %s', async (_name, content) => {
    const dir = await makeTempDir();
    const lockPath = path.join(dir, 'skills-lock.json');
    await writeFile(lockPath, content);

    await expect(readSkillsLock(lockPath)).rejects.toThrow(
      'Invalid skills lock'
    );
  });
});

describe('checkSkills', () => {
  test('reports a matching skill', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha');
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      { name: 'alpha', ok: true, actualName: 'alpha' },
    ]);
  });

  test('reports a missing skill', async () => {
    const root = await makeTempDir();
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      { name: 'alpha', ok: false, missing: true, actualName: null },
    ]);
  });

  test('reports a frontmatter name mismatch', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha', 'beta');
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      {
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: 'beta',
      },
    ]);
  });

  test('reports a missing frontmatter name', async () => {
    const root = await makeTempDir();
    await writeSkill(root, 'alpha', null);
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      {
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: null,
      },
    ]);
  });

  test('reports a frontmatter block without a name', async () => {
    const root = await makeTempDir();
    const skillDir = path.join(root, '.claude', 'skills', 'alpha');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: test\n---\n'
    );
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).resolves.toEqual([
      {
        name: 'alpha',
        ok: false,
        nameMismatch: true,
        actualName: null,
      },
    ]);
  });

  test('rethrows unexpected filesystem errors', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.claude', 'skills', 'alpha', 'SKILL.md'), {
      recursive: true,
    });
    const lockPath = await writeLock(root, {
      alpha: { computedHash: 'hash' },
    });

    await expect(checkSkills({ rootDir: root, lockPath })).rejects.toThrow();
  });
});
