#!/usr/bin/env node
/**
 * kyoten — start a coding agent in a kyoten workspace (the "home").
 *
 *   kyoten [--home <dir>] [<agent>] [agent args…]     agent: claude (default), codex, dsh, dscc
 *   kyoten [--home <dir>] <command> [options]         init, update, doctor, where, help, version
 *
 * Only the front of the command line is kyoten's: its options, then one word
 * that picks the agent or the command. Everything after that goes to the
 * agent unchanged. User guide: docs/kyoten.md.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runIfMain } from '../module-runner.js';
import { ROOT_DIR } from '../workspace-config.js';
import {
  dsccEnv,
  profilePath,
  readFirstLine,
  readHidden,
  setKey,
  showProfile,
} from './dscc.js';
import {
  AGENTS,
  configFile,
  homeState,
  readConfig,
  resolveHome,
} from './home.js';
import {
  buildEnv,
  exitCode,
  prepareLaunch,
  spawnInteractive,
} from './launch.js';

export const COMMANDS = /** @type {const} */ ([
  'init',
  'update',
  'doctor',
  'where',
  'help',
  'version',
]);

/**
 * @typedef {import('./home.js').AgentName} AgentName
 * @typedef {typeof COMMANDS[number]} CommandName
 * @typedef {{ home?: string, help: boolean, version: boolean, agent?: AgentName, command?: CommandName, args: string[] }} KyotenArgs
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   platform: NodeJS.Platform,
 *   homedir: string,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   stdin: import('./dscc.js').KeyInput & AsyncIterable<string | Buffer>,
 *   tty: import('./dscc.js').KeyOutput,
 *   spawn?: import('./launch.js').InteractiveSpawn,
 *   signals?: import('./launch.js').SignalTarget,
 *   canRun?: (file: string) => boolean,
 *   registry?: (home: string, name: string) => string[] | null,
 * }} KyotenDeps
 */

/**
 * @param {string[]} argv
 * @returns {KyotenArgs}
 */
export function parseArgs(argv) {
  /** @type {KyotenArgs} */
  const parsed = { help: false, version: false, args: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home' || arg.startsWith('--home=')) {
      const value =
        arg === '--home' ? argv[(i += 1)] : arg.slice('--home='.length);
      if (!value) {
        throw new Error(
          '--home needs a directory.\nFix: kyoten --home <dir> …'
        );
      }
      parsed.home = value;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--version') {
      parsed.version = true;
    } else {
      break;
    }
  }
  const word = argv[i];
  const name = word?.startsWith('--') ? word.slice(2) : word;
  if (AGENTS.includes(/** @type {AgentName} */ (name))) {
    parsed.agent = /** @type {AgentName} */ (name);
    parsed.args = argv.slice(i + 1);
  } else if (COMMANDS.includes(/** @type {CommandName} */ (word))) {
    parsed.command = /** @type {CommandName} */ (word);
    parsed.args = argv.slice(i + 1);
  } else {
    parsed.agent = 'claude';
    parsed.args = argv.slice(i);
  }
  return parsed;
}

/** @param {string} [root] */
export function packageVersion(root = ROOT_DIR) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf-8')
  );
  return String(pkg.version);
}

/**
 * @param {string} version
 * @param {string} config  the config file's path
 */
export function helpText(version, config) {
  return `kyoten ${version} — start a coding agent in your kyoten workspace (the home)

Usage
  kyoten [--home <dir>] [<agent>] [agent args…]
  kyoten [--home <dir>] <command> [options]

Agents (the first word, default claude; --<agent> works too)
  claude    Claude Code
  codex     OpenAI Codex CLI
  dsh       DeepSeek harness: dsh <profile> --patch .dsh/workspace.patch.yml
            (profile: the first argument if it is not an option; default web)
  dscc      Claude Code on the DeepSeek API

Everything after the agent goes to it unchanged; kyoten adds no permission
flags. To give Claude a word that is a kyoten command: kyoten claude <word>

Commands
  init [<dir>] [--no-setup] [--yes]
            Create a home (or register an existing kyoten workspace as the
            default home when <dir> is given)
  update    Merge a newer kyoten snapshot into a home kyoten created
  doctor    Check prerequisites, agents, and the home
  where     Print the home (the rule that chose it goes to stderr)
  help      This help
  version   kyoten's version

dscc profile (DeepSeek API key and model mapping)
  kyoten dscc --set-key   Save the key (hidden prompt, or one line on stdin)
  kyoten dscc --show      Print the profile, the key masked

The home is the first of: --home, $KYOTEN_HOME, a kyoten workspace containing
the current directory, "home" in the config, ~/.kyoten.
Config: ${config}
  {"home": "/abs/path", "args": {"dscc": ["--dangerously-skip-permissions"]}}`;
}

