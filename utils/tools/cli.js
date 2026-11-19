#!/usr/bin/env node
/**
 * `pnpm tools <command>` — the machine's tool registry: which agents, CLIs,
 * runtimes, and source checkouts this machine has, and how to call them.
 *
 * `tools/catalog.json` (committed) lists tools worth having;
 * `tools/local.json` (git-ignored) records what is installed here.
 */
import fs from 'fs';
import path from 'path';
import { runIfMain } from '../module-runner.js';
import { currentTask } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { installHint, loadCatalog } from './catalog.js';
import { formatList, formatShow } from './format.js';
import {
  KINDS,
  LOCAL_FILE,
  TOOL_NAME_RE,
  emptyRegistry,
  readRegistry,
  sourcesDir,
  writeRegistry,
} from './registry.js';
import { defaultProbeDeps, mergeScan, probeTool, runCheck } from './scan.js';

/** Timeout for checks that may download first (e.g. `npx -y …`). */
export const SLOW_CHECK_TIMEOUT_MS = 120 * 1000;

export const HELP = `Usage: pnpm tools <command> [options]

What this machine can call: other agents (claude, codex, dsh), CLIs, runtimes,
and source checkouts of reusable tools. tools/catalog.json (committed) lists
tools worth having; tools/local.json (git-ignored) records what is here.

Commands
  list [--all] [--kind agent|cli|runtime|source]
                         Recorded tools; --all adds install hints for missing ones
  scan [--reset]         Find catalog tools on PATH and record them (manual entries kept;
                         --reset starts from an empty registry)
  check                  Re-run every recorded tool's check; exit 1 if any is broken
  show <name>            Details: path, version, headless usage, install hint
  add <name> --kind agent|cli|runtime|source (--path <p> | --command "<cmd>")
      [--via "how installed"] [--check "argv"] [--headless "…"] [--env A,B]
      [-m "notes"] [--task <name>]
                         Record a tool the scan cannot find (npx-only, source checkout, …)
  remove <name>          Forget a tool (does not uninstall anything)
  sources                Print the directory for source checkouts

Options
  --json   Machine-readable output
  --help   Show this help

Call another agent: pnpm agent ask --agent <name> "…". Never put secrets in the
registry; --env records env var names only.`;

const VALUE_FLAGS = {
  '--kind': 'kind',
  '--path': 'path',
  '--command': 'command',
  '--via': 'via',
  '--check': 'check',
  '--headless': 'headless',
  '--env': 'env',
  '--message': 'notes',
  '-m': 'notes',
  '--task': 'task',
};
const BOOLEAN_FLAGS = {
  '--json': 'json',
  '--all': 'all',
  '--reset': 'reset',
  '--help': 'help',
  '-h': 'help',
};

