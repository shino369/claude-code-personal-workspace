/**
 * Probe tools on this machine: find executables on PATH (no shell), run their
 * check command (Windows .cmd shims through crossSpawn), and turn the result
 * into registry entries.
 */
import fs from 'fs';
import { crossSpawn, isExecutable, which } from '../spawn.js';

// Moved to utils/spawn.js (shared with the agent adapters); re-exported here.
export { isExecutable, which } from '../spawn.js';

export const CHECK_TIMEOUT_MS = 15 * 1000;

/**
 * @typedef {(bin: string, args: string[], options: object) => { status: number | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null, error?: Error }} Spawn
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   platform: NodeJS.Platform,
 *   isExecutable: (file: string) => boolean,
 *   realpath: (file: string) => string,
 *   spawn: Spawn,
 * }} ProbeDeps
 */

/** @returns {ProbeDeps} */
export function defaultProbeDeps() {
  return {
    env: process.env,
    platform: process.platform,
    isExecutable,
    realpath: (file) => {
      try {
        return fs.realpathSync(file);
      } catch {
        return file;
      }
    },
    // Resolves Windows .cmd shims (pnpm.cmd, codex.cmd) and runs them safely.
    spawn: crossSpawn(),
  };
}

/**
 * First version-looking token in a tool's output (`v24.1.0`, `0.155.0`, `2.81`).
 *
 * @param {string} text
 * @returns {string | null}
 */
export function parseVersion(text) {
  const match = text.match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

/** Install-location patterns → how the tool was most likely installed. */
const VIA_PATTERNS = [
  [/[\\/](?:opt[\\/]homebrew|home[\\/]linuxbrew|Cellar)[\\/]/, 'brew'],
  [/[\\/]WinGet[\\/]|[\\/]Microsoft[\\/]WinGet[\\/]/i, 'winget'],
  [/[\\/]\.nvm[\\/]/, 'nvm'],
  [/[\\/]uv[\\/]tools[\\/]/, 'uv tool'],
  [
    /[\\/]Library[\\/]pnpm[\\/]|[\\/]pnpm[\\/]global[\\/]|[\\/]\.local[\\/]share[\\/]pnpm[\\/]/,
    'pnpm (global)',
  ],
  [/[\\/]\.cargo[\\/]bin[\\/]/, 'cargo'],
  [/[\\/]\.local[\\/]share[\\/]claude[\\/]/, 'claude native installer'],
  [/^\/usr\/bin\/|^\/bin\//, 'system'],
];

/**
 * @param {string} realPath
 * @returns {string | undefined}
 */
export function guessVia(realPath) {
  const found = VIA_PATTERNS.find(([re]) =>
    /** @type {RegExp} */ (re).test(realPath)
  );
  return found ? /** @type {string} */ (found[1]) : undefined;
}

/**
 * Run a check command (argv, no shell) and report whether it worked.
 *
 * @param {string[]} argv
 * @param {Pick<ProbeDeps, 'spawn' | 'env'>} deps
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {{ ok: boolean, version: string | null }}
 */
export function runCheck(
  argv,
  { spawn, env },
  { cwd, timeoutMs = CHECK_TIMEOUT_MS } = {}
) {
  const [bin, ...args] = argv;
  const result = spawn(bin, args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, NO_COLOR: '1' },
  });
  const ok = !result.error && result.status === 0;
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { ok, version: ok ? parseVersion(text) : null };
}

/**
 * Probe one catalog tool. Null when its executable is not on PATH.
 *
 * @param {import('./catalog.js').CatalogEntry} tool
 * @param {ProbeDeps} deps
 * @param {Date} now
 * @returns {import('./registry.js').ToolEntry | null}
 */
export function probeTool(tool, deps, now) {
  const [bin, ...args] = tool.check;
  const found = which(bin, deps);
  if (!found) return null;
  const { ok, version } = runCheck([found, ...args], deps);
  const via = guessVia(deps.realpath(found));
  return {
    name: tool.name,
    kind: tool.kind,
    path: found,
    version,
    ...(via ? { via } : {}),
    source: 'scan',
    ok,
    checkedAt: now.toISOString(),
    ...(tool.headless ? { headless: tool.headless } : {}),
    ...(tool.env ? { env: tool.env } : {}),
  };
}

/**
 * Merge a scan into the registry: catalog tools found on PATH are added or
 * refreshed; scan entries no longer found are dropped; manual entries (`pnpm
 * tools add`) are never touched.
 *
 * @param {import('./registry.js').ToolEntry[]} current
 * @param {import('./registry.js').ToolEntry[]} found
 * @returns {{ tools: import('./registry.js').ToolEntry[], added: string[], removed: string[] }}
 */
export function mergeScan(current, found) {
  const manual = current.filter((t) => t.source === 'manual');
  const manualNames = new Set(manual.map((t) => t.name));
  const fresh = found.filter((t) => !manualNames.has(t.name));
  const before = new Set(
    current.filter((t) => t.source === 'scan').map((t) => t.name)
  );
  const after = new Set(fresh.map((t) => t.name));
  return {
    tools: [...manual, ...fresh],
    added: [...after].filter((name) => !before.has(name)),
    removed: [...before].filter((name) => !after.has(name)),
  };
}
