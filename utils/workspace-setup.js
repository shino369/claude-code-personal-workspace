#!/usr/bin/env node
/**
 * Initialise (or verify) this workspace for any agent harness.
 *
 *   pnpm workspace:setup            # install + link + git hooks
 *   pnpm workspace:check            # verify only, no changes
 *
 * Steps run in order; every failure prints the exact command that fixes it.
 * Run `node utils/workspace-setup.js --help` for options.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { runIfMain } from './module-runner.js';
import { installSkills } from './skills-install.js';
import { PROBLEM_STATUSES, linkSkills } from './skills-link.js';
import { checkSkills } from './skills-lock.js';
import {
  DEFAULT_LINK_TARGETS,
  MIN_NODE_MAJOR,
  ROOT_DIR,
} from './workspace-config.js';

export const HELP = `Usage: node utils/workspace-setup.js [options]

Options:
  --check           Verify only; change nothing (exit 1 if a required step fails)
  --skip-install    Do not run pnpm install
  --skip-skills     Do not install third-party skills from skills-lock.json
  --with-browsers   Also install agent-browser's browser and Playwright Chromium
  --target <dir>    Extra skill link directory (repeatable), e.g. .dsh/skills
  --json            Print a JSON report
  --help            Show this help`;

/** Git hook shims that must be executable. */
export const HOOK_FILES = ['pre-commit', 'commit-msg'];

/** Optional CLIs reported (never installed) by the setup. */
export const OPTIONAL_TOOLS = [
  { tool: 'claude', hint: 'https://code.claude.com/docs' },
  { tool: 'codex', hint: 'https://developers.openai.com/codex' },
  {
    tool: 'uv',
    hint: 'https://docs.astral.sh/uv/ (browser-use, skill-creator)',
  },
  { tool: 'gh', hint: 'https://cli.github.com/ (dependency-update)' },
  { tool: 'browser-use', hint: 'uv tool install --python 3.12 browser-use' },
];

/**
 * @typedef {'ok' | 'done' | 'warn' | 'fail' | 'skip'} StepStatus
 * @typedef {{ id: string, status: StepStatus, detail: string, fix?: string }} StepResult
 * @typedef {{ status: number | null, stdout?: string | Buffer | null }} SpawnResult
 * @typedef {(cmd: string, args: string[], options: object) => SpawnResult} Spawn
 * @typedef {{
 *   rootDir: string,
 *   platform: string,
 *   nodeVersion: string,
 *   spawn: Spawn,
 *   log: (message: string) => void,
 *   existsSync: (p: string) => boolean,
 *   chmodSync: (p: string, mode: number) => void,
 *   installSkills: typeof installSkills,
 *   checkSkills: typeof checkSkills,
 *   linkSkills: typeof linkSkills,
 * }} Deps
 * @typedef {{ check: boolean, skipInstall: boolean, skipSkills: boolean, withBrowsers: boolean, json: boolean, help: boolean, targets: string[] }} Options
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    check: false,
    skipInstall: false,
    skipSkills: false,
    withBrowsers: false,
    json: false,
    help: false,
    targets: [...DEFAULT_LINK_TARGETS],
  };
  /** @type {Record<string, keyof Options>} */
  const flags = {
    '--check': 'check',
    '--skip-install': 'skipInstall',
    '--skip-skills': 'skipSkills',
    '--with-browsers': 'withBrowsers',
    '--json': 'json',
    '--help': 'help',
    '-h': 'help',
  };

  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    if (flag === '--target') {
      const value = inline ?? argv[++i];
      if (!value) throw new Error('--target needs a directory');
      options.targets.push(value);
    } else if (flags[flag]) {
      /** @type {Record<string, unknown>} */ (options)[flags[flag]] = true;
    } else {
      throw new Error(`Unknown option: ${argv[i]} (see --help)`);
    }
  }

  return options;
}

/**
 * Run pnpm with constant arguments. On Windows pnpm is a .cmd shim, which
 * Node only spawns through a shell; every caller passes literal arguments, so
 * the shell sees no untrusted input.
 *
 * @param {Deps} deps
 * @param {string[]} args
 * @param {object} [extra]
 * @returns {SpawnResult}
 */
export function runPnpm(deps, args, extra = {}) {
  return deps.spawn('pnpm', args, {
    cwd: deps.rootDir,
    shell: deps.platform === 'win32',
    ...extra,
  });
}

