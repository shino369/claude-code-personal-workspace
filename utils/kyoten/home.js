/**
 * Where kyoten's workspace (the "home") is, and kyoten's per-user config.
 *
 * The home is the first match of: `--home`, `$KYOTEN_HOME`, the clone kyoten
 * runs from when the current directory is inside it, the config file's
 * `home`, then `~/.kyoten`. The config file lives outside every workspace
 * (`%APPDATA%\kyoten` on Windows, `$XDG_CONFIG_HOME/kyoten` or
 * `~/.config/kyoten` elsewhere), next to the dscc profile.
 */
import fs from 'fs';
import path from 'path';
import { readIfExists, writeFileAtomic } from '../task/store.js';

export const PACKAGE_NAME = 'kyoten';
export const AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh', 'dscc']);
/** Marks the snapshot inside the npm package (pack.js); never in a home. */
export const SNAPSHOT_FILE = '.kyoten-snapshot.json';
/** kyoten's record of a home it created (`.kyoten/` is git-ignored). */
export const HOME_INFO = path.join('.kyoten', 'home.json');

/**
 * @typedef {typeof AGENTS[number]} AgentName
 * @typedef {{ home?: string, args?: Partial<Record<AgentName, string[]>> }} KyotenConfig
 * @typedef {{ dir: string, source: string }} ResolvedHome
 * @typedef {{ env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string }} UserDirs
 * @typedef {{ managed: true, version: string, sourceCommit: string, createdAt: string, updatedAt?: string }} HomeInfo
 */

/** @param {string} platform */
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {UserDirs} dirs
 * @returns {string}
 */
export function configDir({ env, platform, homedir }) {
  const p = pathFor(platform);
  if (platform === 'win32') {
    return p.join(
      env.APPDATA || p.join(homedir, 'AppData', 'Roaming'),
      'kyoten'
    );
  }
  const xdg = env.XDG_CONFIG_HOME;
  return p.join(
    xdg && p.isAbsolute(xdg) ? xdg : p.join(homedir, '.config'),
    'kyoten'
  );
}

/**
 * A file in kyoten's config dir.
 *
 * @param {UserDirs} dirs
 * @param {string} name
 */
export const configPath = (dirs, name) =>
  pathFor(dirs.platform).join(configDir(dirs), name);

/** @param {UserDirs} dirs */
export const configFile = (dirs) => configPath(dirs, 'config.json');

/** @param {{ platform: NodeJS.Platform, homedir: string }} dirs */
export const defaultHome = ({ platform, homedir }) =>
  pathFor(platform).join(homedir, '.kyoten');

/**
 * `~` and `~/…` (or `~\…`) relative to the user's home directory; shells do
 * not expand `--home=~/x` or a quoted `"~/x"`.
 *
 * @param {string} input
 * @param {string} homedir
 */
export function expandHome(input, homedir) {
  if (input === '~') return homedir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir, input.slice(2));
  }
  return input;
}

/**
 * @param {unknown} data
 * @param {string} file  for messages
 * @returns {KyotenConfig}
 */
export function validateConfig(data, file) {
  /** @param {string} what */
  const bad = (what) =>
    new Error(
      `${file}: ${what}.\nFix: correct the file ({"home": "<absolute path>", "args": {"<agent>": ["--flag"]}}) or delete it`
    );
  if (!isObject(data)) throw bad('expected a JSON object');
  /** @type {KyotenConfig} */
  const config = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'home') {
      if (typeof value !== 'string' || !path.isAbsolute(value)) {
        throw bad('"home" must be an absolute path');
      }
      config.home = value;
    } else if (key === 'args') {
      if (!isObject(value))
        throw bad('"args" must map an agent to a list of arguments');
      for (const [agent, list] of Object.entries(value)) {
        if (!AGENTS.includes(/** @type {AgentName} */ (agent))) {
          throw bad(
            `"args" names an unknown agent "${agent}" (agents: ${AGENTS.join(', ')})`
          );
        }
        if (
          !Array.isArray(list) ||
          !list.every((arg) => typeof arg === 'string')
        ) {
          throw bad(`"args.${agent}" must be a list of strings`);
        }
      }
      config.args = /** @type {KyotenConfig['args']} */ (value);
    } else {
      throw bad(`unknown key "${key}"`);
    }
  }
  return config;
}

