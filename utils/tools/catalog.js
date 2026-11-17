/**
 * The committed tool catalog, `tools/catalog.json`: tools worth knowing about,
 * how to check them, how an agent calls them headless, and how to install
 * them per platform. What is actually installed lives in the registry.
 */
import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '../workspace-config.js';
import { CATALOG_FILE, KINDS, TOOL_NAME_RE } from './registry.js';

/**
 * @typedef {{ darwin?: string, win32?: string, linux?: string, any?: string }} InstallHints
 * @typedef {{
 *   name: string,
 *   kind: import('./registry.js').ToolKind,
 *   purpose: string,
 *   check: string[],
 *   headless?: string,
 *   install?: InstallHints,
 *   docs?: string,
 *   env?: string[],
 *   notes?: string,
 *   recommended?: boolean,
 * }} CatalogEntry
 */

/**
 * Validate a parsed catalog. Returns a list of problems (empty = valid).
 *
 * @param {unknown} catalog
 * @returns {string[]}
 */
export function validateCatalog(catalog) {
  const c = /** @type {{ version?: unknown, tools?: unknown }} */ (catalog);
  if (!c || c.version !== 1 || !Array.isArray(c.tools)) {
    return ['catalog must be { version: 1, tools: [...] }'];
  }
  /** @type {string[]} */
  const errors = [];
  const names = new Set();
  c.tools.forEach((tool, index) => {
    const t = /** @type {Record<string, unknown>} */ (tool ?? {});
    const label = `tools[${index}]`;
    if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
      errors.push(`${label}.name must be lowercase (a-z, 0-9, . _ -)`);
    } else if (names.has(t.name)) {
      errors.push(`${label}.name "${t.name}" is duplicated`);
    } else {
      names.add(t.name);
    }
    if (
      !KINDS.includes(/** @type {string} */ (t.kind)) ||
      t.kind === 'source'
    ) {
      errors.push(`${label}.kind must be agent, cli, or runtime`);
    }
    if (t.recommended !== undefined && typeof t.recommended !== 'boolean') {
      errors.push(`${label}.recommended must be a boolean`);
    }
    if (typeof t.purpose !== 'string') {
      errors.push(`${label}.purpose must be a string`);
    }
    if (
      !Array.isArray(t.check) ||
      t.check.length === 0 ||
      !t.check.every((arg) => typeof arg === 'string')
    ) {
      errors.push(`${label}.check must be a non-empty argv array`);
    }
  });
  return errors;
}

/**
 * Load and validate `tools/catalog.json`.
 *
 * @param {string} [rootDir]
 * @returns {CatalogEntry[]}
 */
export function loadCatalog(rootDir = ROOT_DIR) {
  const file = path.join(rootDir, CATALOG_FILE);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const errors = validateCatalog(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid ${CATALOG_FILE}:\n  - ${errors.join('\n  - ')}`);
  }
  return /** @type {{ tools: CatalogEntry[] }} */ (parsed).tools;
}

/**
 * The install hint for this platform, falling back to `any`, then the docs.
 *
 * @param {CatalogEntry | undefined} entry
 * @param {string} platform  `process.platform`
 * @returns {string | null}
 */
export function installHint(entry, platform) {
  if (!entry) return null;
  const hints = /** @type {Record<string, string | undefined>} */ (
    entry.install ?? {}
  );
  const hint = hints[platform] ?? hints.any;
  if (hint) return hint;
  return entry.docs ? `see ${entry.docs}` : null;
}
