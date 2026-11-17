/**
 * Default dependencies for the task CLI and the Claude hooks that reuse it.
 */
import { ROOT_DIR } from '../workspace-config.js';
import { runTaskCheck } from './check.js';
import { gitInfo } from './git.js';
import { TEMPLATES_DIR } from './store.js';
import { runCommands } from './verify.js';

/**
 * @typedef {{
 *   rootDir: string,
 *   templatesDir: string,
 *   env: NodeJS.ProcessEnv,
 *   now: () => Date,
 *   log: (message: string) => void,
 *   git: (cwd: string) => import('./git.js').GitInfo,
 *   runCommands: typeof runCommands,
 *   runCheck: typeof runTaskCheck,
 * }} Deps
 */

/**
 * @param {Partial<Deps>} [overrides]
 * @returns {Deps}
 */
export function defaultDeps(overrides = {}) {
  return {
    rootDir: ROOT_DIR,
    templatesDir: TEMPLATES_DIR,
    env: process.env,
    now: () => new Date(),
    log: console.log,
    git: (cwd) => gitInfo(cwd),
    runCommands,
    runCheck: runTaskCheck,
    ...overrides,
  };
}
