/**
 * Start an agent interactively in the home: which executable, which
 * arguments, which environment, and a spawn that hands the terminal to the
 * agent until it exits.
 *
 * Nothing runs through a shell. On Windows a `.cmd`/`.bat` shim (npm-installed
 * codex or dsh) goes through `cmd.exe` with strict quoting (utils/spawn.js),
 * which refuses arguments it cannot pass safely.
 */
import { spawn as nodeSpawn } from 'child_process';
import os from 'os';
import { DSH_PATCH, dshDirProblem } from '../loop/adapters.js';
import { isExecutable, resolveCommand, which } from '../spawn.js';
import { HARNESS_SESSION_VARS } from '../task/store.js';
import { installHint, loadCatalog } from '../tools/catalog.js';
import { commandFor } from '../tools/registry.js';

/** The dsh profile kyoten starts when the first argument does not name one. */
export const DSH_DEFAULT_PROFILE = 'web';

/**
 * @typedef {import('./home.js').AgentName} AgentName
 * @typedef {{ on: (signal: string, handler: (signal: NodeJS.Signals) => void) => unknown, off: (signal: string, handler: (signal: NodeJS.Signals) => void) => unknown }} SignalTarget
 * @typedef {{ kill: (signal?: NodeJS.Signals) => boolean, once: (event: string, handler: (...args: any[]) => void) => unknown }} ChildLike
 * @typedef {(bin: string, args: string[], options: object) => ChildLike} InteractiveSpawn
 * @typedef {{ code: number | null, signal: NodeJS.Signals | null }} ExitStatus
 */

/** @param {AgentName} agent  dscc is Claude Code with another profile */
export const agentBin = (agent) => (agent === 'dscc' ? 'claude' : agent);

/**
 * The executable for an agent as an argv prefix: the one on PATH, else the
 * home's tools registry entry (e.g. `npx -y @deepseek-ai/dsh`), else null.
 *
 * @param {{ agent: AgentName, home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, canRun?: (file: string) => boolean, registry?: (home: string, name: string) => string[] | null }} input
 * @returns {string[] | null}
 */
export function findAgentCommand({
  agent,
  home,
  env,
  platform,
  canRun = isExecutable,
  registry = commandFor,
}) {
  const bin = agentBin(agent);
  const found = which(bin, { env, platform, isExecutable: canRun });
  if (found) return [found];
  try {
    const recorded = registry(home, bin);
    return recorded?.length ? recorded : null;
  } catch {
    // An unreadable tools/local.json is the same as no entry.
    return null;
  }
}

/**
 * How to install an agent's executable on this platform.
 *
 * @param {AgentName} agent
 * @param {string} home
 * @param {NodeJS.Platform} platform
 */
export function agentInstallHint(agent, home, platform) {
  const bin = agentBin(agent);
  try {
    const entry = loadCatalog(home).find((tool) => tool.name === bin);
    const hint = installHint(entry, platform);
    if (hint) return hint;
  } catch {
    // No readable catalog in this home: fall through to the generic hint.
  }
  return `install ${bin} and make sure it is on PATH (kyoten doctor lists what is missing)`;
}

/**
 * The full argv for an agent. `command` is the executable prefix from
 * `findAgentCommand`; `defaults` are the config's arguments for this agent,
 * placed before the user's.
 *
 * @param {{ agent: AgentName, command: string[], args: string[], defaults?: string[] }} input
 * @returns {string[]}
 */
export function buildArgv({ agent, command, args, defaults = [] }) {
  if (agent !== 'dsh') return [...command, ...defaults, ...args];
  // dsh takes the profile as its first word: `dsh web`, `dsh tui`.
  const named = args.length > 0 && !args[0].startsWith('-');
  const profile = named ? args[0] : DSH_DEFAULT_PROFILE;
  const rest = named ? args.slice(1) : args;
  return [...command, profile, '--patch', DSH_PATCH, ...defaults, ...rest];
}

/**
 * The agent's environment: the caller's, without the harness session ids (a
 * kyoten started inside an agent session must not act as that session in
 * `pnpm task`) and without `drop`, plus `KYOTEN_HOME`, `KYOTEN_CALLER_DIR`,
 * and `set`. Windows env names are case-insensitive, so they are matched that
 * way there.
 *
 * @param {{ env: NodeJS.ProcessEnv, home: string, cwd: string, platform: NodeJS.Platform, drop?: string[], set?: Record<string, string> }} input
 * @returns {Record<string, string>}
 */
