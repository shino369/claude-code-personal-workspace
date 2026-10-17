/**
 * Verify that skills-lock.json entries are installed under .claude/skills.
 *
 * The lock's `computedHash` is a source snapshot hash produced during download;
 * it is not reproducible from the installed copy. This module therefore checks
 * inventory and skill identity, while content changes are reviewed via git diff.
 */
import { readFile } from 'fs/promises';
import path from 'path';

/**
 * @typedef {{ name: string, ok: boolean, missing?: boolean, nameMismatch?: boolean, actualName?: string | null }} SkillCheckResult
 */

/**
 * @param {string} lockPath
 * @returns {Promise<{ version?: number, skills: Record<string, { computedHash?: string }> }>}
 */
export async function readSkillsLock(lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const skills = lock?.skills;

  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    throw new Error(`Invalid skills lock: ${lockPath}`);
  }

  return lock;
}

/**
 * Read the `name` field from a SKILL.md frontmatter block.
 *
 * @param {string} skillPath
 * @returns {Promise<string | null>}
 */
async function readSkillName(skillPath) {
  const content = await readFile(skillPath, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;

  const nameLine = frontmatter[1].match(/^name:\s*(.+)$/m);
  if (!nameLine) return null;

  return nameLine[1].trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Verify every lock entry has a .claude/skills/<name>/SKILL.md whose
 * frontmatter name matches the lock key.
 *
 * @param {{ rootDir: string, lockPath: string }} options
 * @returns {Promise<SkillCheckResult[]>}
 */
export async function checkSkills({ rootDir, lockPath }) {
  const lock = await readSkillsLock(lockPath);
  /** @type {SkillCheckResult[]} */
  const results = [];

  for (const name of Object.keys(lock.skills)) {
    const skillPath = path.join(rootDir, '.claude', 'skills', name, 'SKILL.md');

    try {
      const actualName = await readSkillName(skillPath);
      if (actualName === name) {
        results.push({ name, ok: true, actualName });
      } else {
        results.push({ name, ok: false, nameMismatch: true, actualName });
      }
    } catch (error) {
      const code = /** @type {{ code?: string } | undefined} */ (error)?.code;
      if (code !== 'ENOENT') throw error;
      results.push({ name, ok: false, missing: true, actualName: null });
    }
  }

  return results;
}
