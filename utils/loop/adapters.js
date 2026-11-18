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

export const AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh']);

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
        '-',
      ],
      read: [
        '--profile',
        'headless',
        '--permission-mode',
        'read-only',
        '--approval-policy',
        'never',
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
 * Run one headless agent turn with the prompt on stdin.
 *
 * @param {{ command: AgentCommand, cwd: string, prompt: string, timeoutMs: number, env: NodeJS.ProcessEnv, spawn?: AgentSpawn, now?: () => number }} options
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
}) {
  const started = now();
  const result = spawn(command.bin, command.args, {
    cwd,
    input: prompt,
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024 * 1024,
    env,
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
