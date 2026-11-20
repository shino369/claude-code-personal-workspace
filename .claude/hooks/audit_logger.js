#!/usr/bin/env node
/**
 * Audit logging hook (Claude Code, Codex, DSH; `--harness <name>`).
 *
 * Appends one JSON line per tool call to
 * <project>/logs/<YYYYMMDD>/logging.jsonl.
 *
 * - Append-only JSONL: each entry is a single small append, so concurrent hook
 *   processes (parallel tool calls, subagents, swarm workers) cannot clobber
 *   each other the way a read-modify-write of a JSON array would.
 * - Anchored to the project: CLAUDE_PROJECT_DIR, else the hook input's cwd,
 *   else process.cwd(). Codex sets no project dir (and may inherit a parent
 *   Claude session's), so it logs under the workspace root.
 * - Entries from Codex and DSH carry `harness`; Claude Code's do not.
 * - Codex sends no PostToolUse for a shell-run `apply_patch`, so those edits
 *   are logged at PreToolUse; its other PreToolUse calls are skipped (they
 *   are logged at PostToolUse).
 * - Secrets are redacted from every string before long fields are truncated,
 *   with the shared rules in utils/redact.js.
 * - Fails open: any error exits 0 so the tool call is never blocked.
 */
import fs from 'fs';
import path from 'path';
import { parseHarness, toolEvent } from '#utils/harness/input.js';
import { runIfMain } from '#utils/module-runner.js';
import { REDACTED, isSecretKey, redactSecrets } from '#utils/redact.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

export const LOG_FILE_NAME = 'logging.jsonl';

/**
 * Resolve the directory that owns the `logs/` folder.
 *
 * @param {{ cwd?: string }} [input]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ harness?: import('#utils/harness/input.js').Harness, rootDir?: string }} [options]
 * @returns {string}
 */
export function getLogRoot(
  input = {},
  env = process.env,
  { harness = 'claude', rootDir = ROOT_DIR } = {}
) {
  if (harness === 'codex') return rootDir;
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
    if (typeof value === 'string' && isSecretKey(key)) {
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
 * @param {string} [harness] recorded unless it is Claude Code
 * @returns {Record<string, unknown>}
 */
export function buildLogEntry(input, now = new Date(), harness = 'claude') {
  /** @type {Record<string, unknown>} */
  const logEntry = {
    timestamp: now.toISOString(),
    harness: harness === 'claude' ? undefined : harness,
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
 * @param {{ harness?: import('#utils/harness/input.js').Harness, rootDir?: string }} [options]
 * @returns {string | null} the log file written to, or null when skipped
 */
export function processHookInput(input, env = process.env, options = {}) {
  const harness = options.harness ?? 'claude';
  if (
    harness === 'codex' &&
    input.hook_event_name === 'PreToolUse' &&
    toolEvent(input).kind !== 'edit'
  ) {
    return null;
  }
  const logFile = ensureLogDirectory(getLogRoot(input, env, options));
  appendLogEntry(logFile, buildLogEntry(input, new Date(), harness));
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
        processHookInput(JSON.parse(inputData), process.env, {
          harness: parseHarness(process.argv.slice(2)),
        });
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
