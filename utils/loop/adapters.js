/**
 * Headless harness adapters for `pnpm loop`. Each adapter is a fixed argument
 * array; the prompt always goes on stdin and nothing runs through a shell, so
 * task text can never become a command.
 *
 * Two modes. `write` (the default, used by `pnpm loop`) keeps unattended runs
 * inside the worktree:
 * - claude: `acceptEdits` auto-approves file edits; Bash still follows the
 *   project allow/deny lists (anything else is denied in -p mode).
 * - codex: the `workspace-write` sandbox.
 * - dsh: the `workspace-write` preset with `--approval-policy never`
 *   (headless has no approval channel; calls that need one are rejected).
 * `read` (the default for `pnpm agent ask`) cannot change files: claude `plan`
 * mode, codex `read-only` sandbox, dsh `read-only` preset.
 */
import { crossSpawn } from '../spawn.js';
import { HARNESS_SESSION_VARS } from '../task/store.js';

export const AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh']);
/** The DSH overlay that enables the workspace's hooks (utils/harness/cli.js). */
export const DSH_PATCH = '.dsh/workspace.patch.yml';
/**
 * How to install DSH's Claude hooks bridge into a profile: with the two
 * peers it imports and the profile lacks, at the version `dsh --version`
 * prints (`latest` lags behind the runtime).
 */
export const DSH_BRIDGE_INSTALL =
  'dsh plugin --profile <profile> add @deepseek-ai/dsh-hooks-claude-code@<version> @deepseek-ai/dsh-hook-protocol@<version> @deepseek-ai/dsh-llm@<version>';

/**
 * Why DSH cannot run the workspace's hooks from `dir`, or null. The bridge
 * writes the launch dir into `node "<dir>/<script>"` (utils/harness/hooks.js),
 * where bash and pwsh read `$` and a backtick, `"` ends the path, and bash
 * also reads `\`. The hook would not run (DSH hooks fail open, so the guard
 * would be off) or would run part of the path.
 *
 * @param {string} dir
 * @param {string} [platform]
 * @returns {string | null}
 */