/**
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function checkNode(deps) {
  const major = Number(deps.nodeVersion.replace(/^v/, '').split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { id: 'node', status: 'ok', detail: `Node.js ${deps.nodeVersion}` }
    : {
        id: 'node',
        status: 'fail',
        detail: `Node.js ${deps.nodeVersion} is older than ${MIN_NODE_MAJOR}`,
        fix: `Install Node.js ${MIN_NODE_MAJOR}+ (see .nvmrc), e.g. nvm install ${MIN_NODE_MAJOR}`,
      };
}

/**
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepDependencies(options, deps) {
  const installed = deps.existsSync(
    path.join(deps.rootDir, 'node_modules', '.pnpm')
  );
  if (options.check || options.skipInstall) {
    return installed
      ? { id: 'dependencies', status: 'ok', detail: 'node_modules present' }
      : {
          id: 'dependencies',
          status: options.check ? 'fail' : 'skip',
          detail: 'node_modules missing',
          fix: 'pnpm install',
        };
  }

  const result = runPnpm(deps, ['install', '--frozen-lockfile'], {
    stdio: 'inherit',
  });
  return result.status === 0
    ? { id: 'dependencies', status: 'done', detail: 'pnpm install' }
    : {
        id: 'dependencies',
        status: 'fail',
        detail: `pnpm install exited ${result.status}`,
        fix: 'corepack enable && pnpm install',
      };
}

/**
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepLinks(options, deps) {
  const results = deps.linkSkills({
    rootDir: deps.rootDir,
    targets: options.targets,
    check: options.check,
  });
  const problems = results.filter((r) => PROBLEM_STATUSES.has(r.status));
  const changed = results.filter(
    (r) => r.status !== 'ok' && !PROBLEM_STATUSES.has(r.status)
  ).length;

  if (problems.length > 0) {
    return {
      id: 'skill-links',
      status: 'fail',
      detail: problems
        .map((p) => `${path.join(p.target, p.name)}: ${p.status}`)
        .join('; '),
      fix: options.check
        ? 'pnpm skills:link'
        : 'pnpm skills:link (resolve conflicts it reports first)',
    };
  }
  return {
    id: 'skill-links',
    status: changed > 0 ? 'done' : 'ok',
    detail: `${results.length} link(s) in ${options.targets.join(', ')}, ${changed} changed`,
  };
}

/**
 * Third-party skills are recommended, not required: missing ones only warn.
 *
 * @param {Options} options
 * @param {Deps} deps
 * @returns {Promise<StepResult>}
 */
export async function stepSkills(options, deps) {
  const lockPath = path.join(deps.rootDir, 'skills-lock.json');

  if (!options.check && !options.skipSkills) {
    const code = await deps.installSkills({
      rootDir: deps.rootDir,
      lockPath,
      log: deps.log,
    });
    if (code !== 0) {
      return {
        id: 'skills',
        status: 'warn',
        detail: 'some third-party skills failed to install',
        fix: 'pnpm skills:install (needs network access to GitHub)',
      };
    }
  }

  const results = await deps.checkSkills({ rootDir: deps.rootDir, lockPath });
  const missing = results.filter((r) => !r.ok).map((r) => r.name);
  if (missing.length === 0) {
    return {
      id: 'skills',
      status: options.check || options.skipSkills ? 'ok' : 'done',
      detail: `${results.length} third-party skill(s) installed`,
    };
  }
  return {
    id: 'skills',
    status: 'warn',
    detail: `not installed: ${missing.join(', ')}`,
    fix: `pnpm skills:install --only ${missing.join(',')}`,
  };
}

