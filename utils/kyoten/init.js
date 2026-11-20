/**
 * `kyoten init`: create a home from the snapshot (a git repository on
 * `main`, with `kyoten/upstream` at the same commit), then install it:
 * `pnpm install --frozen-lockfile` and `pnpm workspace:setup`. On an
 * existing kyoten workspace it only runs the install again, so a failed
 * setup is finished by running init again.
 */
import fs from 'fs';
import { PNPM_INSTALL, crossSpawn } from '../spawn.js';
import { homeState, writeHomeInfo } from './home.js';
import { checkNode, checkTool, initRepo } from './repo.js';
import { materialize } from './snapshot.js';

/**
 * @typedef {import('../spawn.js').Spawn} Spawn
 * @typedef {import('./snapshot.js').SnapshotSource} SnapshotSource
 */

/**
 * `pnpm install` and `pnpm workspace:setup` in `home`, output shown.
 *
 * @param {{ home: string, log: (text: string) => void, run?: Spawn, env?: NodeJS.ProcessEnv }} input
 */
export function runSetup({ home, log, run = crossSpawn(), env = process.env }) {
  for (const args of [PNPM_INSTALL, ['workspace:setup']]) {
    log(`running pnpm ${args.join(' ')} in ${home}`);
    const result = run('pnpm', args, { cwd: home, stdio: 'inherit', env });
    if (result.error || result.status !== 0) {
      throw new Error(
        `pnpm ${args.join(' ')} failed in ${home} (see above).\nFix: fix what it reports, then run: kyoten --home "${home}" init`
      );
    }
  }
}

/**
 * @param {{ home: string, source: SnapshotSource, log: (text: string) => void, setup?: boolean, run?: Spawn, env?: NodeJS.ProcessEnv, now?: () => Date }} input
 * @returns {{ created: boolean }}
 */
export function initHome({
  home,
  source,
  log,
  setup = true,
  run = crossSpawn(),
  env = process.env,
  now = () => new Date(),
}) {
  const state = homeState(home);
  if (state === 'other') {
    throw new Error(
      `${home} is not empty and is not a kyoten workspace.\nFix: choose a new or empty folder: kyoten init <dir>`
    );
  }
  checkNode();
  checkTool({ run, bin: 'git' });
  if (setup) checkTool({ run, bin: 'pnpm' });
  const created = state !== 'workspace';
  if (created) {
    log(
      `creating a kyoten home at ${home} (kyoten ${source.version}, ${source.commit.slice(0, 7)})`
    );
    fs.mkdirSync(home, { recursive: true });
    materialize(source, home, { run });
    initRepo({ run, home, version: source.version, env });
    writeHomeInfo(home, {
      managed: true,
      version: source.version,
      sourceCommit: source.commit,
      createdAt: now().toISOString(),
    });
  } else {
    log(`${home} is already a kyoten workspace`);
  }
  if (setup) runSetup({ home, log, run, env });
  return { created };
}