/**
 * @param {string} file
 * @returns {KyotenConfig}  `{}` when the file does not exist
 */
export function readConfig(file) {
  const text = readIfExists(file);
  if (text === null) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON.\nFix: correct it or delete it`);
  }
  return validateConfig(data, file);
}

/**
 * @param {string} file
 * @param {KyotenConfig} config
 */
export function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A kyoten workspace: `package.json` named kyoten, the kyoten CLI, and not the
 * snapshot inside the npm package.
 *
 * @param {string} dir
 */
export function isWorkspace(dir) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')
    );
    return (
      pkg?.name === PACKAGE_NAME &&
      fs.existsSync(path.join(dir, 'utils', 'kyoten', 'cli.js')) &&
      !fs.existsSync(path.join(dir, SNAPSHOT_FILE))
    );
  } catch {
    return false;
  }
}

/**
 * The kyoten workspace containing `start`, or null.
 *
 * @param {string} start
 */
export function findWorkspace(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (isWorkspace(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The current-directory rule only takes the clone kyoten itself runs from
 * (`root`, as with `pnpm kyoten`): any repository can look like a kyoten
 * workspace, and its pnpm scripts and agent config must not be used unless
 * the user names it (--home, KYOTEN_HOME, or the config).
 *
 * @param {{ flag?: string, env: NodeJS.ProcessEnv, cwd: string, root?: string, config: KyotenConfig, configPath: string, homedir: string, platform: NodeJS.Platform }} input
 * @returns {ResolvedHome}
 */
export function resolveHome({
  flag,
  env,
  cwd,
  root,
  config,
  configPath,
  homedir,
  platform,
}) {
  if (flag) {
    return {
      dir: path.resolve(cwd, expandHome(flag, homedir)),
      source: '--home',
    };
  }
  if (env.KYOTEN_HOME) {
    return {
      dir: path.resolve(cwd, expandHome(env.KYOTEN_HOME, homedir)),
      source: 'KYOTEN_HOME',
    };
  }
  const found = findWorkspace(cwd);
  if (found && root && samePath(found, root)) {
    return { dir: found, source: 'the clone kyoten runs from' };
  }
  if (config.home) return { dir: config.home, source: configPath };
  return { dir: defaultHome({ platform, homedir }), source: 'default' };
}

/**
 * Whether two paths name the same folder, links resolved.
 *
 * @param {string} a
 * @param {string} b
 */
export function samePath(a, b) {
  /** @param {string} p */
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * @param {string} dir
 * @returns {'missing' | 'empty' | 'workspace' | 'other'}
 */
export function homeState(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'ENOTDIR') return 'other';
    throw error;
  }
  if (entries.length === 0) return 'empty';
  return isWorkspace(dir) ? 'workspace' : 'other';
}

/**
 * @param {string} dir
 * @returns {HomeInfo | null}  null for a clone or an unreadable record
 */
export function readHomeInfo(dir) {
  const text = readIfExists(path.join(dir, HOME_INFO));
  if (text === null) return null;
  try {
    const info = JSON.parse(text);
    return isObject(info) &&
      info.managed === true &&
      typeof info.version === 'string'
      ? /** @type {HomeInfo} */ (info)
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dir
 * @param {HomeInfo} info
 */
export function writeHomeInfo(dir, info) {
  fs.mkdirSync(path.join(dir, path.dirname(HOME_INFO)), { recursive: true });
  writeFileAtomic(
    path.join(dir, HOME_INFO),
    `${JSON.stringify(info, null, 2)}\n`
  );
}