export function dshDirProblem(dir, platform = process.platform) {
  const unsafe = platform === 'win32' ? /[$`"\n]/ : /[$`"\\\n]/;
  if (!unsafe.test(dir)) return null;
  return `DSH cannot run this workspace's hooks from ${dir}: the hook commands carry the path, and the shell reads its ${platform === 'win32' ? '$, `, or "' : '$, `, ", or \\'} as syntax, so the guard would not run.\nFix: move the checkout to a path without them`;
}

/** @typedef {typeof AGENTS[number]} AgentName */

export const MODES = /** @type {const} */ (['write', 'read']);

/** @typedef {typeof MODES[number]} Mode */

/** @type {Record<AgentName, { bin: string, args: Record<Mode, string[]>, install: string }>} */
const ADAPTERS = {
  claude: {
    bin: 'claude',
    args: {
      write: [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
      read: [
        '-p',
        '--permission-mode',
        'plan',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
    },
    install: 'https://code.claude.com/docs (then: claude --version)',
  },
  codex: {
    bin: 'codex',
    args: {
      write: ['exec', '--sandbox', 'workspace-write', '--ephemeral', '-'],
      read: ['exec', '--sandbox', 'read-only', '--ephemeral', '-'],
    },
    install: 'install the Codex CLI (see its docs), or pass --bin <path>',
  },
  dsh: {
    bin: 'dsh',
    args: {
      write: [
        '--profile',
        'headless',
        '--permission-mode',
        'workspace-write',
        '--approval-policy',
        'never',
        // The workspace's hooks through the Claude hooks bridge (pnpm harness
        // sync writes it; relative to the cwd, as DSH resolves it).
        '--patch',
        DSH_PATCH,
        '-',
      ],
      read: [
        '--profile',
        'headless',
        '--permission-mode',
        'read-only',
        '--approval-policy',
        'never',
        // The workspace's hooks through the Claude hooks bridge (pnpm harness
        // sync writes it; relative to the cwd, as DSH resolves it).
        '--patch',
        DSH_PATCH,
        '-',
      ],
    },
    install: 'pass --bin "npx -y @deepseek-ai/dsh" (Node ^22.19 or >=24)',
  },
};

/**
 * @typedef {{ agent: AgentName, bin: string, args: string[] }} AgentCommand
 */

/**
 * Build the command for one harness.
 *
 * Executable precedence: `bin` (the `--bin` flag, split on whitespace with no
 * shell, so `npx -y @deepseek-ai/dsh` works) > `argv` (an argv prefix from the
 * tool registry, kept as-is so paths with spaces survive) > the default.
 *
 * @param {{ agent: string, bin?: string, argv?: string[] | null, mode?: string, maxBudgetUsd?: number }} options
 * @returns {AgentCommand}
 */
export function buildCommand({
  agent,
  bin,
  argv,
  mode = 'write',
  maxBudgetUsd,
}) {
  if (!AGENTS.includes(/** @type {AgentName} */ (agent))) {
    throw new Error(
      `Unknown agent "${agent}".\nFix: use --agent ${AGENTS.join('|')}`
    );
  }
  if (!MODES.includes(/** @type {Mode} */ (mode))) {
    throw new Error(
      `Unknown mode "${mode}".\nFix: use mode ${MODES.join(' or ')}`
    );
  }
  const name = /** @type {AgentName} */ (agent);
  const adapter = ADAPTERS[name];
  const [exe, ...prefix] = bin?.trim()
    ? bin.trim().split(/\s+/)
    : argv && argv.length > 0
      ? argv
      : [adapter.bin];
  const args = [...prefix, ...adapter.args[/** @type {Mode} */ (mode)]];
  if (maxBudgetUsd !== undefined) {
    if (name !== 'claude') {
      throw new Error(
        `--max-budget-usd is only supported by --agent claude.\nFix: drop --max-budget-usd for ${name}`
      );
    }
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }
  return { agent: name, bin: exe, args };
}

/**
 * Install hint for a harness whose executable was not found.
 *
 * @param {AgentName} agent
 * @returns {string}
 */
export function installHint(agent) {
  return ADAPTERS[agent].install;
}

/**
 * @typedef {(bin: string, args: string[], options: object) => { status: number | null, signal?: string | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null, error?: Error & { code?: string } }} AgentSpawn
 * @typedef {{ code: number | null, signal: string | null, output: string, stdout: string, durationMs: number }} AgentResult
 *   `output` is everything (stdout, stderr, spawn errors, a timeout note);
 *   `stdout` alone is the final answer for harnesses that log progress to
 *   stderr (codex exec, dsh headless).
 */

/**
 * Run one headless agent turn with the prompt on stdin. The child gets the
 * caller's env without the harness session ids: a child that inherited them
 * would act as the caller's session in `pnpm task` (`TASK_SESSION`, set on
 * purpose, is kept).
 *
 * @param {{ command: AgentCommand, cwd: string, prompt: string, timeoutMs: number, env: NodeJS.ProcessEnv, spawn?: AgentSpawn, now?: () => number, platform?: string }} options
 *   DSH refuses a cwd its hook commands cannot carry (dshDirProblem)
 * @returns {AgentResult}
 */
export function runAgent({
  command,
  cwd,
  prompt,
  timeoutMs,
  env,
  // Resolves Windows .cmd shims (e.g. a pnpm-installed codex.cmd) safely.
  spawn = /** @type {AgentSpawn} */ (crossSpawn()),
  now = Date.now,
  platform = process.platform,
}) {
  if (command.agent === 'dsh') {
    const problem = dshDirProblem(cwd, platform);
    if (problem) throw new Error(problem);
  }
  const started = now();
  const result = spawn(command.bin, command.args, {
    cwd,
    input: prompt,
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024 * 1024,
    env: Object.fromEntries(
      Object.entries(env).filter(([key]) => !HARNESS_SESSION_VARS.includes(key))
    ),
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `${command.bin} was not found (agent ${command.agent}).\nFix: ${installHint(command.agent)}`
    );
  }
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .map(String)
    .join('\n');
  return {
    code: result.status,
    signal: result.signal ?? null,
    output: result.signal
      ? `${output}\n(stopped by ${result.signal}; timeout ${Math.round(timeoutMs / 1000)}s)`
      : output,
    stdout: String(result.stdout ?? ''),
    durationMs: now() - started,
  };
}
