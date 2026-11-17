/**
 * Headless harness adapters for `pnpm loop`. Each adapter is a fixed argument
 * array; the prompt always goes on stdin and nothing runs through a shell, so
 * task text can never become a command.
 *
 * Permission choices keep unattended runs inside the worktree:
 * - claude: `acceptEdits` auto-approves file edits; Bash still follows the
 *   project allow/deny lists (anything else is denied in -p mode).
 * - codex: the `workspace-write` sandbox.
 * - dsh: the `workspace-write` preset with `--approval-policy never`
 *   (headless has no approval channel; calls that need one are rejected).
 */
import { spawnSync } from 'child_process';

export const AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh']);

/** @typedef {typeof AGENTS[number]} AgentName */

/** @type {Record<AgentName, { bin: string, args: string[], install: string }>} */
const ADAPTERS = {
  claude: {
    bin: 'claude',
    args: [
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'text',
      '--no-session-persistence',
    ],
    install: 'https://code.claude.com/docs (then: claude --version)',
  },
  codex: {
    bin: 'codex',
    args: ['exec', '--sandbox', 'workspace-write', '--ephemeral', '-'],
    install: 'install the Codex CLI (see its docs), or pass --bin <path>',
  },
  dsh: {
    bin: 'dsh',
    args: [
      '--profile',
      'headless',
      '--permission-mode',
      'workspace-write',
      '--approval-policy',
      'never',
      '-',
    ],
    install: 'pass --bin "npx -y @deepseek-ai/dsh" (Node ^22.19 or >=24)',
  },
};

/**
 * @typedef {{ agent: AgentName, bin: string, args: string[] }} AgentCommand
 */

/**
 * Build the command for one harness.
 *
 * @param {{ agent: string, bin?: string, maxBudgetUsd?: number }} options
 *   `bin` replaces the executable; it is split on whitespace (no shell), so
 *   `npx -y @deepseek-ai/dsh` works.
 * @returns {AgentCommand}
 */
export function buildCommand({ agent, bin, maxBudgetUsd }) {
  if (!AGENTS.includes(/** @type {AgentName} */ (agent))) {
    throw new Error(
      `Unknown agent "${agent}".\nFix: use --agent ${AGENTS.join('|')}`
    );
  }
  const name = /** @type {AgentName} */ (agent);
  const adapter = ADAPTERS[name];
  const [exe, ...prefix] = bin?.trim()
    ? bin.trim().split(/\s+/)
    : [adapter.bin];
  const args = [...prefix, ...adapter.args];
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
 * @typedef {{ code: number | null, signal: string | null, output: string, durationMs: number }} AgentResult
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
  spawn = /** @type {AgentSpawn} */ (spawnSync),
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
    durationMs: now() - started,
  };
}