export function buildEnv({ env, home, cwd, platform, drop = [], set = {} }) {
  /** @param {string} name */
  const fold = (name) => (platform === 'win32' ? name.toUpperCase() : name);
  /** @type {Record<string, string>} */
  const out = {};
  const removed = new Set([...HARNESS_SESSION_VARS, ...drop].map(fold));
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !removed.has(fold(name))) out[name] = value;
  }
  const added = { KYOTEN_HOME: home, KYOTEN_CALLER_DIR: cwd, ...set };
  for (const [name, value] of Object.entries(added)) {
    for (const existing of Object.keys(out)) {
      if (fold(existing) === fold(name)) delete out[existing];
    }
    out[name] = value;
  }
  return out;
}

/**
 * Run `argv` in `cwd` with the terminal (stdio inherited) and wait for it.
 * While it runs, kyoten ignores Ctrl-C (SIGINT, and SIGQUIT on POSIX), which
 * the terminal already delivers to the agent, and forwards SIGTERM and SIGHUP
 * to it.
 *
 * @param {{ argv: string[], cwd: string, env: Record<string, string>, platform: NodeJS.Platform, spawn?: InteractiveSpawn, signals?: SignalTarget }} input
 * @returns {Promise<ExitStatus>}
 */
export function spawnInteractive({
  argv,
  cwd,
  env,
  platform,
  spawn = /** @type {InteractiveSpawn} */ (/** @type {unknown} */ (nodeSpawn)),
  signals = process,
}) {
  const [bin, ...args] = argv;
  // Throws for an argument a Windows .cmd shim cannot take safely.
  const resolved = resolveCommand(bin, args, { env, platform });
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.bin, resolved.args, {
      cwd,
      env,
      stdio: 'inherit',
      ...resolved.options,
    });
    const ignore = () => {};
    /** @param {NodeJS.Signals} signal */
    const forward = (signal) => {
      child.kill(signal);
    };
    /** @type {[string, (signal: NodeJS.Signals) => void][]} */
    const handlers = [
      ['SIGINT', ignore],
      ['SIGTERM', forward],
      ['SIGHUP', forward],
    ];
    if (platform !== 'win32') handlers.push(['SIGQUIT', ignore]);
    for (const [signal, handler] of handlers) signals.on(signal, handler);
    const release = () => {
      for (const [signal, handler] of handlers) signals.off(signal, handler);
    };
    child.once('error', (/** @type {NodeJS.ErrnoException} */ error) => {
      release();
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `${bin} could not be started (not found).\nFix: kyoten doctor`
            )
          : error
      );
    });
    child.once(
      'exit',
      (
        /** @type {number | null} */ code,
        /** @type {NodeJS.Signals | null} */ signal
      ) => {
        release();
        resolve({ code, signal });
      }
    );
  });
}

/**
 * kyoten's exit code for the agent's: the same code, or 128 + the signal
 * number when a signal stopped it (the shell convention), else 1.
 *
 * @param {ExitStatus} status
 */
export function exitCode({ code, signal }) {
  if (code !== null) return code;
  const number = signal ? os.constants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

/**
 * Check that an agent can start in `home` and return its argv.
 *
 * @param {{ agent: AgentName, args: string[], home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, defaults?: string[], canRun?: (file: string) => boolean, registry?: (home: string, name: string) => string[] | null }} input
 * @returns {string[]}
 */
export function prepareLaunch({
  agent,
  args,
  home,
  env,
  platform,
  defaults,
  canRun,
  registry,
}) {
  if (agent === 'dsh') {
    const problem = dshDirProblem(home, platform);
    if (problem) throw new Error(problem);
  }
  const command = findAgentCommand({
    agent,
    home,
    env,
    platform,
    canRun,
    registry,
  });
  if (!command) {
    throw new Error(
      `${agentBin(agent)} was not found (agent ${agent}).\nFix: ${agentInstallHint(agent, home, platform)}`
    );
  }
  return buildArgv({ agent, command, args, defaults });
}