/**
 * `kyoten dscc --set-key` / `--show`.
 *
 * @param {string} flag
 * @param {KyotenDeps} deps
 * @returns {Promise<number>}
 */
async function dsccProfileCommand(flag, deps) {
  const file = profilePath(deps);
  if (flag === '--show') {
    for (const line of showProfile(file)) deps.out(line);
    return 0;
  }
  const key = deps.stdin.isTTY
    ? await readHidden({
        input: deps.stdin,
        output: deps.tty,
        prompt: 'DeepSeek API key (hidden): ',
      })
    : await readFirstLine(deps.stdin);
  const { created } = setKey({ file, key });
  deps.err(`kyoten: key saved to ${file}${created ? ' (new profile)' : ''}`);
  return 0;
}

/**
 * @param {KyotenArgs} parsed
 * @param {KyotenDeps} deps
 * @returns {Promise<number>}
 */
async function run(parsed, deps) {
  const version = packageVersion();
  const configPath = configFile(deps);
  if (parsed.help || parsed.command === 'help') {
    deps.out(helpText(version, configPath));
    return 0;
  }
  if (parsed.version || parsed.command === 'version') {
    deps.out(version);
    return 0;
  }
  const flag = parsed.args[0];
  if (parsed.agent === 'dscc' && (flag === '--set-key' || flag === '--show')) {
    return dsccProfileCommand(flag, deps);
  }
  const config = readConfig(configPath);
  const home = resolveHome({ ...deps, flag: parsed.home, config, configPath });
  if (parsed.command === 'where') {
    deps.out(home.dir);
    deps.err(`kyoten: chosen by ${home.source}`);
    return 0;
  }
  if (parsed.command) {
    throw new Error(`kyoten ${parsed.command} is not available yet.`);
  }
  const agent = /** @type {AgentName} */ (parsed.agent);
  if (homeState(home.dir) !== 'workspace') {
    throw new Error(`no kyoten home at ${home.dir}.\nFix: kyoten init`);
  }
  const profile = agent === 'dscc' ? dsccEnv(profilePath(deps)) : null;
  for (const warning of profile?.warnings ?? [])
    deps.err(`kyoten: dscc profile ${warning}`);
  const argv = prepareLaunch({
    agent,
    args: parsed.args,
    home: home.dir,
    env: deps.env,
    platform: deps.platform,
    defaults: config.args?.[agent],
    canRun: deps.canRun,
    registry: deps.registry,
  });
  deps.err(`kyoten: ${agent} in ${home.dir} (${home.source})`);
  const status = await spawnInteractive({
    argv,
    cwd: home.dir,
    env: buildEnv({
      env: deps.env,
      home: home.dir,
      cwd: deps.cwd,
      platform: deps.platform,
      drop: profile?.drop,
      set: profile?.set,
    }),
    platform: deps.platform,
    spawn: deps.spawn,
    signals: deps.signals,
  });
  return exitCode(status);
}

/**
 * @param {string[]} argv
 * @param {KyotenDeps} [deps]
 * @returns {Promise<number>}  the exit code
 */
export async function main(argv, deps = defaultDeps()) {
  try {
    return await run(parseArgs(argv), deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split('\n')) deps.err(`kyoten: ${line}`);
    return 1;
  }
}

/** @returns {KyotenDeps} */
export function defaultDeps() {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    homedir: os.homedir(),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    stdin: /** @type {KyotenDeps['stdin']} */ (
      /** @type {unknown} */ (process.stdin)
    ),
    tty: process.stderr,
  };
}

/* c8 ignore next 3 - CLI entry point; main() is tested directly */
runIfMain(import.meta.url, async () => {
  process.exit(await main(process.argv.slice(2)));
});
