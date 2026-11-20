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
import readline from 'readline/promises';
import { runIfMain } from '../module-runner.js';
import { crossSpawn } from '../spawn.js';
import { ROOT_DIR } from '../workspace-config.js';
import {
  dsccEnv,
  profilePath,
  readFirstLine,
  readHidden,
  setKey,
  showProfile,
} from './dscc.js';
import { formatCheck, runChecks, workspaceCheck } from './doctor.js';
import {
  AGENTS,
  configFile,
  expandHome,
  homeState,
  readConfig,
  readHomeInfo,
  resolveHome,
  writeConfig,
} from './home.js';
import { initHome } from './init.js';
import {
  buildEnv,
  exitCode,
  prepareLaunch,
  spawnInteractive,
} from './launch.js';
import { compareVersions } from './repo.js';
import { snapshotSource } from './snapshot.js';
import { updateHome } from './update.js';

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
 *   run: import('../spawn.js').Spawn,
 *   ask: (question: string) => Promise<string>,
 *   root: string,
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
  init [<dir>] [--no-setup]
            Create a home (default ~/.kyoten) and install it; with <dir>,
            also make it the default home (an existing kyoten workspace
            is kept as it is). --no-setup: skip pnpm install and setup
  update [--no-setup]
            Merge a newer kyoten snapshot into a home kyoten created
  doctor    Check prerequisites, agents, and the home
  where     Print the home (the rule that chose it goes to stderr)
  help      This help
  version   kyoten's version

dscc profile (DeepSeek API key and model mapping)
  kyoten dscc --set-key   Save the key (hidden prompt, or one line on stdin)
  kyoten dscc --show      Print the profile, the key masked

The home is the first of: --home, $KYOTEN_HOME, the clone kyoten runs from
(pnpm kyoten inside it), "home" in the config, ~/.kyoten.
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
 * Options of `kyoten init` and `kyoten update`.
 *
 * @param {CommandName} command
 * @param {string[]} args
 * @returns {{ dir?: string, setup: boolean }}
 */
export function parseCommandArgs(command, args) {
  const usage =
    command === 'init'
      ? 'kyoten init [<dir>] [--no-setup]'
      : `kyoten ${command}${command === 'update' ? ' [--no-setup]' : ''}`;
  /** @type {{ dir?: string, setup: boolean }} */
  const options = { setup: true };
  for (const arg of args) {
    if (arg === '--no-setup' && command !== 'doctor') {
      options.setup = false;
    } else if (
      command === 'init' &&
      !arg.startsWith('-') &&
      options.dir === undefined
    ) {
      options.dir = arg;
    } else {
      throw new Error(
        `unexpected argument for kyoten ${command}: ${arg}\nFix: ${usage}`
      );
    }
  }
  return options;
}

/**
 * @typedef {{ deps: KyotenDeps, version: string, configPath: string, config: import('./home.js').KyotenConfig, home: import('./home.js').ResolvedHome }} Context
 */

/**
 * @param {Context} ctx
 * @param {string} dir
 * @param {boolean} setup
 */
