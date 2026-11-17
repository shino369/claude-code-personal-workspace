/**
 * Shared workspace layout constants.
 *
 * Skills live in `.agents/skills/<name>/` (the skills.sh layout, read directly
 * by Codex and other agents). Harnesses that need their own directory (Claude
 * Code reads `.claude/skills/`) get links pointing back at the canonical copy.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

/** Canonical skills directory, relative to the repository root. */
export const SKILLS_DIR = path.join('.agents', 'skills');

/** Harness skill directories that receive links into SKILLS_DIR. */
export const DEFAULT_LINK_TARGETS = [path.join('.claude', 'skills')];

/**
 * Skills committed to this repository. Everything else in SKILLS_DIR is a
 * third-party install from skills.sh and is excluded from git, lint, format,
 * typecheck, and tests. Keep in sync with the `.gitignore` exceptions.
 */
export const OWNED_SKILLS = [
  'context-manager',
  'dependency-update',
  'document-writing',
  'engineering-terminology',
  'security-update',
  'translation-expertise',
  'web-browsing',
  'workspace-setup',
];

/** Minimum supported Node.js major version (matches `.nvmrc` / engines). */
export const MIN_NODE_MAJOR = 24;

/**
 * Names of installed third-party skills (everything in SKILLS_DIR that is not
 * project-owned). Lint/test configs use this to skip vendored code.
 *
 * @param {string} [rootDir]
 * @param {Pick<typeof fs, 'existsSync' | 'readdirSync'>} [fsApi]
 * @returns {string[]}
 */
export function listThirdPartySkills(rootDir = ROOT_DIR, fsApi = fs) {
  const dir = path.join(rootDir, SKILLS_DIR);
  if (!fsApi.existsSync(dir)) return [];
  return fsApi
    .readdirSync(dir)
    .filter((name) => !OWNED_SKILLS.includes(name))
    .sort();
}

/**
 * Glob patterns for code that tools must not lint, test, or measure:
 * third-party skills and the generated harness link directories.
 *
 * @param {string} [rootDir]
 * @param {Pick<typeof fs, 'existsSync' | 'readdirSync'>} [fsApi]
 * @returns {string[]}
 */
export function vendoredGlobs(rootDir = ROOT_DIR, fsApi = fs) {
  return [
    '**/.claude/skills/**',
    '**/.github/skills/**',
    ...listThirdPartySkills(rootDir, fsApi).map(
      (name) => `**/.agents/skills/${name}/**`
    ),
  ];
}
