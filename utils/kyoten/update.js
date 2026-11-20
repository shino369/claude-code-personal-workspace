/**
 * `kyoten update`: bring a home kyoten created up to this kyoten's snapshot.
 *
 * The new snapshot becomes a commit on `kyoten/upstream` (plumbing, with a
 * scratch index, so the user's index and files are untouched), then
 * `git merge kyoten/upstream` brings it into the user's branch: a
 * fast-forward when they changed nothing, a merge commit otherwise, and git
 * conflicts when both sides changed the same lines. Nothing is overwritten.
 */
import fs from 'fs';
import path from 'path';
import { crossSpawn } from '../spawn.js';
import { readHomeInfo, writeHomeInfo } from './home.js';
import { runSetup } from './init.js';
import {
  UPSTREAM,
  checkNode,
  checkTool,
  commitTree,
  compareVersions,
  mergeEnv,
  updateBlocker,
  writeTree,
} from './repo.js';
import { capture, materialize } from './snapshot.js';

/**
 * @typedef {import('../spawn.js').Spawn} Spawn
 * @typedef {import('./snapshot.js').SnapshotSource} SnapshotSource
 */

/**
 * Commit `source` onto kyoten/upstream unless it holds that tree already.
 *
 * @param {{ home: string, source: SnapshotSource, run: Spawn, env: NodeJS.ProcessEnv }} input
 * @returns {boolean}  whether kyoten/upstream moved
 */
function advanceUpstream({ home, source, run, env }) {
  const ref = `refs/heads/${UPSTREAM}`;
  const found = run('git', ['-C', home, 'rev-parse', '--verify', '-q', ref], {
    encoding: 'utf-8',
  });
  if (found.status !== 0) {
    throw new Error(
      `${home} has no ${UPSTREAM} branch, so kyoten cannot tell its snapshot from your changes.\nFix: restore the branch (git branch ${UPSTREAM} <the commit kyoten made>), then run kyoten update again`
    );
  }
  const parent = String(found.stdout).trim();
  const scratch = path.join(
    home,
    '.kyoten',
    'tmp',
    `update-${process.pid}-${Date.now()}`
  );
  try {
    const tree = path.join(scratch, 'tree');
    fs.mkdirSync(tree, { recursive: true });
    materialize(source, tree, { run });
    const next = writeTree({
      run,
      home,
      workTree: tree,
      index: path.join(scratch, 'index'),
      env,
    });
    const current = capture(run, 'git', [
      '-C',
      home,
      'rev-parse',
      `${parent}^{tree}`,
    ]).trim();
    if (next === current) return false;
    const commit = commitTree({
      run,
      home,
      tree: next,
      version: source.version,
      parent,
      env,
    });
    capture(run, 'git', ['-C', home, 'update-ref', ref, commit, parent], {
      env,
    });
    return true;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * @param {{ home: string, source: SnapshotSource, log: (text: string) => void, setup?: boolean, run?: Spawn, env?: NodeJS.ProcessEnv, now?: () => Date }} input
 * @returns {{ changed: boolean }}
 */
export function updateHome({
  home,
  source,
  log,
  setup = true,
  run = crossSpawn(),
  env = process.env,
  now = () => new Date(),
}) {
  const info = readHomeInfo(home);
  if (!info) {
    throw new Error(
      `${home} was not created by kyoten init (a clone?), so kyoten does not update it.\nFix: update it with git pull`
    );
  }
  if (compareVersions(source.version, info.version) < 0) {
    throw new Error(
      `this kyoten (${source.version}) is older than the home (${info.version}); updating would take the home back.\nFix: npx kyoten@latest update`
    );
  }
  const blocker = updateBlocker({ run, home });
  if (blocker) throw new Error(blocker);
  checkNode();
  if (setup) checkTool({ run, bin: 'pnpm' });

  const advanced = advanceUpstream({ home, source, run, env });
  const contained =
    run('git', ['-C', home, 'merge-base', '--is-ancestor', UPSTREAM, 'HEAD'], {
      encoding: 'utf-8',
    }).status === 0;
  if (!contained) {
    log(`merging kyoten ${source.version} (${UPSTREAM}) into your branch`);
    const merge = run('git', ['-C', home, 'merge', '--no-edit', UPSTREAM], {
      stdio: 'inherit',
      env: mergeEnv({ run, home, env }),
    });
    if (merge.error || merge.status !== 0) {
      throw new Error(
        `the merge of kyoten ${source.version} did not finish (see git's message above).\nFix: in ${home}, resolve the conflicts and git commit (or git merge --abort), then run kyoten update again`
      );
    }
  }
  const changed = advanced || !contained || info.version !== source.version;
  if (!changed) {
    log(`${home} already has kyoten ${source.version}`);
    return { changed };
  }
  if (setup) runSetup({ home, log, run, env });
  writeHomeInfo(home, {
    ...info,
    version: source.version,
    sourceCommit: source.commit,
    updatedAt: now().toISOString(),
  });
  log(`${home} is on kyoten ${source.version}`);
  return { changed };
}