function createHome(ctx, dir, setup) {
  const { deps, version } = ctx;
  initHome({
    home: dir,
    source: snapshotSource({
      root: deps.root,
      version,
      run: deps.run,
    }),
    log: (text) => deps.err(`kyoten: ${text}`),
    setup,
    run: deps.run,
    env: deps.env,
  });
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandInit(ctx, args) {
  const { deps, configPath, config, home } = ctx;
  const { dir, setup } = parseCommandArgs('init', args);
  const target = dir
    ? path.resolve(deps.cwd, expandHome(dir, deps.homedir))
    : home.dir;
  createHome(ctx, target, setup);
  if (dir) {
    writeConfig(configPath, { ...config, home: target });
    deps.err(`kyoten: ${target} is now the default home (${configPath})`);
  }
  deps.err('kyoten: start an agent with: kyoten [claude|codex|dsh|dscc]');
  return 0;
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandUpdate(ctx, args) {
  const { deps, version, home } = ctx;
  const { setup } = parseCommandArgs('update', args);
  updateHome({
    home: home.dir,
    source: snapshotSource({
      root: deps.root,
      version,
      run: deps.run,
    }),
    log: (text) => deps.err(`kyoten: ${text}`),
    setup,
    run: deps.run,
    env: deps.env,
  });
  return 0;
}

/**
 * @param {Context} ctx
 * @param {string[]} args
 */
function commandDoctor(ctx, args) {
  const { deps, version, home } = ctx;
  parseCommandArgs('doctor', args);
  const checks = runChecks({
    home: home.dir,
    homeSource: home.source,
    version,
    profile: profilePath(deps),
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir,
    run: deps.run,
    canRun: deps.canRun,
    registry: deps.registry,
  });
  for (const check of checks) deps.out(formatCheck(check));
  if (homeState(home.dir) === 'workspace') {
    const check = workspaceCheck({
      home: home.dir,
      run: deps.run,
      env: deps.env,
    });
    checks.push(check);
    deps.out(formatCheck(check));
  }
  const failed = checks.filter((check) => check.status === 'fail').length;
  deps.out(
    failed
      ? `${failed} problem(s) need a fix (see the Fix lines).`
      : 'kyoten is ready.'
  );
  return failed ? 1 : 0;
}

/**
 * Make sure the home exists before a launch: in a terminal, offer to create
 * it ([Y/n]); otherwise explain `kyoten init`.
 *
 * @param {Context} ctx
 * @returns {Promise<boolean>}  false when the user declined
 */
async function ensureHome(ctx) {
  const { deps, home } = ctx;
  const state = homeState(home.dir);
  if (state === 'workspace') return true;
  if (state === 'other') {
    throw new Error(
      `${home.dir} (${home.source}) is not a kyoten workspace.\nFix: kyoten --home <dir> …, or kyoten init <new dir>`
    );
  }
  if (!deps.stdin.isTTY) {
    throw new Error(`no kyoten home at ${home.dir} yet.\nFix: kyoten init`);
  }
  const answer = await deps.ask(
    `kyoten: no kyoten home at ${home.dir} yet. Create it now? [Y/n] `
  );
  if (!/^(y|yes)?$/i.test(answer.trim())) {
    deps.err('kyoten: nothing created; run kyoten init when you are ready');
    return false;
  }
  createHome(ctx, home.dir, true);
  return true;
}

/**
 * The version hint for a home kyoten created.
 *
 * @param {Context} ctx
 */
function versionHint(ctx) {
  const { deps, version, home } = ctx;
  const info = readHomeInfo(home.dir);
  const order = info ? compareVersions(version, info.version) : 0;
  if (info && order > 0) {
    deps.err(
      `kyoten: kyoten ${version} is available for this home (it has ${info.version}): kyoten update`
    );
  } else if (info && order < 0) {
    deps.err(
      `kyoten: this home has kyoten ${info.version}, newer than this kyoten ${version}: npx kyoten@latest`
    );
  }
}

/**
 * @param {Context} ctx
 * @param {AgentName} agent
 * @param {string[]} args
 * @returns {Promise<number>}
 */
async function launch(ctx, agent, args) {
  const { deps, config, home } = ctx;
  if (!(await ensureHome(ctx))) return 1;
  versionHint(ctx);
  const profile = agent === 'dscc' ? dsccEnv(profilePath(deps)) : null;
  for (const warning of profile?.warnings ?? [])
    deps.err(`kyoten: dscc profile ${warning}`);
  const argv = prepareLaunch({
    agent,
    args,
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
 * @param {KyotenArgs} parsed
 * @param {KyotenDeps} deps
 * @returns {Promise<number>}
 */
async function run(parsed, deps) {
  const version = packageVersion(deps.root);
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
  /** @type {Context} */
  const ctx = { deps, version, configPath, config, home };
  switch (parsed.command) {
    case 'where':
      deps.out(home.dir);
      deps.err(`kyoten: chosen by ${home.source}`);
      return 0;
    case 'init':
      return commandInit(ctx, parsed.args);
    case 'update':
      return commandUpdate(ctx, parsed.args);
    case 'doctor':
      return commandDoctor(ctx, parsed.args);
    default:
      return launch(ctx, /** @type {AgentName} */ (parsed.agent), parsed.args);
  }
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
    run: crossSpawn(),
    root: ROOT_DIR,
    ask: (question) =>
      askLine({ input: process.stdin, output: process.stderr, question }),
  };
}

/**
 * One answer from `input`; the terminal echoes it (no raw mode).
 *
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string }} io
 */
export async function askLine({ input, output, question }) {
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/* c8 ignore next 3 - CLI entry point; main() is tested directly */
runIfMain(import.meta.url, async () => {
  process.exit(await main(process.argv.slice(2)));
});
