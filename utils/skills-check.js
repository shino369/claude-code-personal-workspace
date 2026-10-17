#!/usr/bin/env node
/**
 * Verify that skills-lock.json entries are installed under .claude/skills.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { runIfMain } from './module-runner.js';
import { checkSkills } from './skills-lock.js';

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

/**
 * @param {{ name: string, ok: boolean, missing?: boolean, nameMismatch?: boolean, actualName?: string | null }} result
 * @returns {string}
 */
export function formatResult(result) {
  if (result.ok) return `✓ ${result.name}`;
  if (result.missing) return `✗ ${result.name} (missing)`;
  return `✗ ${result.name} (frontmatter name: ${result.actualName ?? 'none'})`;
}

/**
 * @param {Array<{ ok: boolean }>} results
 * @returns {string}
 */
export function summarize(results) {
  const failures = results.filter((result) => !result.ok).length;
  return failures === 0
    ? `${results.length} skill(s) match skills-lock.json`
    : `${failures} of ${results.length} skill(s) do not match skills-lock.json`;
}

/**
 * @param {{ rootDir?: string, lockPath?: string, log?: (message: string) => void }} [options]
 * @returns {Promise<number>}
 */
export async function main({
  rootDir = ROOT_DIR,
  lockPath = path.join(rootDir, 'skills-lock.json'),
  log = console.log,
} = {}) {
  const results = await checkSkills({ rootDir, lockPath });
  for (const result of results) log(formatResult(result));
  log(summarize(results));
  return results.every((result) => result.ok) ? 0 : 1;
}

/* c8 ignore next 3 - CLI entry point */
runIfMain(import.meta.url, async () => {
  process.exit(await main());
});
