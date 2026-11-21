/**
 * Memory settings in memory/config.json (gitignored), changed with
 * `pnpm memory set`, `off`, `on`, and `personalize --on|--off`:
 *
 * - `off`: automatic saving is paused everywhere; `offSessions`: paused for
 *   these sessions only (an "incognito" session). Recall still works.
 * - `extractModel`: the model extraction uses; null means the main session's
 *   model (the workspace rule).
 * - `budget`: the core block's size in characters; null means CORE_BUDGET.
 * - `personalizationEnabled`: apply saved personalization to agent sessions.
 *
 * Only settings that differ from the defaults are written.
 */
import fs from 'fs';
import path from 'path';
import { SESSION_ID_RE, readIfExists, writeFileAtomic } from '../task/store.js';
import { MemoryError } from './store.js';

export const CONFIG_FILE = 'config.json';
export const BUDGET_RANGE = { min: 1000, max: 10000 };
/** Session switches kept; older ones belong to sessions long gone. */
export const MAX_OFF_SESSIONS = 50;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

/**
 * @typedef {object} MemoryConfig
 * @property {boolean} off
 * @property {string[]} offSessions
 * @property {string | null} extractModel
 * @property {number | null} budget
 * @property {boolean} personalizationEnabled
 */

/** @type {Readonly<MemoryConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  off: false,
  offSessions: [],
  extractModel: null,
  budget: null,
  personalizationEnabled: true,
});
const KEYS = Object.keys(DEFAULT_CONFIG);

/**
 * @param {string} message
 * @returns {never}
 */
function invalid(message) {
  throw new MemoryError('invalid', message);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeSessions(value) {
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === 'string' && SESSION_ID_RE.test(id))
  ) {
    invalid('offSessions must be a list of session ids.');
  }
  // The last mention of an id wins, so a re-added session counts as newest.
  const unique = value.filter((id, i) => value.lastIndexOf(id) === i);
  return unique.slice(-MAX_OFF_SESSIONS);
}

/**
 * Validate settings and fill in the defaults. Throws MemoryError('invalid').
 *
 * @param {unknown} input
 * @returns {MemoryConfig}
 */
export function normalizeConfig(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('The memory config must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key)) {
      invalid(`Unknown setting "${key}"; settings: ${KEYS.join(', ')}.`);
    }
  }
  const config = { ...DEFAULT_CONFIG, ...input };
  if (typeof config.off !== 'boolean') invalid('off must be true or false.');
  if (typeof config.personalizationEnabled !== 'boolean') {
    invalid('personalizationEnabled must be true or false.');
  }
  const extractModel = config.extractModel;
  if (
    extractModel !== null &&
    (typeof extractModel !== 'string' || !MODEL_RE.test(extractModel))
  ) {
    invalid(
      `Invalid model name ${JSON.stringify(extractModel)}: one word, such as claude-sonnet-5-5.`
    );
  }
  const { budget } = config;
  if (
    budget !== null &&
    !(
      Number.isInteger(budget) &&
      budget >= BUDGET_RANGE.min &&
      budget <= BUDGET_RANGE.max
    )
  ) {
    invalid(
      `The budget must be a whole number of characters from ${BUDGET_RANGE.min} to ${BUDGET_RANGE.max} (got ${budget}).`
    );
  }
  return {
    off: config.off,
    offSessions: normalizeSessions(config.offSessions),
    extractModel,
    budget,
    personalizationEnabled: config.personalizationEnabled,
  };
}

/**
 * @param {string} dir the memory directory
 * @returns {MemoryConfig} the defaults without a config file
 */
export function readConfig(dir) {
  const content = readIfExists(path.join(dir, CONFIG_FILE));
  if (content === null) return { ...DEFAULT_CONFIG, offSessions: [] };
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    invalid(
      `memory/${CONFIG_FILE} is not valid JSON (${/** @type {Error} */ (error).message}). Fix it, or delete it and run pnpm memory set again.`
    );
  }
  return normalizeConfig(parsed);
}

/**
 * @param {string} dir the memory directory
 * @param {MemoryConfig} config
 * @returns {MemoryConfig} what was written
 */
export function writeConfig(dir, config) {
  const normalized = normalizeConfig(config);
  /** @type {Record<string, unknown>} */
  const changed = {};
  for (const key of KEYS) {
    const value = normalized[/** @type {keyof MemoryConfig} */ (key)];
    const fallback = DEFAULT_CONFIG[/** @type {keyof MemoryConfig} */ (key)];
    if (JSON.stringify(value) !== JSON.stringify(fallback))
      changed[key] = value;
  }
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(
    path.join(dir, CONFIG_FILE),
    `${JSON.stringify(changed, null, 2)}\n`
  );
  return normalized;
}

/**
 * Whether automatic saving is paused: everywhere, for this session, or not.
 *
 * @param {MemoryConfig} config
 * @param {string | null} session
 * @returns {'global' | 'session' | null}
 */
export function savingOff(config, session) {
  if (config.off) return 'global';
  if (session && config.offSessions.includes(session)) return 'session';
  return null;
}

/**
 * Turn saving on or off. Off with a session pauses only that session; off
 * without one pauses everywhere. On clears the global switch and this
 * session's, unless `sessionOnly`.
 *
 * @param {MemoryConfig} config
 * @param {boolean} on
 * @param {string | null} session
 * @param {{ sessionOnly?: boolean }} [options]
 * @returns {MemoryConfig}
 */
export function setSaving(config, on, session, { sessionOnly = false } = {}) {
  const others = config.offSessions.filter((id) => id !== session);
  if (on) {
    return {
      ...config,
      off: sessionOnly ? config.off : false,
      offSessions: others,
    };
  }
  if (session) {
    return normalizeConfig({ ...config, offSessions: [...others, session] });
  }
  return { ...config, off: true };
}
