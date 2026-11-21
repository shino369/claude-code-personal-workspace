/**
 * One headless agent call for a memory job: extraction, consolidation, and
 * the persona compaction and audit. The agent runs read-only, with its tools
 * off where the CLI can turn them off, in an empty temporary folder (no
 * project instructions or hooks there), with EXTRACT_ENV set so memory hooks
 * stay silent and the session is never queued, and the inner loop off.
 */
import fs from 'fs';
import path from 'path';
import { DSH_PATCH, buildCommand } from '../loop/adapters.js';
import { INNER_LOOP_ENV } from '../task/loop.js';
import { commandFor } from '../tools/registry.js';
import { EXTRACT_ENV } from './queue.js';

export const AGENT_CALL_TIMEOUT_MS = 5 * 60 * 1000;
/** The agents a memory job can call. */
export const CALL_AGENTS = /** @type {const} */ (['claude', 'codex', 'dsh']);
const ERROR_TAIL = 300;
/**
 * @typedef {typeof CALL_AGENTS[number]} CallAgent
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   runAgent: typeof import('../loop/adapters.js').runAgent,
 *   tmpdir: () => string,
 * }} CallDeps
 */

/**
 * The headless command for a memory job: read-only, no tools, and the model
 * when one is given.
 *
 * @param {{ agent: string, model?: string | null, rootDir: string }} input
 * @returns {import('../loop/adapters.js').AgentCommand}
 */
export function headlessCommand({ agent, model = null, rootDir }) {
  if (!CALL_AGENTS.includes(/** @type {CallAgent} */ (agent))) {
    throw new Error(
      `Memory jobs run on ${CALL_AGENTS.join(', ')} (got ${agent}).\nFix: use --agent ${CALL_AGENTS.join('|')}`
    );
  }
  const command = buildCommand({
    agent,
    argv: commandFor(rootDir, agent),
    mode: 'read',
  });
  // Codex starts outside a checkout. DSH must not load the workspace patch.
  const args = [...command.args];
  switch (command.agent) {
    case 'claude':
      args.push('--tools', '');
      break;
    case 'codex':
      args.splice(-1, 0, '--skip-git-repo-check');
      break;
    case 'dsh':
      args.splice(args.lastIndexOf(DSH_PATCH) - 1, 2);
      break;
  }
  return {
    ...command,
    args: [...args, ...(model ? ['--model', model] : [])],
  };
}

/**
 * One call in an empty folder, removed afterwards. Throws when the agent
 * fails, naming the job ("the extraction agent exited with code 1: …").
 *
 * @param {CallDeps} deps
 * @param {import('../loop/adapters.js').AgentCommand} command
 * @param {string} prompt
 * @param {{ job?: string, timeoutMs?: number }} [options]
 */
export function callAgent(
  deps,
  command,
  prompt,
  { job = 'extraction', timeoutMs = AGENT_CALL_TIMEOUT_MS } = {}
) {
  const cwd = fs.mkdtempSync(path.join(deps.tmpdir(), `memory-${job}-`));
  let result;
  try {
    result = deps.runAgent({
      command,
      cwd,
      prompt,
      timeoutMs,
      env: { ...deps.env, [EXTRACT_ENV]: '1', [INNER_LOOP_ENV]: 'off' },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (result.code !== 0) {
    const how = result.signal
      ? `was stopped by ${result.signal}`
      : `exited with code ${result.code}`;
    throw new Error(
      `the ${job} agent ${how}: ${result.output.trim().slice(-ERROR_TAIL)}`
    );
  }
  return result;
}

/**
 * The first JSON object in an agent's answer (models often wrap it in
 * prose or a code fence), or null.
 *
 * @param {string} answer
 * @returns {Record<string, unknown> | null}
 */
export function jsonObjectOf(answer) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }
}
