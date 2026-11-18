/**
 * Spawn external tools without a shell, on every OS.
 *
 * On Windows, npm, pnpm, nvm4w, and similar installers put a `.cmd` shim next to
 * an extensionless POSIX script (`pnpm` and `pnpm.cmd`). `spawnSync('pnpm')`
 * finds neither (Node applies no PATHEXT without a shell), and spawning a
 * `.cmd` directly fails with EINVAL since Node's CVE-2024-27980 fix. So:
 * `which` prefers PATHEXT matches, and `crossSpawn` runs `.cmd`/`.bat` files
 * through `cmd.exe /d /s /c` with strictly quoted arguments. Elsewhere it is
 * plain `spawnSync`.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * @typedef {(bin: string, args: string[], options: object) => { status: number | null, signal?: string | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null, error?: Error }} Spawn
 * @typedef {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isExecutable: (file: string) => boolean }} LookupDeps
 */

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable on PATH, like `which`, without a shell. Names with a
 * path separator are checked as given. On Windows the PATHEXT extensions are
 * tried before the bare name, so `pnpm.cmd` wins over a `pnpm` sh script.
 *
 * @param {string} name
 * @param {LookupDeps} deps
 * @returns {string | null}
 */
export function which(name, { env, platform, isExecutable: canRun }) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win
    ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '']
    : [''];
  if (name.includes('/') || (win && name.includes('\\'))) {
    return exts.map((ext) => name + ext).find((file) => canRun(file)) ?? null;
  }
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(win ? ';' : ':')
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      if (canRun(file)) return file;
    }
  }
  return null;
}

/** Characters cmd.exe interprets even inside double quotes. */
const CMD_UNSAFE = /["%!\r\n]/;
/** Arguments that need no quotes on a cmd.exe command line. */
const CMD_PLAIN = /^[\w\-.:\\/=@+,]+$/;

/**
 * Quote one argument for a `cmd.exe /s /c "…"` command line. Refuses what
 * cannot be passed safely rather than escaping it: the callers pass fixed
 * flags and paths, never prompts (those go on stdin).
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteCmdArg(arg) {
  if (CMD_UNSAFE.test(arg)) {
    throw new Error(
      `${JSON.stringify(arg)} cannot be passed safely to a Windows .cmd/.bat shim (it contains " % ! or a line break).\nFix: pass it on stdin or in a file instead`
    );
  }
  return CMD_PLAIN.test(arg) ? arg : `"${arg}"`;
}

/**
 * The command to actually spawn for `bin args` on this platform.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {Partial<LookupDeps>} [deps]
 * @returns {{ bin: string, args: string[], options: { windowsVerbatimArguments?: boolean } }}
 */
export function resolveCommand(
  bin,
  args,
  {
    env = process.env,
    platform = process.platform,
    isExecutable: canRun = isExecutable,
  } = {}
) {
  if (platform !== 'win32') return { bin, args, options: {} };
  const file = which(bin, { env, platform, isExecutable: canRun }) ?? bin;
  if (!/\.(cmd|bat)$/i.test(file)) return { bin: file, args, options: {} };
  const line = [file, ...args].map(quoteCmdArg).join(' ');
  return {
    bin: env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * A `spawnSync`-compatible function that resolves the command first (see
 * `resolveCommand`). Use it as the default spawn for external tools.
 *
 * @param {Spawn} [spawn]
 * @param {Partial<LookupDeps>} [deps]
 * @returns {Spawn}
 */
export function crossSpawn(
  spawn = /** @type {Spawn} */ (spawnSync),
  deps = {}
) {
  return (bin, args, options) => {
    const resolved = resolveCommand(bin, args, deps);
    return spawn(resolved.bin, resolved.args, {
      ...options,
      ...resolved.options,
    });
  };
}
