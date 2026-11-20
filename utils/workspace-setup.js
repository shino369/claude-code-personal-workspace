#!/usr/bin/env node
/**
 * Initialise (or verify) this workspace for any agent harness.
 *
 *   pnpm workspace:setup            # install + link + git hooks + memory init
 *   pnpm workspace:check            # verify only, no changes
 *
 * Steps run in order; every failure prints the exact command that fixes it.
 * Run `node utils/workspace-setup.js --help` for options.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { main as harnessMain } from './harness/cli.js';
import { DSH_BRIDGE_INSTALL, DSH_PATCH } from './loop/adapters.js';
import { initLocal } from './memory/render.js';
import { mainCheckout } from './memory/repo.js';
import { runIfMain } from './module-runner.js';
import { installSkills } from './skills-install.js';
import { PROBLEM_STATUSES, linkSkills } from './skills-link.js';
import { checkSkills } from './skills-lock.js';
import { installHint } from './tools/catalog.js';
import { setupTools } from './tools/cli.js';
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

/** Personal memory (pnpm memory): local to this checkout, never committed. */
export const MEMORY_PATHS = ['AGENTS.local.md', 'CLAUDE.local.md', 'memory/'];

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
 *   initMemory: typeof initLocal,
 *   installSkills: typeof installSkills,
 *   checkSkills: typeof checkSkills,
 *   linkSkills: typeof linkSkills,
 *   tools: ToolsDeps,
 *   harness: typeof harnessMain,
 *   env: Record<string, string | undefined>,
 *   homedir: () => string,
 *   readFile: (p: string) => string,
 * }} Deps
 * @typedef {{
 *   scan: () => void,
 *   registry: () => import('./tools/registry.js').Registry,
 *   catalog: () => import('./tools/catalog.js').CatalogEntry[],
 * }} ToolsDeps
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
 * Whether an absolute core.hooksPath is this workspace's `.githooks`: in
 * this checkout, or in the main checkout (git's common dir) when this is a
 * linked worktree. Claude Code's worktree support can rewrite the shared
 * setting to such an absolute path; the hooks still run.
 *
 * @param {string} value
 * @param {Deps} deps
 */
function isWorkspaceHooks(value, deps) {
  if (!path.isAbsolute(value)) return false;
  const common = deps.spawn(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: deps.rootDir, encoding: 'utf8' }
  );
  const roots = [deps.rootDir];
  if (common.status === 0) {
    roots.push(path.dirname(String(common.stdout).trim()));
  }
  return roots.some(
    (root) => path.resolve(value) === path.resolve(root, '.githooks')
  );
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
  const value = String(current.stdout ?? '').trim();
  const configured = value === '.githooks' || isWorkspaceHooks(value, deps);

  if (options.check) {
    return configured
      ? { id: 'git-hooks', status: 'ok', detail: `core.hooksPath=${value}` }
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
      detail: `core.hooksPath=${value}`,
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
 * Personal memory stays out of git: fail when a memory path is tracked or
 * not gitignored (before creating anything). Setup then creates the local
 * files (pnpm memory init) in the main checkout, which worktrees share;
 * check only warns when they are missing.
 *
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepMemory(options, deps) {
  const listed = deps.spawn(
    'git',
    ['ls-files', '--', ...MEMORY_PATHS.map((p) => p.replace(/\/$/, ''))],
    { cwd: deps.rootDir, encoding: 'utf8' }
  );
  const tracked = String(listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      MEMORY_PATHS.some((p) =>
        p.endsWith('/') ? line.startsWith(p) : line === p
      )
    );
  if (tracked.length > 0) {
    const tops = [...new Set(tracked.map((line) => line.split('/')[0]))];
    return {
      id: 'memory',
      status: 'fail',
      detail: `personal memory is tracked by git: ${tracked.join(', ')}`,
      fix: `git rm -r --cached -- ${tops.join(' ')} (keeps the files), then commit`,
    };
  }
  const unignored = MEMORY_PATHS.filter(
    (p) =>
      deps.spawn('git', ['check-ignore', '-q', '--no-index', '--', p], {
        cwd: deps.rootDir,
      }).status !== 0
  );
  if (unignored.length > 0) {
    return {
      id: 'memory',
      status: 'fail',
      detail: `not gitignored: ${unignored.join(', ')}`,
      fix: `add ${unignored.map((p) => `/${p}`).join(' ')} to .gitignore`,
    };
  }
  // A linked worktree (pnpm loop, swarm) uses the main checkout's memory.
  const home = mainCheckout(deps.rootDir);
  if (options.check) {
    const missing = MEMORY_PATHS.filter(
      (p) => !deps.existsSync(path.join(home, p))
    );
    return missing.length === 0
      ? {
          id: 'memory',
          status: 'ok',
          detail: 'local and gitignored (pnpm memory status)',
        }
      : {
          id: 'memory',
          status: 'warn',
          detail: `not set up: ${missing.join(', ')}`,
          fix: 'pnpm memory init',
        };
  }
  let result;
  try {
    result = deps.initMemory(home);
  } catch (error) {
    return {
      id: 'memory',
      status: 'warn',
      detail: /** @type {Error} */ (error).message.split('\n')[0],
      fix: 'pnpm memory init',
    };
  }
  const changes = [
    ...(result.created.length > 0
      ? [`created ${result.created.join(', ')}`]
      : []),
    ...(result.updated.length > 0
      ? [`updated ${result.updated.join(', ')}`]
      : []),
  ];
  if (result.warnings.length > 0) {
    return {
      id: 'memory',
      status: 'warn',
      detail: [...changes, ...result.warnings].join('; '),
      fix: 'pnpm memory status',
    };
  }
  return changes.length > 0
    ? { id: 'memory', status: 'done', detail: changes.join('; ') }
    : { id: 'memory', status: 'ok', detail: 'set up (pnpm memory status)' };
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
 * The tool registry (`pnpm tools`): setup records what is on PATH; check only
 * reports. Never installs anything; recommended catalog tools that are
 * missing only warn, with their install hints.
 *
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepTools(options, deps) {
  let registry;
  let catalog;
  try {
    if (!options.check) deps.tools.scan();
    registry = deps.tools.registry();
    catalog = deps.tools.catalog();
  } catch (error) {
    return {
      id: 'tools',
      status: 'warn',
      detail: `tool registry unreadable: ${/** @type {Error} */ (error).message.split('\n')[0]}`,
      fix: 'pnpm tools scan --reset',
    };
  }
  if (registry.tools.length === 0) {
    return {
      id: 'tools',
      status: 'warn',
      detail: 'no tools recorded in tools/local.json',
      fix: 'pnpm tools scan',
    };
  }
  const working = new Set(
    registry.tools.filter((t) => t.ok).map((t) => t.name)
  );
  const missing = catalog.filter((t) => t.recommended && !working.has(t.name));
  const detail = `${registry.tools.length} tool(s) in tools/local.json (pnpm tools list)`;
  return missing.length === 0
    ? { id: 'tools', status: 'ok', detail }
    : {
        id: 'tools',
        status: 'warn',
        detail: `${detail}; recommended but missing: ${missing.map((t) => t.name).join(', ')}`,
        fix: missing
          .map(
            (t) =>
              `${t.name}: ${installHint(t, deps.platform) ?? 'see pnpm tools show'}`
          )
          .join(' | '),
      };
}

/**
 * Run `pnpm harness <command>` in-process and capture its log lines.
 *
 * @param {Deps} deps
 * @param {string} command
 * @returns {{ code: number, lines: string[] }}
 */
function runHarness(deps, command) {
  /** @type {string[]} */
  const lines = [];
  const code = deps.harness({
    argv: [command],
    deps: { rootDir: deps.rootDir, log: (line) => lines.push(line) },
  });
  return { code, lines };
}

/**
 * Keep every harness's generated config current (pnpm harness): setup writes
 * it, check only compares.
 *
 * @param {Options} options
 * @param {Deps} deps
 * @returns {StepResult}
 */
export function stepHarness(options, deps) {
  const { code, lines } = runHarness(deps, options.check ? 'check' : 'sync');
  const problems = lines.filter((line) => line.startsWith('✗'));
  if (options.check) {
    if (code === 0) {
      return {
        id: 'harness',
        status: 'ok',
        detail: 'generated harness files match utils/harness/hooks.js',
      };
    }
    const settingsOnly =
      problems.length > 0 &&
      problems.every((line) => line.includes('.claude/settings.json'));
    return {
      id: 'harness',
      status: 'fail',
      detail: problems.join('; ') || 'pnpm harness check failed',
      fix: settingsOnly ? 'pnpm harness check' : 'pnpm harness sync',
    };
  }
  if (code !== 0) {
    return {
      id: 'harness',
      status: 'fail',
      detail:
        problems.join('; ') ||
        '.claude/settings.json hooks differ from manifest',
      fix: 'pnpm harness check',
    };
  }
  const wrote = lines
    .filter((line) => line.startsWith('Wrote '))
    .map((line) => line.slice('Wrote '.length));
  if (wrote.length === 0) {
    return {
      id: 'harness',
      status: 'ok',
      detail: 'generated harness files are up to date',
    };
  }
  const hint = wrote.includes('.codex/hooks.json')
    ? '; run /hooks in Codex to trust the changed hooks'
    : '';
  return {
    id: 'harness',
    status: 'done',
    detail: `wrote ${wrote.join(', ')}${hint}`,
  };
}

/**
 * Whether Codex config text marks `root` as a trusted project: a
 * `[projects."<root>"]` table holding `trust_level = "trusted"`. The text is
 * only matched, never printed.
 *
 * @param {string} text
 * @param {string} root
 * @returns {boolean}
 */
export function codexTrustsProject(text, root) {
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header =
      /^\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]/.exec(line);
    if (header) {
      const name = header[2] ?? header[1].replace(/\\(.)/g, '$1');
      inTable = name === root;
    } else if (line.startsWith('[')) {
      inTable = false;
    } else if (inTable && /^trust_level\s*=\s*["']trusted["']/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Per-agent hints for the generated config: Codex ignores `.codex/` in a
 * project it does not trust, and DSH has no project config, so it must be
 * started with the workspace patch. Only for agents on this machine.
 *
 * @param {Deps} deps
 * @returns {StepResult[]}
 */
export function stepHarnessAgents(deps) {
  /** @type {Set<string>} */
  let installed;
  try {
    installed = new Set(
      deps.tools
        .registry()
        .tools.filter((t) => t.ok)
        .map((t) => t.name)
    );
  } catch {
    return [];
  }
  /** @type {StepResult[]} */
  const results = [];
  if (installed.has('codex')) {
    const home = deps.env.CODEX_HOME || path.join(deps.homedir(), '.codex');
    let trusted = false;
    try {
      trusted = codexTrustsProject(
        deps.readFile(path.join(home, 'config.toml')),
        deps.rootDir
      );
    } catch {
      // No readable config: the project is not trusted.
    }
    results.push(
      trusted
        ? {
            id: 'harness-codex',
            status: 'ok',
            detail:
              'this checkout is trusted in Codex; run /hooks to trust hooks',
          }
        : {
            id: 'harness-codex',
            status: 'warn',
            detail:
              'this checkout is not trusted in Codex, so it ignores .codex/ (hooks, rules, roles)',
            fix: 'run codex in this folder and trust it, then run /hooks to trust the hooks',
          }
    );
  }
  if (installed.has('dsh')) {
    results.push({
      id: 'harness-dsh',
      status: 'ok',
      detail: `start DSH at the workspace root with: dsh <profile> --patch ${DSH_PATCH}; install the hooks bridge once in each profile you start (headless, web, tui), at the version dsh --version prints: ${DSH_BRIDGE_INSTALL} (not checkable yet)`,
    });
  }
  return results;
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
  results.push(stepMemory(options, deps));
  results.push(stepBrowsers(options, deps));
  results.push(stepTools(options, deps));
  results.push(stepHarness(options, deps), ...stepHarnessAgents(deps));
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
    initMemory: initLocal,
    installSkills,
    checkSkills,
    linkSkills,
    tools: setupTools(ROOT_DIR),
    harness: harnessMain,
    env: process.env,
    homedir: os.homedir,
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
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
