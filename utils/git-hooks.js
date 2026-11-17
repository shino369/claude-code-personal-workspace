#!/usr/bin/env node
/**
 * Git hooks shared by every agent harness and human contributor.
 *
 * Invoked by the shims in `.githooks/` (enabled with
 * `git config core.hooksPath .githooks`, done by `pnpm workspace:setup`):
 *
 *   node utils/git-hooks.js pre-commit
 *   node utils/git-hooks.js commit-msg <message-file>
 *
 * pre-commit checks staged files with Prettier and ESLint; commit-msg enforces
 * Conventional Commits (see AGENTS.md §5).
 * Every failure ends with the exact command that fixes it.
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { runIfMain } from './module-runner.js';

export const COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'style',
  'perf',
  'ci',
  'build',
];

export const MAX_DESCRIPTION_LENGTH = 50;

export const SKIP_PREFIXES = [
  'Merge ',
  'Revert "',
  'fixup! ',
  'squash! ',
  'amend! ',
];

export const FORMAT_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.md',
  '.yaml',
  '.yml',
];

export const LINT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];

const EXPECTED_FORMAT =
  'Expected "<type>(<scope>): <description>", e.g. "fix(hooks): handle missing transcript"';

const HEADER_PATTERN = /^([a-z]+)(\(([^)]*)\))?(!)?: (.*)$/;

const NO_VERIFY_NOTE =
  'Humans only, in an emergency: git commit --no-verify skips these checks.';

/**
 * @typedef {{ ok: true } | { ok: false, error: string, hint: string }} ValidationResult
 * @typedef {(command: string, args: string[], options: object) => { status: number | null, stdout?: string | Buffer | null }} SpawnFn
 */

/**
 * @param {string} message
 * @returns {string}
 */
function firstMeaningfulLine(message) {
  const lines = message
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.trimEnd());
  return lines.find((line) => line.length > 0) ?? '';
}

/**
 * Validate a commit message against the workspace Conventional Commits rules.
 *
 * @param {string} message
 * @returns {ValidationResult}
 */
