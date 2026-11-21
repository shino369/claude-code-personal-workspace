/**
 * Headless harness adapters for `pnpm loop`. Each adapter is a fixed argument
 * array; the prompt always goes on stdin and nothing runs through a shell, so
 * task text can never become a command.
 *
 * Two modes. `write` (the default, used by `pnpm loop`) configures agents
 * for work in a worktree:
 * - claude: `acceptEdits` auto-approves file edits; Bash still follows the
 *   project allow/deny lists (anything else is denied in -p mode).
 * - codex: the `workspace-write` sandbox.
 * - dsh: the `workspace-write` preset with `--approval-policy never`
 *   (headless has no approval channel; calls that need one are rejected).
 * - agy: `stream-json` I/O with `--mode accept-edits` and `--settings`
 *   containing worktree command grants and deny rules.
 * `read` (the default for `pnpm agent ask`) selects claude `plan` mode,
 * codex `read-only` sandbox, dsh `read-only` preset, or agy `--settings`
 * with `write_file(*)` and protected-path deny rules and inspection grants.
 */
import { crossSpawn } from '../spawn.js';
import { HARNESS_SESSION_VARS } from '../task/store.js';

export const AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh', 'agy']);
/** Argument characters that cannot chain, redirect, or run subshells/PowerShell `(expr)`. */
const AGY_SAFE_ARGS = '[^;&|<>`$()\\r\\n]*';
/**
 * Safe tokens for commands whose quoted arguments legitimately contain `(...)`
 * (e.g. `git commit -m "feat(agy): ..."` or `pnpm task ... -m "..."`):
 * forbids `\`, `$`, `` ` `` inside quotes and `(` / `)` outside quotes.
 */
const AGY_QUOTED_SAFE =
  '("[^;&|<>`$\\\\\\r\\n"]*"|\'[^;&|<>`$\\r\\n\']*\'|[^;&|<>`$()\\r\\n\\s"\']+)';
/** Relative JS path inside repo dirs with no `..` traversal or shell meta. */
const AGY_SCRIPT_PATH =
  '[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*(\\.[A-Za-z0-9_-]+)*\\.m?js';
/** Relative path that cannot start with `-`, `/`, `~`, drive, or contain `..`. */
const AGY_REL_PATH =
  '\\.?[A-Za-z0-9_][A-Za-z0-9_-]*(/\\.?[A-Za-z0-9_][A-Za-z0-9_-]*)*(\\.[A-Za-z0-9_-]+)*';
/**
 * Antigravity `read_file(...)` matches exact paths and directory prefixes (not
 * globs); denying `read_file` also blocks `write_file` on those paths.
 */
