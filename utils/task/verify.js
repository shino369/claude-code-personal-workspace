/**
 * Run a task's verify commands in order and stop at the first failure.
 *
 * Commands come from state.json, which only the task owner writes (same trust
 * level as package.json scripts), and run through the shell so entries like
 * `pnpm test -- utils/task` work unchanged on every platform.
 */
import { spawnSync } from 'child_process';

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const SUMMARY_LINES = 20;

/**
 * @typedef {(command: string, options: object) => { status: number | null, signal?: string | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null, error?: Error }} ShellSpawn
 * @typedef {{ command: string, ok: boolean, code: number | null, durationMs: number, output: string }} CommandResult
 * @typedef {import('./state.js').VerifyResult} VerifyResult
 */

/** @type {ShellSpawn} */
const defaultSpawn = (command, options) =>
  /** @type {ReturnType<ShellSpawn>} */ (
    spawnSync(command, { ...options, shell: true })
  );

/** ANSI escape sequences (colors, cursor moves) that some tools print even with FORCE_COLOR=0. */
export const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * @param {string} text
 * @returns {string}
 */
export const stripAnsi = (text) => text.replace(ANSI_RE, '');

/**
 * Last `count` non-empty lines of text.
 *
 * @param {string} text
 * @param {number} [count]
 * @returns {string}
 */
export function tail(text, count = SUMMARY_LINES) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n');
}

/**
 * @param {{ commands: string[], cwd: string, spawn?: ShellSpawn, timeoutMs?: number, now?: () => number, onStart?: (command: string) => void }} options
 * @returns {CommandResult[]}
 */
export function runCommands({
  commands,
  cwd,
  spawn = defaultSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  onStart = () => {},
}) {
  /** @type {CommandResult[]} */
  const results = [];
  for (const command of commands) {
    onStart(command);
    const started = now();
    const result = spawn(command, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const output = stripAnsi(
      [result.stdout, result.stderr, result.error?.message]
        .filter(Boolean)
        .map(String)
        .join('\n')
    );
    const ok = result.status === 0;
    results.push({
      command,
      ok,
      code: result.status,
      durationMs: now() - started,
      output: result.signal
        ? `${output}\n(stopped by ${result.signal}; timeout ${Math.round(timeoutMs / 1000)}s)`
        : output,
    });
    if (!ok) break;
  }
  return results;
}

/**
 * Condense command results into the `lastVerify` record.
 *
 * @param {CommandResult[]} results
 * @param {Date} at
 * @returns {VerifyResult}
 */
export function summarize(results, at) {
  const failed = results.find((r) => !r.ok);
  return {
    at: at.toISOString(),
    ok: !failed,
    failed: failed ? failed.command : null,
    summary: failed
      ? tail(failed.output)
      : `${results.length} command(s) passed`,
  };
}