/**
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepGitHooks(options, deps) {
  const current = deps.spawn('git', ['config', '--get', 'core.hooksPath'], {
    cwd: deps.rootDir,
    encoding: 'utf8',
  });
  const configured = String(current.stdout ?? '').trim() === '.githooks';

  if (options.check) {
    return configured
      ? { id: 'git-hooks', status: 'ok', detail: 'core.hooksPath=.githooks' }
      : {
          id: 'git-hooks',
          status: 'fail',
          detail: 'commit hooks are not enabled',
          fix: 'pnpm workspace:setup (or: git config core.hooksPath .githooks)',
        };
  }

  for (const file of HOOK_FILES) {
    deps.chmodSync(path.join(deps.rootDir, '.githooks', file), 0o755);
  }
  if (configured) {
    return {
      id: 'git-hooks',
      status: 'ok',
      detail: 'core.hooksPath=.githooks',
    };
  }

  const result = deps.spawn('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: deps.rootDir,
  });
  return result.status === 0
    ? { id: 'git-hooks', status: 'done', detail: 'core.hooksPath=.githooks' }
    : {
        id: 'git-hooks',
        status: 'fail',
        detail: `git config exited ${result.status}`,
        fix: 'git config core.hooksPath .githooks',
      };
}

/**
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepBrowsers(options, deps) {
  if (!options.withBrowsers || options.check) {
    return {
      id: 'browsers',
      status: 'skip',
      detail: 'not requested',
      fix: 'pnpm workspace:setup --with-browsers',
    };
  }

  const commands = [
    ['exec', 'agent-browser', 'install'],
    ['exec', 'playwright', 'install', 'chromium'],
  ];
  const failed = commands.filter(
    (args) => runPnpm(deps, args, { stdio: 'inherit' }).status !== 0
  );
  return failed.length === 0
    ? { id: 'browsers', status: 'done', detail: 'agent-browser + Chromium' }
    : {
        id: 'browsers',
        status: 'warn',
        detail: `failed: ${failed.map((a) => a.join(' ')).join('; ')}`,
        fix: failed.map((a) => `pnpm ${a.join(' ')}`).join(' && '),
      };
}

/**
 * Report optional CLIs; never installs anything.
 *
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepTools(deps) {
  const missing = OPTIONAL_TOOLS.filter(
    ({ tool }) =>
      deps.spawn(tool, ['--version'], {
        stdio: 'ignore',
        // Windows CLIs are often .cmd shims; tool names are constants above.
        shell: deps.platform === 'win32',
      }).status !== 0
  );
  const found = OPTIONAL_TOOLS.length - missing.length;
  return missing.length === 0
    ? { id: 'tools', status: 'ok', detail: `${found} optional CLI(s) found` }
    : {
        id: 'tools',
        status: 'warn',
        detail: `optional CLI(s) not found: ${missing.map((m) => m.tool).join(', ')}`,
        fix: missing.map((m) => `${m.tool}: ${m.hint}`).join(' | '),
      };
}

/**
 * Run every step in order. Links run before and after the skills install:
 * the first pass migrates legacy copies, the second repairs links.
 *
 * @param {Options} options
 * @param {Deps} deps
 * @returns {Promise<StepResult[]>}
 */
export async function runSteps(options, deps) {
  /** @type {StepResult[]} */
  const results = [checkNode(deps)];
  if (results[0].status === 'fail') return results;

  results.push(stepDependencies(options, deps));
  if (!options.check) {
    // First pass migrates legacy copied installs before skills.sh runs.
    const migration = stepLinks(options, deps);
    if (migration.status === 'done') {
      results.push({ ...migration, id: 'skill-migrate' });
    }
  }
  results.push(await stepSkills(options, deps));
  results.push(stepLinks(options, deps));
  results.push(stepGitHooks(options, deps));
  results.push(stepBrowsers(options, deps));
  results.push(stepTools(deps));
  return results;
}

/** @type {Record<StepStatus, string>} */
const MARKS = { ok: '✓', done: '✓', warn: '!', fail: '✗', skip: '-' };

/**
 * @param {StepResult} result
 * @returns {string}
 */
export function formatResult(result) {
  const line = `${MARKS[result.status]} ${result.id}: ${result.detail}`;
  return result.fix && result.status !== 'ok' && result.status !== 'done'
    ? `${line}\n    Fix: ${result.fix}`
    : line;
}

/**
 * @param {{ argv?: string[], deps?: Partial<Deps> }} [options]
 * @returns {Promise<number>}
 */
export async function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  /** @type {Deps} */
  const resolved = {
    rootDir: ROOT_DIR,
    platform: process.platform,
    nodeVersion: process.version,
    spawn: /** @type {Spawn} */ (spawnSync),
    log: console.log,
    existsSync: fs.existsSync,
    chmodSync: fs.chmodSync,
    installSkills,
    checkSkills,
    linkSkills,
    ...deps,
  };
  const options = parseArgs(argv);
  if (options.help) {
    resolved.log(HELP);
    return 0;
  }

  const results = await runSteps(options, resolved);
  const failed = results.filter((r) => r.status === 'fail');

  if (options.json) {
    resolved.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else {
    for (const result of results) resolved.log(formatResult(result));
    resolved.log(
      failed.length === 0
        ? `Workspace ${options.check ? 'check passed' : 'ready'}.`
        : `${failed.length} required step(s) failed — run the Fix commands above, then: pnpm workspace:check`
    );
  }
  return failed.length === 0 ? 0 : 1;
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, async () => {
  try {
    process.exit(await main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