const AGY_SECRET_DENY = [
  'read_file(.env)',
  'read_file(.env.local)',
  'read_file(.env.development)',
  'read_file(.env.production)',
  'read_file(.env.test)',
  'read_file(.env.staging)',
  'read_file(secrets/)',
  'read_file(credentials.json)',
  'read_file(~/.ssh)',
  'read_file(~/.aws)',
];
/** Antigravity headless write-mode settings and command grants. */
export const AGY_WRITE_SETTINGS = JSON.stringify({
  permissions: {
    allow: [
      `command(regex:^pnpm (check|test|test:coverage|test:e2e|lint|lint:fix|typecheck|format|format:check|docs:cli|skills:check|skills:link|harness|workspace:check|tools|install|add|remove)( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^pnpm task( ${AGY_QUOTED_SAFE})*$)`,
      `command(regex:^git (status|diff|log|show|branch|rev-parse|add|switch|checkout)( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^git commit( ${AGY_QUOTED_SAFE})*$)`,
      `command(regex:^node (utils|\\.claude/hooks|\\.agents/skills)/${AGY_SCRIPT_PATH}( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^(ls|dir|cd|echo)( ${AGY_SAFE_ARGS})?$)`,
      `command(regex:^mkdir( -p)?( ${AGY_REL_PATH})+$)`,
      'command(pwd)',
    ],
    deny: [
      ...AGY_SECRET_DENY,
      'write_file(.git/)',
      'command(regex:^node utils/(?i:workspace-setup|memory/cli)\\.js( |$))',
      'command(regex:^pnpm\\b.*(\\s-[a-zA-Z]*[gC]|--global\\b|--dir\\b|--workspace-root\\b).*)',
      'command(regex:^git branch\\b.*(\\s-[a-zA-Z]*[dD]|--delete).*)',
      'command(regex:^git commit\\b.*(--no-verify|\\s-[a-zA-Z]*n[a-zA-Z]*\\b).*)',
      'command(regex:^git add\\b.*(\\s-[a-zA-Z]*f[a-zA-Z]*\\b|--force).*)',
      'command(regex:^git .*(--output|--ext-diff|--textconv|--no-index).*)',
    ],
  },
});
/** Antigravity headless read-mode settings. Checkout scripts run in write mode. */
export const AGY_READ_SETTINGS = JSON.stringify({
  permissions: {
    allow: [
      `command(regex:^git (status|diff|log|show|rev-parse)( ${AGY_SAFE_ARGS})?$)`,
      'command(regex:^git branch( (--show-current|--list|-a|-r|-v|--all|--remotes))?$)',
      `command(regex:^(ls|dir)( ${AGY_SAFE_ARGS})?$)`,
      'command(pwd)',
      'command(regex:^node (-v|--version)$)',
    ],
    deny: [
      'write_file(*)',
      ...AGY_SECRET_DENY,
      'command(regex:.*(--output|--fix|--write|--update|--no-index|--ext-diff|--textconv|\\s-[oO]|\\s-[wWu]\\b).*)',
    ],
  },
});
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
  agy: {
    bin: 'agy',
    args: {
      write: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--mode',
        'accept-edits',
        '--settings',
        AGY_WRITE_SETTINGS,
      ],
      read: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--settings',
        AGY_READ_SETTINGS,
      ],
    },
    install:
      'https://antigravity.google/docs/cli/reference (then: agy --version)',
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
 * Parse Antigravity's `--output-format stream-json` NDJSON output: extract the
 * final `result` event's `response` as `stdout`, and flag a non-SUCCESS status
 * or an empty response caused by auto-denied headless tool actions.
 *
 * @param {string} raw
 * @returns {{ stdout: string, failed: boolean }}
 */
export function parseAgyStreamJson(raw) {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed?.event === 'result' &&
      typeof parsed.result === 'object' &&
      parsed.result !== null
    ) {
      const response =
        typeof parsed.result.response === 'string'
          ? parsed.result.response
          : '';
      const denied =
        Array.isArray(parsed.result.denied_actions) &&
        parsed.result.denied_actions.length > 0;
      const failed =
        parsed.result.status !== 'SUCCESS' || (!response && denied);
      return { stdout: response, failed };
    }
  }
  return { stdout: raw, failed: false };
}

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
  const input =
    command.agent === 'agy'
      ? `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`
      : prompt;
  const started = now();
  const result = spawn(command.bin, command.args, {
    cwd,
    input,
    encoding: 'utf-8',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 64 * 1024 * 1024,
    // A detached caller (the memory worker, queue.js) has no console, so
    // Windows would give every headless child a new, visible console window.
    windowsHide: true,
    env: Object.fromEntries(
      Object.entries(env).filter(([key]) => !HARNESS_SESSION_VARS.includes(key))
    ),
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      `${command.bin} was not found (agent ${command.agent}).\nFix: ${installHint(command.agent)}`
    );
  }
  const rawStdout = String(result.stdout ?? '');
  const parsed = command.agent === 'agy' ? parseAgyStreamJson(rawStdout) : null;
  const code = parsed?.failed && result.status === 0 ? 1 : result.status;
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .map(String)
    .join('\n');
  return {
    code,
    signal: result.signal ?? null,
    output: result.signal
      ? `${output}\n(stopped by ${result.signal}; timeout ${Math.round(timeoutMs / 1000)}s)`
      : output,
    stdout: parsed ? parsed.stdout : rawStdout,
    durationMs: now() - started,
  };
}
