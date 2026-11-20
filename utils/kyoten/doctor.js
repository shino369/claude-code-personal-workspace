/**
 * `kyoten doctor`: what kyoten needs, what each agent needs, and the state
 * of the home, in the `✓ / ! / ✗` format of `pnpm workspace:setup`, each
 * problem with a Fix line. Ends with `pnpm workspace:check` in the home.
 */
import fs from 'fs';
import path from 'path';
import {
  dshDirProblem,
  DSH_BRIDGE_INSTALL,
  DSH_PATCH,
} from '../loop/adapters.js';
import { codexTrustsProject } from '../harness/codex-trust.js';
import { crossSpawn } from '../spawn.js';
import { readIfExists } from '../task/store.js';
import { mask, parseProfile, tokenUnset, TOKEN_KEY } from './dscc.js';
import { homeState, readHomeInfo } from './home.js';
import { agentInstallHint, findAgentCommand } from './launch.js';
import { checkNode, checkTool, compareVersions } from './repo.js';

/**
 * @typedef {import('../spawn.js').Spawn} Spawn
 * @typedef {'ok' | 'warn' | 'fail'} CheckStatus
 * @typedef {{ id: string, status: CheckStatus, detail: string, fix?: string }} Check
 */

const MARKS = { ok: '✓', warn: '!', fail: '✗' };

/** @param {Check} check */
export function formatCheck(check) {
  const line = `${MARKS[check.status]} ${check.id}: ${check.detail}`;
  return check.fix && check.status !== 'ok'
    ? `${line}\n    Fix: ${check.fix}`
    : line;
}

/**
 * @param {() => string} fn
 * @param {string} id
 * @returns {Check}
 */
function attempt(fn, id) {
  try {
    return { id, status: 'ok', detail: fn() };
  } catch (error) {
    const [detail, fix] = /** @type {Error} */ (error).message.split('\nFix: ');
    return { id, status: 'fail', detail, fix };
  }
}

/**
 * @param {{ home: string, homeSource: string, version: string, profile: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string, run?: Spawn, canRun?: (file: string) => boolean, registry?: (home: string, name: string) => string[] | null, versions?: NodeJS.ProcessVersions }} input
 * @returns {Check[]}
 */
export function runChecks({
  home,
  homeSource,
  version,
  profile,
  env,
  platform,
  homedir,
  run = crossSpawn(),
  canRun,
  registry,
  versions = process.versions,
}) {
  /** @type {Check[]} */
  const checks = [
    attempt(() => {
      checkNode({ versions });
      return `Node.js ${versions.node}`;
    }, 'node'),
    attempt(() => checkTool({ run, bin: 'git' }), 'git'),
    attempt(() => `pnpm ${checkTool({ run, bin: 'pnpm' })}`, 'pnpm'),
  ];

  const state = homeState(home);
  if (state === 'workspace') {
    checks.push({
      id: 'home',
      status: 'ok',
      detail: `${home} (${homeSource})`,
    });
  } else if (state === 'other') {
    checks.push({
      id: 'home',
      status: 'fail',
      detail: `${home} (${homeSource}) holds files but is not a kyoten workspace`,
      fix: 'kyoten --home <another dir> init, or point KYOTEN_HOME at your kyoten workspace',
    });
  } else {
    checks.push({
      id: 'home',
      status: 'warn',
      detail: `${home} (${homeSource}) does not exist yet`,
      fix: 'kyoten init',
    });
  }

  const info = state === 'workspace' ? readHomeInfo(home) : null;
  if (state === 'workspace') {
    const order = info ? compareVersions(version, info.version) : 0;
    checks.push(
      !info
        ? {
            id: 'version',
            status: 'ok',
            detail: `kyoten ${version}; the home is a clone (update it with git pull)`,
          }
        : order > 0
          ? {
              id: 'version',
              status: 'warn',
              detail: `kyoten ${version}; the home has ${info.version}`,
              fix: 'kyoten update',
            }
          : order < 0
            ? {
                id: 'version',
                status: 'warn',
                detail: `kyoten ${version}; the home has the newer ${info.version}`,
                fix: 'npx kyoten@latest doctor',
              }
            : {
                id: 'version',
                status: 'ok',
                detail: `kyoten ${version}; the home has ${info.version}`,
              }
    );
  }

  for (const agent of /** @type {const} */ (['claude', 'codex', 'dsh'])) {
    const command = findAgentCommand({
      agent,
      home,
      env,
      platform,
      canRun,
      registry,
    });
    checks.push(
      command
        ? { id: agent, status: 'ok', detail: command.join(' ') }
        : {
            id: agent,
            status: 'warn',
            detail: 'not found',
            fix: agentInstallHint(agent, home, platform),
          }
    );
    if (!command || state !== 'workspace') continue;
    if (agent === 'codex') {
      const config = readIfExists(
        path.join(env.CODEX_HOME || path.join(homedir, '.codex'), 'config.toml')
      );
      checks.push(
        config !== null && codexTrustsProject(config, home)
          ? {
              id: 'codex-trust',
              status: 'ok',
              detail: 'the home is trusted; run /hooks once to trust its hooks',
            }
          : {
              id: 'codex-trust',
              status: 'warn',
              detail:
                'the home is not trusted in Codex, so Codex ignores .codex/ (hooks, rules, roles)',
              fix: 'kyoten codex, accept the trust prompt, then run /hooks',
            }
      );
    }
    if (agent === 'dsh') {
      const problem = dshDirProblem(home, platform);
      checks.push(
        problem
          ? {
              id: 'dsh-hooks',
              status: 'fail',
              detail: problem.split('\nFix: ')[0],
              fix: problem.split('\nFix: ')[1],
            }
          : {
              id: 'dsh-hooks',
              status: 'ok',
              detail: `kyoten dsh adds --patch ${DSH_PATCH}; the hooks bridge must be in each profile you start (not checkable): ${DSH_BRIDGE_INSTALL}`,
            }
      );
    }
  }

  const text = readIfExists(profile);
  const token =
    text === null ? undefined : parseProfile(text).pairs.get(TOKEN_KEY);
  checks.push(
    text === null || tokenUnset(token)
      ? {
          id: 'dscc',
          status: 'warn',
          detail: `no DeepSeek key in ${profile}`,
          fix: 'kyoten dscc --set-key',
        }
      : { id: 'dscc', status: 'ok', detail: `${profile} (key ${mask(token)})` }
  );
  return checks;
}

/**
 * `pnpm workspace:check` in the home, output shown.
 *
 * @param {{ home: string, run: Spawn, env: NodeJS.ProcessEnv }} input
 * @returns {Check}
 */
export function workspaceCheck({ home, run, env }) {
  if (!fs.existsSync(path.join(home, 'node_modules'))) {
    return {
      id: 'workspace',
      status: 'fail',
      detail: 'dependencies are not installed',
      fix: `kyoten --home "${home}" init`,
    };
  }
  const result = run('pnpm', ['workspace:check'], {
    cwd: home,
    stdio: 'inherit',
    env,
  });
  return result.status === 0
    ? { id: 'workspace', status: 'ok', detail: 'pnpm workspace:check passed' }
    : {
        id: 'workspace',
        status: 'fail',
        detail: 'pnpm workspace:check failed (see above)',
        fix: `kyoten --home "${home}" init`,
      };
}