export function validateCommitMessage(message) {
  const header = firstMeaningfulLine(message);

  if (!header) {
    return {
      ok: false,
      error: 'Commit message is empty.',
      hint: EXPECTED_FORMAT,
    };
  }

  if (SKIP_PREFIXES.some((prefix) => header.startsWith(prefix))) {
    return { ok: true };
  }

  const match = HEADER_PATTERN.exec(header);
  if (!match) {
    return {
      ok: false,
      error: `Commit header "${header}" is not in Conventional Commits format.`,
      hint: EXPECTED_FORMAT,
    };
  }

  const [, type, scopeGroup, scope, , description] = match;

  if (!COMMIT_TYPES.includes(type)) {
    return {
      ok: false,
      error: `Unknown commit type "${type}". Allowed: ${COMMIT_TYPES.join(', ')}.`,
      hint: EXPECTED_FORMAT,
    };
  }

  if (scopeGroup !== undefined && !/^[a-z0-9-]+$/.test(scope)) {
    return {
      ok: false,
      error: `Invalid scope "${scope}". Use lowercase letters, digits, and hyphens, e.g. "(hooks)".`,
      hint: EXPECTED_FORMAT,
    };
  }

  // Trailing whitespace is trimmed, so "fix: " never matches HEADER_PATTERN and
  // `description` is always non-empty here.
  if (!/^[a-z0-9]/.test(description)) {
    return {
      ok: false,
      error: `Description must start with a lowercase letter (imperative mood): "${description}".`,
      hint: `e.g. "${type}${scopeGroup ?? ''}: ${description.charAt(0).toLowerCase()}${description.slice(1)}"`,
    };
  }

  if (description.endsWith('.')) {
    return {
      ok: false,
      error: 'Description must not end with a period.',
      hint: `e.g. "${type}${scopeGroup ?? ''}: ${description.replace(/\.+$/, '')}"`,
    };
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Description is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}.`,
      hint: 'Shorten it and move details into the commit body (after a blank line).',
    };
  }

  return { ok: true };
}

/**
 * Resolve the absolute path of a package's CLI entry point from its
 * package.json `bin` field (a string, or an object keyed by the package name).
 *
 * Tools are run as `node <bin>` rather than through `pnpm`/`.cmd` shims:
 * Node refuses to spawn .cmd files without a shell on Windows, and a shell
 * would expose untrusted staged file names to injection.
 *
 * @param {string} pkgName
 * @param {{ resolve?: (request: string) => string, readJson?: (file: string) => any }} [options]
 * @returns {string}
 */
export function resolveBin(
  pkgName,
  {
    resolve = createRequire(import.meta.url).resolve,
    readJson = (file) => JSON.parse(readFileSync(file, 'utf8')),
  } = {}
) {
  const manifestPath = resolve(`${pkgName}/package.json`);
  const manifest = readJson(manifestPath);
  const bin =
    typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.[pkgName];

  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error(`${pkgName} has no "bin" entry in its package.json`);
  }

  return path.join(path.dirname(manifestPath), bin);
}

/**
 * List staged (added, copied, modified, renamed) files.
 *
 * @param {SpawnFn} spawn
 * @returns {string[]}
 */
export function getStagedFiles(spawn) {
  const result = spawn(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8', shell: false }
  );

  if (result.status !== 0) {
    throw new Error('Could not list staged files (git diff --cached failed).');
  }

  return String(result.stdout ?? '')
    .split('\0')
    .filter(Boolean);
}

/**
 * @param {string[]} files
 * @param {string[]} extensions
 * @returns {string[]}
 */
export function filterByExtension(files, extensions) {
  return files.filter((file) =>
    extensions.includes(path.extname(file).toLowerCase())
  );
}

/**
 * Check staged files with Prettier and ESLint.
 *
 * @param {{ spawn?: SpawnFn, log?: (message: string) => void, execPath?: string, resolveBinPath?: (pkgName: string) => string }} [options]
 * @returns {number}
 */
export function runPreCommit({
  spawn = /** @type {SpawnFn} */ (/** @type {unknown} */ (spawnSync)),
  log = console.error,
  execPath = process.execPath,
  resolveBinPath = (pkgName) => resolveBin(pkgName),
} = {}) {
  const staged = getStagedFiles(spawn);
  const formatFiles = filterByExtension(staged, FORMAT_EXTENSIONS);
  if (formatFiles.length === 0) return 0;

  const lintFiles = filterByExtension(formatFiles, LINT_EXTENSIONS);

  /** @type {Record<string, string>} */
  const bins = {};
  for (const pkgName of lintFiles.length > 0
    ? ['prettier', 'eslint']
    : ['prettier']) {
    try {
      bins[pkgName] = resolveBinPath(pkgName);
    } catch {
      log(`✗ Could not find ${pkgName}. Fix: pnpm install`);
      return 1;
    }
  }

  const quote = (/** @type {string[]} */ files) =>
    files.map((file) => JSON.stringify(file)).join(' ');
  let failed = false;

  const prettier = spawn(
    execPath,
    [bins.prettier, '--check', '--ignore-unknown', ...formatFiles],
    { stdio: 'inherit', shell: false }
  );
  if (prettier.status !== 0) {
    failed = true;
    log('✗ Prettier: staged files are not formatted.');
    log(
      `Fix: pnpm exec prettier --write ${quote(formatFiles)} && git add ${quote(formatFiles)}`
    );
  }

  if (lintFiles.length > 0) {
    const eslint = spawn(
      execPath,
      [bins.eslint, '--no-warn-ignored', ...lintFiles],
      { stdio: 'inherit', shell: false }
    );
    if (eslint.status !== 0) {
      failed = true;
      log('✗ ESLint: staged files have lint errors.');
      log(
        `Fix: pnpm exec eslint --fix ${quote(lintFiles)}, fix the rest by hand, then git add ${quote(lintFiles)}`
      );
    }
  }

  if (failed) {
    log(NO_VERIFY_NOTE);
    return 1;
  }

  return 0;
}

/**
 * Validate the commit message file passed by git.
 *
 * @param {string | undefined} messagePath
 * @param {{ readFile?: (file: string) => string, log?: (message: string) => void }} [options]
 * @returns {number}
 */
export function runCommitMsg(
  messagePath,
  { readFile = (file) => readFileSync(file, 'utf8'), log = console.error } = {}
) {
  if (!messagePath) {
    log('Usage: node utils/git-hooks.js commit-msg <message-file>');
    return 2;
  }

  const result = validateCommitMessage(readFile(messagePath));
  if (result.ok) return 0;

  log(`✗ ${result.error}`);
  log(result.hint);
  log('Rules: AGENTS.md → Git conventions.');
  log(NO_VERIFY_NOTE);
  return 1;
}

/**
 * @param {{ argv?: string[], spawn?: SpawnFn, readFile?: (file: string) => string, log?: (message: string) => void, execPath?: string, resolveBinPath?: (pkgName: string) => string }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  spawn,
  readFile,
  log = console.error,
  execPath,
  resolveBinPath,
} = {}) {
  const [command, arg] = argv;

  if (command === 'pre-commit') {
    return runPreCommit({ spawn, log, execPath, resolveBinPath });
  }

  if (command === 'commit-msg') {
    return runCommitMsg(arg, { readFile, log });
  }

  log('Usage: node utils/git-hooks.js <pre-commit | commit-msg <file>>');
  return 2;
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, () => {
  try {
    process.exit(main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
