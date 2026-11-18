/**
 * The machine's tool registry, `tools/local.json` (git-ignored): which agents,
 * CLIs, runtimes, and source checkouts exist on this machine, where they are,
 * and how to call them. The committed `tools/catalog.json` lists tools worth
 * having; this file records what is actually installed here.
 *
 * Never store secrets here: entries name the env vars a tool needs, not values.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readIfExists, writeFileAtomic } from '../task/store.js';

export const REGISTRY_VERSION = 1;
export const TOOLS_DIR = 'tools';
// Repo-relative with `/` (shown in messages; path.join accepts it on Windows).
export const LOCAL_FILE = `${TOOLS_DIR}/local.json`;
export const CATALOG_FILE = `${TOOLS_DIR}/catalog.json`;
export const KINDS = ['agent', 'cli', 'runtime', 'source'];
export const TOOL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * @typedef {'agent' | 'cli' | 'runtime' | 'source'} ToolKind
 * @typedef {{
 *   name: string,
 *   kind: ToolKind,
 *   path: string | null,
 *   command?: string,
 *   version: string | null,
 *   via?: string,
 *   source: 'scan' | 'manual',
 *   ok: boolean,
 *   checkedAt: string,
 *   check?: string[],
 *   headless?: string,
 *   env?: string[],
 *   notes?: string,
 *   task?: string,
 * }} ToolEntry
 *   `command` is how to invoke the tool when it is not simply `name` on PATH
 *   (e.g. `npx -y @deepseek-ai/dsh`); `path` is the executable or, for a
 *   source checkout, its directory.
 * @typedef {{ version: number, updatedAt: string | null, tools: ToolEntry[] }} Registry
 */

/**
 * Where source checkouts of reusable tools live: outside the repository, so
 * lint, tests, and formatting never pick them up, and shared by every
 * worktree. `AGENT_TOOLS_HOME` overrides the base directory.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function sourcesDir(env = process.env) {
  const base =
    env.AGENT_TOOLS_HOME || path.join(os.homedir(), '.cache', 'agent-tools');
  return path.join(base, 'src');
}

/** @param {unknown} value */
const isString = (value) => typeof value === 'string';
/** @param {unknown} value */
const isOptionalString = (value) => value === undefined || isString(value);
/** @param {unknown} value */
const isOptionalStringArray = (value) =>
  value === undefined ||
  (Array.isArray(value) && value.every((item) => isString(item)));

/**
 * Validate one entry. Returns a list of problems (empty = valid).
 *
 * @param {unknown} entry
 * @param {string} [label]
 * @returns {string[]}
 */
export function validateEntry(entry, label = 'tool') {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`${label} must be an object`];
  }
  const e = /** @type {Record<string, unknown>} */ (entry);
  /** @type {string[]} */
  const errors = [];
  if (!isString(e.name) || !TOOL_NAME_RE.test(e.name)) {
    errors.push(`${label}.name must be lowercase (a-z, 0-9, . _ -)`);
  }
  if (!KINDS.includes(/** @type {string} */ (e.kind))) {
    errors.push(`${label}.kind must be one of ${KINDS.join(', ')}`);
  }
  for (const key of ['path', 'version']) {
    if (e[key] !== null && !isString(e[key])) {
      errors.push(`${label}.${key} must be a string or null`);
    }
  }
  if (e.source !== 'scan' && e.source !== 'manual') {
    errors.push(`${label}.source must be scan or manual`);
  }
  if (typeof e.ok !== 'boolean') errors.push(`${label}.ok must be a boolean`);
  if (!isString(e.checkedAt))
    errors.push(`${label}.checkedAt must be a string`);
  for (const key of ['command', 'via', 'headless', 'notes', 'task']) {
    if (!isOptionalString(e[key]))
      errors.push(`${label}.${key} must be a string`);
  }
  for (const key of ['check', 'env']) {
    if (!isOptionalStringArray(e[key])) {
      errors.push(`${label}.${key} must be a string array`);
    }
  }
  return errors;
}