/**
 * @typedef {{
 *   positionals: string[],
 *   kind?: string, path?: string, command?: string, via?: string, check?: string,
 *   headless?: string, env?: string, notes?: string, task?: string,
 *   json: boolean, all: boolean, reset: boolean, help: boolean,
 * }} Options
 * @typedef {{
 *   rootDir: string,
 *   now: () => Date,
 *   log: (message: string) => void,
 *   probe: import('./scan.js').ProbeDeps,
 *   catalog: () => import('./catalog.js').CatalogEntry[],
 * }} Deps
 * @typedef {import('./registry.js').ToolEntry} ToolEntry
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    positionals: [],
    json: false,
    all: false,
    reset: false,
    help: false,
  };
  const record = /** @type {Record<string, unknown>} */ (options);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (Object.hasOwn(BOOLEAN_FLAGS, arg)) {
      record[BOOLEAN_FLAGS[/** @type {keyof typeof BOOLEAN_FLAGS} */ (arg)]] =
        true;
    } else if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      record[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (arg)]] =
        value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}. Run: pnpm tools help`);
    } else {
      options.positionals.push(arg);
    }
  }
  return options;
}

/**
 * @param {Partial<Deps>} [overrides]
 * @returns {Deps}
 */
export function defaultDeps(overrides = {}) {
  return {
    rootDir: ROOT_DIR,
    now: () => new Date(),
    log: console.log,
    probe: defaultProbeDeps(),
    catalog: () => loadCatalog(overrides.rootDir ?? ROOT_DIR),
    ...overrides,
  };
}

/**
 * The argv that checks a recorded tool, or null when it has none (then only
 * the path is checked).
 *
 * @param {ToolEntry} entry
 * @param {import('./catalog.js').CatalogEntry | undefined} tool
 * @returns {string[] | null}
 */
export function checkArgv(entry, tool) {
  if (entry.check) return entry.check;
  if (!tool) return null;
  const prefix = entry.command
    ? entry.command.trim().split(/\s+/)
    : entry.path
      ? [entry.path]
      : [tool.check[0]];
  return [...prefix, ...tool.check.slice(1)];
}

/**
 * Re-check one recorded tool.
 *
 * @param {ToolEntry} entry
 * @param {import('./catalog.js').CatalogEntry | undefined} tool
 * @param {Deps} deps
 * @returns {ToolEntry}
 */
export function recheck(entry, tool, deps) {
  const checkedAt = deps.now().toISOString();
  if (entry.kind === 'source') {
    const dir = entry.path ?? '';
    const ok = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    const head =
      ok && fs.existsSync(path.join(dir, '.git'))
        ? deps.probe.spawn('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : null;
    const version =
      head && head.status === 0 ? String(head.stdout).trim() : entry.version;
    return { ...entry, ok, version, checkedAt };
  }
  const argv = checkArgv(entry, tool);
  if (!argv) {
    const ok = Boolean(entry.path && deps.probe.isExecutable(entry.path));
    return { ...entry, ok, checkedAt };
  }
  const { ok, version } = runCheck(argv, deps.probe, {
    timeoutMs: entry.command ? SLOW_CHECK_TIMEOUT_MS : undefined,
  });
  return { ...entry, ok, version: version ?? entry.version, checkedAt };
}

/**
 * @param {Deps} deps
 * @param {Options} options
 * @param {unknown} json
 * @param {string} text
 */
function output(deps, options, json, text) {
  deps.log(options.json ? JSON.stringify(json, null, 2) : text);
}

/**
 * @param {Options} options
 * @param {string} usage
 * @returns {string}
 */
function requireName(options, usage) {
  const name = options.positionals[1];
  if (!name) throw new Error(`Usage: ${usage}`);
  return name;
}

/** @type {Record<string, (options: Options, deps: Deps) => number>} */
export const COMMANDS = {
  help(_options, deps) {
    deps.log(HELP);
    return 0;
  },

  list(options, deps) {
    const registry = readRegistry(deps.rootDir);
    if (options.kind && !KINDS.includes(options.kind)) {
      throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
    }
    const shown = options.kind
      ? {
          ...registry,
          tools: registry.tools.filter((t) => t.kind === options.kind),
        }
      : registry;
    const catalog = deps
      .catalog()
      .filter((t) => !options.kind || t.kind === options.kind);
    const known = new Set(registry.tools.map((t) => t.name));
    output(
      deps,
      options,
      {
        ...shown,
        missing: catalog.filter((t) => !known.has(t.name)).map((t) => t.name),
        sources: sourcesDir(deps.probe.env),
      },
      formatList({
        registry: shown,
        catalog,
        all: options.all,
        sources: sourcesDir(deps.probe.env),
        platform: deps.probe.platform,
      })
    );
    return 0;
  },

  scan(options, deps) {
    const now = deps.now();
    const current = options.reset
      ? emptyRegistry()
      : readRegistry(deps.rootDir);
    const found = deps
      .catalog()
      .map((tool) => probeTool(tool, deps.probe, now))
      .filter((entry) => entry !== null);
    const { tools, added, removed } = mergeScan(current.tools, found);
    const registry = writeRegistry(deps.rootDir, { ...current, tools }, now);
    output(
      deps,
      options,
      { ok: true, added, removed, tools: registry.tools },
      [
        `Recorded ${registry.tools.length} tool(s) in ${LOCAL_FILE}: ${registry.tools.map((t) => `${t.name}${t.ok ? '' : ' (broken)'}`).join(', ') || 'none'}.`,
        added.length > 0 ? `New: ${added.join(', ')}.` : '',
        removed.length > 0 ? `No longer found: ${removed.join(', ')}.` : '',
        'Not on PATH (npx-only, source checkouts): pnpm tools add <name> … · details: pnpm tools list',
      ]
        .filter(Boolean)
        .join('\n')
    );
    return 0;
  },

  check(options, deps) {
    const registry = readRegistry(deps.rootDir);
    if (registry.tools.length === 0) {
      throw new Error('No tools recorded yet.\nFix: pnpm tools scan');
    }
    const catalog = deps.catalog();
    const tools = registry.tools.map((entry) =>
      recheck(
        entry,
        catalog.find((t) => t.name === entry.name),
        deps
      )
    );
    writeRegistry(deps.rootDir, { ...registry, tools }, deps.now());
    const broken = tools.filter((t) => !t.ok);
    output(
      deps,
      options,
      { ok: broken.length === 0, tools },
      [
        ...tools.map(
          (t) =>
            `${t.ok ? '✓' : '✗'} ${t.name}${t.version ? ` ${t.version}` : ''}`
        ),
        ...broken.map((t) => {
          const hint = installHint(
            catalog.find((c) => c.name === t.name),
            deps.probe.platform
          );
          return `Fix ${t.name}: ${hint ? `${hint} — ` : ''}or forget it: pnpm tools remove ${t.name}`;
        }),
      ].join('\n')
    );
    return broken.length === 0 ? 0 : 1;
  },

  show(options, deps) {
    const name = requireName(options, 'pnpm tools show <name>');
    const entry =
      readRegistry(deps.rootDir).tools.find((t) => t.name === name) ?? null;
    const tool = deps.catalog().find((t) => t.name === name);
    if (!entry && !tool) {
      throw new Error(
        `Unknown tool "${name}".\nFix: pnpm tools list --all (or record it: pnpm tools add ${name} --kind … --path …)`
      );
    }
    output(
      deps,
      options,
      { name, entry, catalog: tool ?? null },
      formatShow({ name, entry, tool, platform: deps.probe.platform })
    );
    return 0;
  },

  add(options, deps) {
    const name = requireName(
      options,
      'pnpm tools add <name> --kind agent|cli|runtime|source (--path <p> | --command "<cmd>")'
    );
    if (!TOOL_NAME_RE.test(name)) {
      throw new Error(
        `Invalid tool name "${name}": use lowercase a-z, 0-9, . _ -`
      );
    }
    const tool = deps.catalog().find((t) => t.name === name);
    const kind = options.kind ?? tool?.kind;
    if (!kind || !KINDS.includes(kind)) {
      throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
    }
    if (!options.path && !options.command) {
      throw new Error(
        `Tell me where ${name} is: --path <executable or directory>, or --command "<how to run it>"`
      );
    }
    if (kind === 'source' && !options.path) {
      throw new Error(
        `A source checkout needs --path <directory> (default home: ${sourcesDir(deps.probe.env)}/${name})`
      );
    }
    const resolved = options.path ? path.resolve(options.path) : null;
    if (resolved && !fs.existsSync(resolved)) {
      throw new Error(
        `${resolved} does not exist.\nFix: check the path, or install ${name} first`
      );
    }
    /** @type {ToolEntry} */
    const draft = {
      name,
      kind: /** @type {import('./registry.js').ToolKind} */ (kind),
      path: resolved,
      ...(options.command ? { command: options.command.trim() } : {}),
      version: null,
      ...(options.via ? { via: options.via } : {}),
      source: 'manual',
      ok: false,
      checkedAt: deps.now().toISOString(),
      ...(options.check ? { check: options.check.trim().split(/\s+/) } : {}),
      ...((options.headless ?? tool?.headless)
        ? { headless: options.headless ?? tool?.headless }
        : {}),
      ...((options.env ?? tool?.env)
        ? {
            env: options.env
              ? options.env
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean)
              : tool?.env,
          }
        : {}),
      ...(options.notes ? { notes: options.notes } : {}),
      ...((options.task ?? currentTask(deps.rootDir))
        ? {
            task:
              options.task ?? /** @type {string} */ (currentTask(deps.rootDir)),
          }
        : {}),
    };
    const entry = recheck(draft, tool, deps);
    const registry = readRegistry(deps.rootDir);
    const replaced = registry.tools.some((t) => t.name === name);
    writeRegistry(
      deps.rootDir,
      {
        ...registry,
        tools: [...registry.tools.filter((t) => t.name !== name), entry],
      },
      deps.now()
    );
    output(
      deps,
      options,
      { ok: entry.ok, entry },
      `${replaced ? 'Updated' : 'Recorded'} ${name} in ${LOCAL_FILE}: ${entry.ok ? 'working' : 'check failed'}${entry.version ? ` (${entry.version})` : ''}.${entry.ok ? '' : `\nFix: verify it runs, e.g. ${(checkArgv(entry, tool) ?? [entry.command ?? entry.path]).join(' ')}`}`
    );
    return 0;
  },

  remove(options, deps) {
    const name = requireName(options, 'pnpm tools remove <name>');
    const registry = readRegistry(deps.rootDir);
    if (!registry.tools.some((t) => t.name === name)) {
      throw new Error(`${name} is not recorded.\nFix: pnpm tools list`);
    }
    writeRegistry(
      deps.rootDir,
      { ...registry, tools: registry.tools.filter((t) => t.name !== name) },
      deps.now()
    );
    output(
      deps,
      options,
      { ok: true, removed: name },
      `Forgot ${name} (nothing was uninstalled).`
    );
    return 0;
  },

  sources(options, deps) {
    const dir = sourcesDir(deps.probe.env);
    output(deps, options, { sources: dir }, dir);
    return 0;
  },
};

/**
 * The registry hooks `pnpm workspace:setup` uses: a quiet scan, and readers.
 *
 * @param {string} rootDir
 * @param {Partial<Deps>} [deps]
 * @returns {import('../workspace-setup.js').ToolsDeps}
 */
export function setupTools(rootDir, deps = {}) {
  const resolved = defaultDeps({ rootDir, log: () => {}, ...deps });
  return {
    scan: () => {
      COMMANDS.scan(parseArgs(['scan']), resolved);
    },
    registry: () => readRegistry(rootDir),
    catalog: () => resolved.catalog(),
  };
}

/**
 * @param {{ argv?: string[], deps?: Partial<Deps> }} [options]
 * @returns {number}
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const resolved = defaultDeps(deps);
  const options = parseArgs(argv);
  const command = options.positionals[0] ?? 'list';
  if (options.help || command === 'help') {
    return COMMANDS.help(options, resolved);
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`Unknown command "${command}". Run: pnpm tools help`);
  }
  return COMMANDS[command](options, resolved);
}

/* c8 ignore next 8 - CLI entry point */
runIfMain(import.meta.url, () => {
  try {
    process.exit(main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
