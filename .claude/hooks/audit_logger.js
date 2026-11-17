#!/usr/bin/env node
/**
 * Audit logging hook for Claude Code.
 *
 * Appends one JSON line per tool call to
 * <project>/logs/<YYYYMMDD>/logging.jsonl.
 *
 * - Append-only JSONL: each entry is a single small append, so concurrent hook
 *   processes (parallel tool calls, subagents, swarm workers) cannot clobber
 *   each other the way a read-modify-write of a JSON array would.
 * - Anchored to the project: CLAUDE_PROJECT_DIR, else the hook input's cwd,
 *   else process.cwd().
 * - Secrets are redacted from every string before long fields are truncated.
 * - Fails open: any error exits 0 so the tool call is never blocked.
 */
import fs from 'fs';
import path from 'path';
import { runIfMain } from '#utils/module-runner.js';

export const LOG_FILE_NAME = 'logging.jsonl';
export const REDACTED = '[REDACTED]';

/** Keys whose string values are always redacted (e.g. `{ API_KEY: '...' }`). */
const SECRET_KEY_NAME = /(TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_KEY)/i;

/**
 * Ordered redaction rules. PEM blocks and Bearer tokens run before the generic
 * `NAME=value` rule so multi-part secrets are removed whole.
 *
 * @type {Array<[RegExp, string]>}
 */
const REDACTION_RULES = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${REDACTED}`,
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],
];

/**
 * Replace known secret patterns in a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  return REDACTION_RULES.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text
  );
}

/**
 * Resolve the directory that owns the `logs/` folder.
 *
 * @param {{ cwd?: string }} [input]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getLogRoot(input = {}, env = process.env) {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

/**
 * Create `<root>/logs/<YYYYMMDD>/` and return the JSONL log file path.
 *
 * @param {string} root
 * @param {Date} [now]
 * @returns {string}
 */
export function ensureLogDirectory(root, now = new Date()) {
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const logDir = path.join(root, 'logs', today);
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, LOG_FILE_NAME);
}

/**
 * Append one entry as a single JSON line.
 *
 * @param {string} logFile
 * @param {unknown} entry
 */
export function appendLogEntry(logFile, entry) {
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * Redact secrets in every string, then truncate long `content`/`new_source`.
 *
 * @param {unknown} data
 * @param {number} [maxContentLength]
 * @returns {unknown}
 */
export function sanitizeForLogging(data, maxContentLength = 500) {
  if (typeof data === 'string') return redactSecrets(data);

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForLogging(item, maxContentLength));
  }

  if (typeof data !== 'object' || data === null) return data;

  /** @type {Record<string, unknown>} */
  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && SECRET_KEY_NAME.test(key)) {
      sanitized[key] = REDACTED;
      continue;
    }

    const clean = sanitizeForLogging(value, maxContentLength);
    if (
      ['content', 'new_source'].includes(key) &&
      typeof clean === 'string' &&
      clean.length > maxContentLength
    ) {
      sanitized[key] =
        clean.slice(0, maxContentLength) +
        `... (truncated, total length: ${clean.length})`;
    } else {
      sanitized[key] = clean;
    }
  }
  return sanitized;
}

/**
 * @typedef {object} HookInput
 * @property {string} [session_id]
 * @property {string} [hook_event_name]
 * @property {string} [tool_name]
 * @property {unknown} [tool_input]
 * @property {unknown} [tool_response]
 * @property {string} [cwd]
 * @property {string} [permission_mode]
 */

/**
 * Build a log entry, dropping undefined/null/empty-object fields.
 *
 * @param {HookInput} input
 * @param {Date} [now]
 * @returns {Record<string, unknown>}
 */
export function buildLogEntry(input, now = new Date()) {
  /** @type {Record<string, unknown>} */
  const logEntry = {
    timestamp: now.toISOString(),
    session_id: input.session_id,
    hook_event: input.hook_event_name,
    tool_name: input.tool_name,
    tool_input: sanitizeForLogging(input.tool_input || {}),
    tool_response: sanitizeForLogging(input.tool_response || {}),
    cwd: input.cwd,
    permission_mode: input.permission_mode,
  };

  for (const key of Object.keys(logEntry)) {
    const value = logEntry[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    ) {
      delete logEntry[key];
    }
  }

  return logEntry;
}

/**
 * @param {HookInput} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the log file written to
 */
export function processHookInput(input, env = process.env) {
  const logFile = ensureLogDirectory(getLogRoot(input, env));
  appendLogEntry(logFile, buildLogEntry(input));
  return logFile;
}

/* istanbul ignore next - stdin handling is tested via processHookInput */
function main() {
  try {
    let inputData = '';
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk) => {
      inputData += chunk;
    });

    process.stdin.on('end', () => {
      try {
        processHookInput(JSON.parse(inputData));
        process.exit(0);
      } catch (err) {
        console.error(
          `Audit logging error: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(0); // Exit 0 to not block the operation
      }
    });
  } catch (err) {
    console.error(
      `Audit logging error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0); // Exit 0 to not block the operation
  }
}

runIfMain(import.meta.url, main);