/**
 * Validate a parsed registry. Returns a list of problems (empty = valid).
 *
 * @param {unknown} registry
 * @returns {string[]}
 */
export function validateRegistry(registry) {
  if (
    typeof registry !== 'object' ||
    registry === null ||
    Array.isArray(registry)
  ) {
    return ['registry must be a JSON object'];
  }
  const r = /** @type {Record<string, unknown>} */ (registry);
  /** @type {string[]} */
  const errors = [];
  if (r.version !== REGISTRY_VERSION) {
    errors.push(`version must be ${REGISTRY_VERSION}`);
  }
  if (r.updatedAt !== null && !isString(r.updatedAt)) {
    errors.push('updatedAt must be a string or null');
  }
  if (!Array.isArray(r.tools)) {
    errors.push('tools must be an array');
    return errors;
  }
  const names = new Set();
  r.tools.forEach((entry, index) => {
    errors.push(...validateEntry(entry, `tools[${index}]`));
    const name = /** @type {{ name?: unknown }} */ (entry)?.name;
    if (names.has(name))
      errors.push(`tools[${index}].name "${name}" is duplicated`);
    names.add(name);
  });
  return errors;
}

/** @returns {Registry} */
export const emptyRegistry = () => ({
  version: REGISTRY_VERSION,
  updatedAt: null,
  tools: [],
});

/**
 * Read `tools/local.json`; an empty registry when it does not exist yet.
 *
 * @param {string} rootDir
 * @returns {Registry}
 */
export function readRegistry(rootDir) {
  const file = path.join(rootDir, LOCAL_FILE);
  const text = readIfExists(file);
  if (text === null) return emptyRegistry();
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${LOCAL_FILE} is not valid JSON (${/** @type {Error} */ (error).message}).\nFix: pnpm tools scan --reset`
    );
  }
  const errors = validateRegistry(parsed);
  if (errors.length > 0) {
    throw new Error(
      `Invalid ${LOCAL_FILE}:\n  - ${errors.join('\n  - ')}\nFix: pnpm tools scan --reset`
    );
  }
  return /** @type {Registry} */ (parsed);
}

/**
 * Validate and write `tools/local.json` atomically, entries sorted by name.
 *
 * @param {string} rootDir
 * @param {Registry} registry
 * @param {Date} now
 * @returns {Registry}
 */
export function writeRegistry(rootDir, registry, now) {
  const next = {
    ...registry,
    updatedAt: now.toISOString(),
    tools: [...registry.tools].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const errors = validateRegistry(next);
  if (errors.length > 0) {
    throw new Error(
      `Refusing to write ${LOCAL_FILE}:\n  - ${errors.join('\n  - ')}`
    );
  }
  fs.mkdirSync(path.join(rootDir, TOOLS_DIR), { recursive: true });
  writeFileAtomic(
    path.join(rootDir, LOCAL_FILE),
    `${JSON.stringify(next, null, 2)}\n`
  );
  return next;
}

/**
 * @param {string} rootDir
 * @param {string} name
 * @returns {ToolEntry | null}
 */
export function findTool(rootDir, name) {
  return readRegistry(rootDir).tools.find((t) => t.name === name) ?? null;
}

/**
 * How to invoke a registered tool, as an argv prefix: its `command` split on
 * whitespace (e.g. `["npx", "-y", "@deepseek-ai/dsh"]`), else its recorded
 * path as one element (paths may contain spaces). Null when the tool is not
 * registered, not working, or a source checkout, so callers fall back to
 * their default executable.
 *
 * @param {string} rootDir
 * @param {string} name
 * @returns {string[] | null}
 */
export function commandFor(rootDir, name) {
  const entry = findTool(rootDir, name);
  if (!entry || !entry.ok || entry.kind === 'source') return null;
  if (entry.command?.trim()) return entry.command.trim().split(/\s+/);
  return entry.path ? [entry.path] : null;
}
