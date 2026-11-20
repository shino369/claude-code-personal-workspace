#!/usr/bin/env node
/**
 * `pnpm memory <command>` — the memory CLI shared by every agent and the
 * user (design §10). Notes live in memory/ (gitignored). Every write refuses
 * secrets, then re-renders the core block in AGENTS.local.md and warms the
 * search index, so hooks stay on the fast path. Run `pnpm memory help`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAgent } from '../loop/adapters.js';
import {
  applyImport,
  exportArchive,
  formatExport,
  formatImport,
  parseParts,
  planImport,
  readArchive,
} from './archive.js';
import { runIfMain } from '../module-runner.js';
import { SESSION_ID_RE, sessionFromEnv } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readConfig, savingOff, setSaving, writeConfig } from './config.js';
import {
  consolidate,
  consolidateLocked,
  consolidationDue,
  readConsolidated,
} from './consolidate.js';
import {
  ANNOUNCE_CHARS,
  announceSave,
  kindLabel,
  refreshAfterWrite,
  shorten,
  taskContext,
  writerSource,
} from './context.js';
import {
  defaultExtractDeps,
  extractEntry,
  formatRun,
  runWorker,
} from './extract.js';
import {
  listPresets,
  readPersonalization,
  readPreset,
  renderPersonalization,
  writePersonalization,
} from './personalize.js';
import {
  clearInbox,
  enqueue,
  readInbox,
  readJournal,
  readOpen,
  readQueue,
  registerOpen,
  workerRunning,
} from './queue.js';
import { RECALL_LIMIT, loadIndex, noteLabels, recall } from './recall.js';
import { formatUndo, undoLast } from './undo.js';
import {
  AGENTS_LOCAL_FILE,
  CLAUDE_LOCAL_FILE,
  CORE_BUDGET,
  initLocal,
  renderStored,
} from './render.js';
import { mainCheckout, repoName } from './repo.js';
import {
  MemoryError,
  SCOPES,
  TYPES,
  addNote,
  checkNote,
  deleteNote,
  isStale,
  loadNotes,
  memoryDir,
  noteHistory,
  readLog,
  readUsage,
  setPinned,
  updateNote,
} from './store.js';

export const HELP = `Usage: pnpm memory [command] [options]

Status
  status                        (the default) Notes, core block size, personalization,
                                saving on/off, warnings
  init                          Create memory/, AGENTS.local.md, CLAUDE.local.md (idempotent)

Save and change
  add "<text>" --scope user|machine|repo --type preference|fact|howto|episode
      [--repo <name|path>] [--tags a,b] [--trigger "<pattern>"]… [--pin] [--force]
                                Save a note and print its id. Secrets are refused; a
                                near-duplicate is merged into the old note. A repo note
                                defaults to the current repository (the task's --repo, else
                                this folder). --force saves while saving is off
  edit <id> ["<text>"] [--tags a,b] [--trigger "…"]… [--type …] [--scope …] [--repo …]
                                Change a note (--tags and --trigger replace the old lists)
  rm <id> -m "why"              Delete a note (it stays in the journal)
  pin <id> · unpin <id>         Pinned notes are in every session's core block
  check <id>                    Mark a note confirmed today (no longer stale)

Find
  recall "<query>" [--scope …] [--repo …] [--limit N] [--failure]
                                Search like the hooks do (--failure: the query is an error)
  list [--scope …] [--type …] [--repo …] [--pinned] [--stale] [--all]
                                Browse notes (--all includes deleted ones)
  show <id>                     A note with its source and history
  history [--grep "…"] [--limit N]
                                The journal of changes, oldest first (default: the last 20)

Extraction (automatic after each Claude Code session)
  extract [<session>] [--dry-run]
                                Extract notes from the queued sessions now (the worker
                                normally does this in the background). <session> extracts
                                a session that is still open; --dry-run prints what would
                                be sent to the model and changes nothing
  inbox [--reset]               Changes extraction held back for you to review (they read
                                like instructions); --reset clears the list
  consolidate [--dry-run]       Tidy the notes and rewrite the profile now (normally weekly,
                                in the background)
  undo [--dry-run]              Revert the last extraction, consolidation, or import, one
                                per call (notes saved since are kept)

Move or back up (an explicit step; nothing is synced)
  export [--include memory,personalization,tasks,resources] [--tasks a,b] [--out <file>]
      [--allow-secrets]           Write a .tar.gz with a checksummed manifest (default:
                                memory,personalization to memory-export-<yymmdd>.tar.gz).
                                Files that look like they hold secrets stop the export
  import <file> [--include …] [--dry-run] [--replace]
                                Validate the archive (paths, links, checksums) before
                                anything is written, then merge: new ids, other machines'
                                notes unchecked, duplicates skipped, your settings, tasks,
                                and resources kept. --replace takes over the store and
                                settings; a snapshot is taken first

Settings
  personalize [--preset <name>] [--call-me …] [--about-me …] [--language …]
      [--persona …] [--tone <text|preset>] [--traits a,b] [--extra …] [--reset]
                                How agents talk to you (conversation only); without
                                flags, shows the settings. --presets lists the presets;
                                an empty value clears a field
  set [--extract-model <model>|default] [--budget <characters>|default]
                                Extraction model and core block budget
  off [--session] · on [--session]
                                Pause automatic saving everywhere, or for this session
                                (incognito); recall still works

Options
  --json          Machine-readable output
  --help          Show this help`;

const VALUE_FLAGS = {
  '--scope': 'scope',
  '--repo': 'repo',
  '--type': 'type',
  '--tags': 'tags',
  '--trigger': 'triggers',
  '--limit': 'limit',
  '--grep': 'grep',
  '--message': 'message',
  '-m': 'message',
  '--preset': 'preset',
  '--call-me': 'callMe',
  '--about-me': 'aboutMe',
  '--language': 'language',
  '--persona': 'persona',
  '--tone': 'tone',
  '--traits': 'traits',
  '--extra': 'extra',
  '--extract-model': 'extractModel',
  '--budget': 'budget',
  '--include': 'include',
  '--tasks': 'tasks',
  '--out': 'out',
};
const REPEATABLE = new Set(['triggers']);
const BOOLEAN_FLAGS = {
  '--pin': 'pin',
  '--force': 'force',
  '--failure': 'failure',
  '--pinned': 'pinned',
  '--stale': 'stale',
  '--all': 'all',
  '--reset': 'reset',
  '--show': 'show',
  '--presets': 'presets',
  '--session': 'session',
  '--dry-run': 'dryRun',
  '--allow-secrets': 'allowSecrets',
  '--replace': 'replace',
  '--json': 'json',
  '--help': 'help',
  '-h': 'help',
};
/** Personalization fields settable by flag, in display order. */
const FIELD_FLAGS = /** @type {const} */ ([
  'callMe',
  'aboutMe',
  'language',
  'persona',
  'tone',
  'traits',
  'extra',
]);

const LIST_CHARS = 100;
const HISTORY_CHARS = 80;
const MAX_RECALL = 20;
const HISTORY_LIMIT = 20;
const MAX_HISTORY = 1000;
const FIRST_NOTE =
  'pnpm memory add "<text>" --scope user|machine|repo --type preference|fact|howto|episode';

/**
 * @typedef {{
 *   positionals: string[],
 *   scope?: string, repo?: string, type?: string, tags?: string, limit?: string,
 *   grep?: string, message?: string, preset?: string, callMe?: string,
 *   aboutMe?: string, language?: string, persona?: string, tone?: string,
 *   traits?: string, extra?: string, extractModel?: string, budget?: string,
 *   include?: string, tasks?: string, out?: string,
 *   triggers: string[],
 *   pin: boolean, force: boolean, failure: boolean, pinned: boolean,
 *   stale: boolean, all: boolean, reset: boolean, show: boolean,
 *   presets: boolean, session: boolean, dryRun: boolean,
 *   allowSecrets: boolean, replace: boolean, json: boolean, help: boolean,
 * }} Options
 *
 * @typedef {{
 *   rootDir: string,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   now: () => Date,
 *   log: (message: string) => void,
 *   runAgent: typeof runAgent,
 *   machine: string,
 * }} Deps
 *
 * @typedef {import('./store.js').Note} Note
 * @typedef {import('./store.js').Op} Op
 * @typedef {import('./store.js').Source} Source
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    positionals: [],
    triggers: [],
    pin: false,
    force: false,
    failure: false,
    pinned: false,
    stale: false,
    all: false,
    reset: false,
    show: false,
    presets: false,
    session: false,
    dryRun: false,
    allowSecrets: false,
    replace: false,
    json: false,
    help: false,
  };
  const record = /** @type {Record<string, unknown>} */ (options);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(VALUE_FLAGS, flag)) {
      const key = VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)];
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (REPEATABLE.has(key))
        /** @type {string[]} */ (record[key]).push(value);
      else record[key] = value;
    } else if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      record[BOOLEAN_FLAGS[/** @type {keyof typeof BOOLEAN_FLAGS} */ (flag)]] =
        true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option: ${arg} (see pnpm memory help)`);
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
  const env = overrides.env ?? process.env;
  return {
    // Worktrees (pnpm loop, swarm) share the main checkout's store.
    rootDir: mainCheckout(ROOT_DIR),
    // pnpm runs scripts from the workspace root; INIT_CWD is where it ran.
    cwd: env.INIT_CWD ?? process.cwd(),
    env,
    now: () => new Date(),
    log: console.log,
    runAgent,
    machine: os.hostname(),
    ...overrides,
  };
}

/** @param {Deps} deps */
const dirOf = (deps) => memoryDir(deps.rootDir);

/**
 * @param {number} n
 * @param {string} word
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A comma list (`,`, `、`, or `，`), trimmed, without empty items.
 *
 * @param {string} value
 */
const splitList = (value) =>
  value
    .split(/[,、，]/)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * @param {string} text
 * @param {string[]} warnings
 */
const withWarnings = (text, warnings) =>
  [text, ...warnings.map((warning) => `Warning: ${warning}`)].join('\n');

/** @param {string[]} problems */
const badLines = (problems) =>
  `the log has ${plural(problems.length, 'bad line')}: ${problems.join('; ')}`;

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
 * @param {Note} note
 * @param {Date} now
 */
const headLabels = (note, now) =>
  [noteLabels(note, now), ...(note.pinned ? ['pinned'] : [])].join(', ');

/**
 * `2026-11-20 14:03` in local time; the input when it is not a time.
 *
 * @param {string} iso
 */
function localTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One held change in the inbox: time, op, id, what, and why it was held.
 *
 * @param {Record<string, any>} item
 */
function heldLine(item) {
  const id = typeof item.id === 'string' ? ` ${item.id}` : '';
  const what =
    item.note?.text ??
    item.why ??
    item.changes?.text ??
    JSON.stringify(item.changes);
  return `- ${localTime(String(item.at))} ${item.op}${id}: ${what} (${item.reason})`;
}

/**
 * One journal line: time, op, id, and what changed.
 *
 * @param {Op} op
 */
function historyLine(op) {
  const time = typeof op.at === 'string' ? localTime(op.at) : '?';
  const id = (op.op === 'add' ? op.note?.id : op.id) ?? '?';
  const name = op.op === 'pin' && op.pinned !== true ? 'unpin' : op.op;
  const head = `- ${time} ${name} ${id}`;
  if (op.op === 'add' && op.note) {
    const note = /** @type {any} */ (op.note);
    return `${head} (${kindLabel(note)}): ${shorten(String(note.text), HISTORY_CHARS)}`;
  }
  if (op.op === 'update' && op.set)
    return `${head}: ${Object.keys(op.set).join(', ')}`;
  if (op.op === 'delete' && op.why) return `${head}: ${op.why}`;
  return head;
}

/**
 * A --repo value: a path (it has a slash, or starts with . or ~) names the
 * repository there; anything else is the name itself.
 *
 * @param {Deps} deps
 * @param {string} value
 * @returns {string}
 */
function repoArg(deps, value) {
  if (!/[\\/]/.test(value) && !/^[.~]/.test(value)) return value;
  const home = /^~(?=$|[\\/])/.test(value);
  const dir = path.resolve(
    deps.cwd,
    home ? path.join(os.homedir(), value.slice(1)) : value
  );
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`--repo ${value}: no such folder (${dir}).`);
  }
  const name = repoName(dir);
  if (!name) {
    throw new Error(
      `--repo ${value}: ${dir} is not in a git repository.\nFix: pass the repository's name, or a folder inside it`
    );
  }
  return name;
}

/**
 * The repo of a note being written with `scope`: --repo when given (the
 * store refuses it for other scopes), the current repository for a repo
 * note, else null.
 *
 * @param {Deps} deps
 * @param {Options} options
 * @param {string} scope
 * @returns {string | null}
 */
function noteRepo(deps, options, scope) {
  if (options.repo !== undefined) return repoArg(deps, options.repo);
  if (scope !== 'repo') return null;
  const name = taskContext({
    rootDir: deps.rootDir,
    session: sessionFromEnv(deps.env),
    cwd: deps.cwd,
  }).repo;
  if (!name) {
    throw new Error(
      'Not in a git repository, so the repo is unknown.\nFix: add --repo <name> (or a path to the repository)'
    );
  }
  return name;
}

/**
 * @param {string | undefined} value
 * @param {readonly string[]} allowed
 * @param {string} label
 * @returns {string | undefined}
 */
function oneOf(value, allowed, label) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(
      `Unknown ${label} "${value}"; use one of: ${allowed.join(', ')}.`
    );
  }
  return value;
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} max
 */
function parseLimit(value, fallback, max) {
  if (value === undefined) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : 0;
  if (n < 1 || n > max) {
    throw new Error(`--limit must be a whole number from 1 to ${max}.`);
  }
  return n;
}

/**
 * @param {Options} options
 * @param {string} command
 * @param {string} [hint]
 */
function needId(options, command, hint = '') {
  const id = options.positionals[1];
  if (!id)
    throw new Error(`Give a note id: pnpm memory ${command} <id>${hint}`);
  return id;
}

/** @param {Deps} deps */
function needSession(deps) {
  const session = sessionFromEnv(deps.env);
  if (!session) {
    throw new Error(
      'No session id: set TASK_SESSION, or run this inside Claude Code.'
    );
  }
  return session;
}

/**
 * Print a changed note with the refresh warnings.
 *
 * @param {Deps} deps
 * @param {Options} options
 * @param {Note} note
 * @param {string} text
 */
function reportChange(deps, options, note, text) {
  const warnings = refreshAfterWrite(deps.rootDir);
  output(deps, options, { note, warnings }, withWarnings(text, warnings));
  return 0;
}

/** @type {Record<string, (options: Options, deps: Deps) => number>} */
export const COMMANDS = {
  help(_options, deps) {
    deps.log(HELP);
    return 0;
  },

  extract(options, deps) {
    const dir = dirOf(deps);
    if (!fs.existsSync(dir)) {
      throw new Error('Memory is not set up. Fix: pnpm memory init');
    }
    const extractDeps = defaultExtractDeps({
      rootDir: deps.rootDir,
      env: deps.env,
      now: deps.now,
      runAgent: deps.runAgent,
      dryRun: options.dryRun,
    });
    const session = options.positionals[1];
    let entries = readQueue(dir);
    if (session !== undefined) {
      if (!SESSION_ID_RE.test(session)) {
        throw new Error(`Invalid session id "${session}".`);
      }
      const open = readOpen(dir).find((item) => item.session === session);
      const known =
        open ?? entries.find((item) => item.session === session) ?? null;
      if (!known) {
        throw new Error(
          `No transcript is known for session ${session}: only Claude Code sessions that started after pnpm memory init are recorded (pnpm memory status).`
        );
      }
      entries = [known];
      if (!options.dryRun) {
        enqueue(dir, { ...known, at: deps.now().toISOString() });
        // Still running: keep it open, so its end (or a crash) is caught.
        if (open) registerOpen(dir, open);
      }
    }
    const runs = options.dryRun
      ? entries.map((item) => extractEntry(item, extractDeps))
      : runWorker(extractDeps);
    if (runs === null) {
      output(
        deps,
        options,
        { running: true, runs: [] },
        'An extraction is already running; it will take the queue.'
      );
      return 0;
    }
    output(
      deps,
      options,
      { runs },
      runs.length === 0
        ? 'Nothing to extract: the queue is empty.'
        : runs.flatMap(formatRun).join('\n')
    );
    return runs.some((run) => run.status === 'failed') ? 1 : 0;
  },

  export(options, deps) {
    const parts = parseParts(options.include);
    const tasks = options.tasks === undefined ? [] : splitList(options.tasks);
    if (tasks.length > 0 && !parts.includes('tasks')) {
      throw new Error(
        '--tasks needs the tasks part. Fix: --include memory,personalization,tasks'
      );
    }
    const now = deps.now();
    const day = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const out = path.resolve(
      deps.cwd,
      options.out ?? `memory-export-${day}.tar.gz`
    );
    const result = exportArchive(deps.rootDir, {
      parts,
      tasks,
      out,
      allowSecrets: options.allowSecrets,
      now,
      machine: deps.machine,
    });
    output(deps, options, result, formatExport(result, deps.cwd).join('\n'));
    return 0;
  },

  import(options, deps) {
    const file = options.positionals[1];
    if (!file) {
      throw new Error(
        'Name the archive: pnpm memory import <file> [--dry-run]'
      );
    }
    const archive = readArchive(path.resolve(deps.cwd, file));
    const include =
      options.include === undefined ? null : parseParts(options.include);
    const plan = planImport(deps.rootDir, archive, {
      include,
      replace: options.replace,
    });
    const result = options.dryRun
      ? null
      : applyImport(deps.rootDir, archive, plan, {
          now: deps.now(),
          detail: path.basename(file),
          replace: options.replace,
        });
    const { files: _files, ...manifest } = archive.manifest;
    output(
      deps,
      options,
      {
        manifest,
        plan: {
          ...plan,
          notes: plan.notes && { ...plan.notes, add: plan.notes.add.length },
          instructionsText: undefined,
        },
        result,
      },
      formatImport({ file, manifest: archive.manifest, plan, result }).join(
        '\n'
      )
    );
    return 0;
  },

  consolidate(options, deps) {
    if (!fs.existsSync(dirOf(deps))) {
      throw new Error('Memory is not set up. Fix: pnpm memory init');
    }
    const extractDeps = defaultExtractDeps({
      rootDir: deps.rootDir,
      env: deps.env,
      now: deps.now,
      runAgent: deps.runAgent,
      dryRun: options.dryRun,
    });
    const run = options.dryRun
      ? consolidate(extractDeps)
      : consolidateLocked(extractDeps);
    if (run === null) {
      output(
        deps,
        options,
        { running: true },
        'An extraction or consolidation is already running; try again in a moment.'
      );
      return 0;
    }
    output(deps, options, { run }, formatRun(run).join('\n'));
    return run.status === 'failed' ? 1 : 0;
  },

  undo(options, deps) {
    const result = undoLast(deps.rootDir, {
      now: deps.now(),
      dryRun: options.dryRun,
    });
    output(
      deps,
      options,
      { undone: result && { ...result, log: undefined } },
      formatUndo(result).join('\n')
    );
    return 0;
  },

  inbox(options, deps) {
    const dir = dirOf(deps);
    const items = readInbox(dir);
    if (options.reset) {
      clearInbox(dir);
      output(
        deps,
        options,
        { cleared: items.length },
        `Cleared ${plural(items.length, 'held change')} from the inbox.`
      );
      return 0;
    }
    output(
      deps,
      options,
      { items },
      items.length === 0
        ? 'The inbox is empty: extraction held nothing back.'
        : [
            `${plural(items.length, 'change')} held for review (save one yourself with pnpm memory add, edit, or rm; clear the list with pnpm memory inbox --reset):`,
            ...items.map(heldLine),
          ].join('\n')
    );
    return 0;
  },

  status(options, deps) {
    const dir = dirOf(deps);
    const now = deps.now();
    const { notes, problems } = loadNotes(dir);
    const active = notes.filter((note) => note.status === 'active');
    const counts = {
      active: active.length,
      scopes: Object.fromEntries(
        SCOPES.map((scope) => [
          scope,
          active.filter((note) => note.scope === scope).length,
        ])
      ),
      pinned: active.filter((note) => note.pinned).length,
      stale: active.filter((note) => isStale(note, now)).length,
      deleted: notes.length - active.length,
    };
    const core = renderStored(deps.rootDir);
    const warnings = [
      ...(problems.length > 0 ? [badLines(problems)] : []),
      ...core.warnings,
    ];
    const missing = [
      ['memory/', dir],
      [AGENTS_LOCAL_FILE, path.join(deps.rootDir, AGENTS_LOCAL_FILE)],
      [CLAUDE_LOCAL_FILE, path.join(deps.rootDir, CLAUDE_LOCAL_FILE)],
    ]
      .filter(([, file]) => !fs.existsSync(file))
      .map(([label]) => label);
    const off = savingOff(core.config, sessionFromEnv(deps.env));
    const saving =
      off === 'global'
        ? 'off everywhere'
        : off === 'session'
          ? 'off for this session'
          : 'on';
    const fields = Object.keys(core.personalization);
    const { extractModel } = core.config;
    const last = readJournal(dir).at(-1);
    const extraction = {
      queued: readQueue(dir).length,
      running: workerRunning(dir),
      lastRun: last ? { at: last.at, status: last.status } : null,
      inbox: readInbox(dir).length,
    };
    const consolidated = readConsolidated(dir);
    const consolidation = {
      last: consolidated?.at ?? null,
      due: consolidationDue(deps.rootDir, { now }),
    };
    const lastRun = extraction.running
      ? 'running now'
      : extraction.lastRun
        ? `last run ${localTime(String(extraction.lastRun.at))} (${extraction.lastRun.status})`
        : 'no run yet';
    const summary =
      notes.length === 0
        ? `Memory: no notes yet. Save one: ${FIRST_NOTE}`
        : `Memory: ${plural(counts.active, 'note')} (${SCOPES.map((scope) => `${scope} ${counts.scopes[scope]}`).join(', ')}); ${counts.pinned} pinned; ${counts.stale} stale; ${counts.deleted} deleted`;
    output(
      deps,
      options,
      {
        notes: counts,
        core: { chars: core.block.length, budget: core.budget },
        personalization: fields,
        saving,
        extractModel,
        extraction,
        consolidation,
        missing,
        warnings,
      },
      withWarnings(
        [
          summary,
          ...(missing.length > 0
            ? [`Not set up: ${missing.join(', ')}. Fix: pnpm memory init`]
            : []),
          `Core block: ${core.block.length}/${core.budget} characters (${AGENTS_LOCAL_FILE})`,
          `Personalization: ${fields.length > 0 ? fields.join(', ') : 'not set (pnpm memory personalize --presets)'}`,
          `Saving: ${saving}${off ? ' (pnpm memory on)' : ''}`,
          `Extraction model: ${extractModel ?? "the main session's model"}`,
          `Extraction: ${plural(extraction.queued, 'session')} queued; ${lastRun}`,
          `Consolidation: ${consolidation.last ? `last ${localTime(consolidation.last)}` : 'not yet'}${consolidation.due ? `; due (${consolidation.due})` : ''}`,
          ...(extraction.inbox > 0
            ? [
                `Inbox: ${plural(extraction.inbox, 'change')} held for review (pnpm memory inbox)`,
              ]
            : []),
        ].join('\n'),
        warnings
      )
    );
    return 0;
  },

  init(options, deps) {
    const result = initLocal(deps.rootDir);
    const lines = [
      ...(result.created.length > 0
        ? [`Created: ${result.created.join(', ')}`]
        : []),
      ...(result.updated.length > 0
        ? [`Updated: ${result.updated.join(', ')}`]
        : []),
    ];
    output(
      deps,
      options,
      result,
      withWarnings(
        lines.length > 0
          ? lines.join('\n')
          : 'Memory is set up; nothing to change.',
        result.warnings
      )
    );
    return 0;
  },

  add(options, deps) {
    const text = options.positionals.slice(1).join(' ').trim();
    if (!text) throw new Error(`Give the note text: ${FIRST_NOTE}`);
    if (!options.scope) {
      throw new Error('--scope is required: user, machine, or repo.');
    }
    if (!options.type) {
      throw new Error(
        '--type is required: preference, fact, howto, or episode.'
      );
    }
    const dir = dirOf(deps);
    const off = savingOff(readConfig(dir), sessionFromEnv(deps.env));
    if (off && !options.force) {
      throw new Error(
        `Saving to memory is off ${off === 'global' ? 'everywhere' : 'for this session'}, so nothing was saved.\nFix: pnpm memory on — or add --force if the user asked to save this`
      );
    }
    const { action, note } = addNote(
      dir,
      {
        text,
        scope: options.scope,
        repo: noteRepo(deps, options, options.scope),
        type: options.type,
        tags: splitList(options.tags ?? ''),
        triggers: options.triggers,
        source: writerSource({ env: deps.env, rootDir: deps.rootDir }),
        pinned: options.pin,
      },
      { now: deps.now() }
    );
    const warnings = refreshAfterWrite(deps.rootDir);
    output(
      deps,
      options,
      { action, note, warnings },
      withWarnings(announceSave({ action, note }), warnings)
    );
    return 0;
  },

  recall(options, deps) {
    const query = options.positionals.slice(1).join(' ').trim();
    if (!query) throw new Error('Give a query: pnpm memory recall "<query>"');
    const scope = oneOf(options.scope, SCOPES, 'scope');
    const limit = parseLimit(options.limit, RECALL_LIMIT, MAX_RECALL);
    const dir = dirOf(deps);
    const now = deps.now();
    const { notes, index } = loadIndex(dir);
    const results = recall(
      scope ? notes.filter((note) => note.scope === scope) : notes,
      query,
      {
        index,
        repo:
          options.repo !== undefined
            ? repoArg(deps, options.repo)
            : taskContext({
                rootDir: deps.rootDir,
                session: sessionFromEnv(deps.env),
                cwd: deps.cwd,
              }).repo,
        failure: options.failure,
        usage: readUsage(dir),
        now,
        limit,
      }
    );
    output(
      deps,
      options,
      results.map(({ note, score, matched }) => ({
        id: note.id,
        score: Math.round(score * 1000) / 1000,
        matched,
        note,
      })),
      results.length === 0
        ? `No notes match "${query}".`
        : results
            .map(
              ({ note }) =>
                `- ${note.id} (${noteLabels(note, now)}) ${note.text}`
            )
            .join('\n')
    );
    return 0;
  },

  list(options, deps) {
    const scope = oneOf(options.scope, SCOPES, 'scope');
    const type = oneOf(options.type, TYPES, 'type');
    const repo =
      options.repo !== undefined ? repoArg(deps, options.repo) : undefined;
    const now = deps.now();
    const { notes } = loadNotes(dirOf(deps));
    const shown = notes.filter(
      (note) =>
        (options.all || note.status === 'active') &&
        (!scope || note.scope === scope) &&
        (!type || note.type === type) &&
        (!repo || note.repo === repo) &&
        (!options.pinned || note.pinned) &&
        (!options.stale || isStale(note, now))
    );
    let text;
    if (notes.length === 0) text = `No notes yet. Save one: ${FIRST_NOTE}`;
    else if (shown.length === 0) text = 'No notes match these filters.';
    else {
      text = shown
        .map((note) => {
          const deleted =
            note.status === 'deleted'
              ? `, deleted ${note.deleted}: ${note.why}`
              : '';
          return `- ${note.id} (${headLabels(note, now)}${deleted}) ${shorten(note.text, LIST_CHARS)}`;
        })
        .join('\n');
    }
    output(deps, options, shown, text);
    return 0;
  },

  show(options, deps) {
    const id = needId(options, 'show');
    const dir = dirOf(deps);
    const note = loadNotes(dir).notes.find((item) => item.id === id);
    if (!note) {
      throw new MemoryError(
        'not-found',
        `No note ${id}. Run pnpm memory list to see the ids.`
      );
    }
    const history = noteHistory(dir, id);
    const { source } = note;
    const lines = [
      `${id} (${headLabels(note, deps.now())})`,
      note.text,
      ...(note.tags.length > 0 ? [`Tags: ${note.tags.join(', ')}`] : []),
      ...(note.triggers.length > 0
        ? [`Triggers: ${note.triggers.join(', ')}`]
        : []),
      `Source: ${[
        source.via,
        source.harness,
        source.session && `session ${source.session}`,
        source.task && `task ${source.task}`,
      ]
        .filter(Boolean)
        .join(', ')}`,
      `Created ${note.created}, updated ${note.updated}, checked ${note.checked ?? 'never'}`,
      ...(note.status === 'deleted'
        ? [`Deleted ${note.deleted}: ${note.why}`]
        : []),
      'History:',
      ...history.map(historyLine),
    ];
    output(deps, options, { note, history }, lines.join('\n'));
    return 0;
  },

  history(options, deps) {
    const limit = parseLimit(options.limit, HISTORY_LIMIT, MAX_HISTORY);
    const { ops, problems } = readLog(dirOf(deps));
    const needle = options.grep?.toLowerCase();
    const matched = needle
      ? ops.filter((op) => JSON.stringify(op).toLowerCase().includes(needle))
      : ops;
    const shown = matched.slice(-limit);
    const earlier = matched.length - shown.length;
    let text;
    if (matched.length === 0) {
      text = needle
        ? `No changes match "${options.grep}".`
        : 'No memory changes yet.';
    } else {
      text = [
        ...(earlier > 0
          ? [
              `… ${plural(earlier, 'earlier change')} (pnpm memory history --limit <n>)`,
            ]
          : []),
        ...shown.map(historyLine),
      ].join('\n');
    }
    output(
      deps,
      options,
      { ops: shown, problems },
      withWarnings(text, problems.length > 0 ? [badLines(problems)] : [])
    );
    return 0;
  },

  edit(options, deps) {
    const id = needId(options, 'edit');
    const text = options.positionals.slice(2).join(' ').trim();
    /** @type {Record<string, unknown>} */
    const changes = {};
    if (text) changes.text = text;
    if (options.tags !== undefined) changes.tags = splitList(options.tags);
    if (options.triggers.length > 0) changes.triggers = options.triggers;
    if (options.type !== undefined) changes.type = options.type;
    if (options.scope !== undefined) {
      changes.scope = options.scope;
      changes.repo = noteRepo(deps, options, options.scope);
    } else if (options.repo !== undefined) {
      changes.repo = repoArg(deps, options.repo);
    }
    if (Object.keys(changes).length === 0) {
      throw new Error(
        'Nothing to change: give new text, or --tags, --trigger, --type, --scope, --repo.'
      );
    }
    const note = updateNote(dirOf(deps), id, changes, {
      now: deps.now(),
      source: writerSource({ env: deps.env, rootDir: deps.rootDir }),
    });
    return reportChange(
      deps,
      options,
      note,
      `Edited ${id} (${kindLabel(note)}): ${shorten(note.text, ANNOUNCE_CHARS)}`
    );
  },

  rm(options, deps) {
    const id = needId(options, 'rm');
    const note = deleteNote(dirOf(deps), id, options.message ?? '', {
      now: deps.now(),
      source: writerSource({ env: deps.env, rootDir: deps.rootDir }),
    });
    return reportChange(
      deps,
      options,
      note,
      `Deleted ${id}: ${note.why} (kept in the journal: pnpm memory show ${id})`
    );
  },

  pin(options, deps) {
    const id = needId(options, 'pin');
    const note = setPinned(dirOf(deps), id, true, { now: deps.now() });
    return reportChange(
      deps,
      options,
      note,
      `Pinned ${id}: every session loads it (${AGENTS_LOCAL_FILE}).`
    );
  },

  unpin(options, deps) {
    const id = needId(options, 'unpin');
    const note = setPinned(dirOf(deps), id, false, { now: deps.now() });
    return reportChange(deps, options, note, `Unpinned ${id}.`);
  },

  check(options, deps) {
    const id = needId(
      options,
      'check',
      ' (stale notes: pnpm memory list --stale)'
    );
    const note = checkNote(dirOf(deps), id, { now: deps.now() });
    return reportChange(deps, options, note, `Checked ${id}: confirmed today.`);
  },

  personalize(options, deps) {
    const dir = dirOf(deps);
    if (options.presets) {
      const presets = listPresets();
      output(
        deps,
        options,
        { presets },
        presets
          .map((preset) => `- ${preset.name}: ${preset.description}`)
          .join('\n')
      );
      return 0;
    }
    const fields = FIELD_FLAGS.filter((key) => options[key] !== undefined);
    if (!options.reset && options.preset === undefined && fields.length === 0) {
      const settings = readPersonalization(dir);
      output(
        deps,
        options,
        { settings },
        renderPersonalization(settings) ||
          'No personalization set. Start from a preset: pnpm memory personalize --preset <name> (list: --presets), or set fields such as --call-me "<name>".'
      );
      return 0;
    }
    /** @type {Record<string, unknown>} */
    const settings =
      options.preset !== undefined
        ? readPreset(options.preset)
        : options.reset
          ? {}
          : readPersonalization(dir);
    const presetNames = listPresets().map((preset) => preset.name);
    for (const key of fields) {
      const value = /** @type {string} */ (options[key]);
      if (key === 'traits') settings.traits = splitList(value);
      else if (key === 'tone') {
        // A preset's name picks that preset's tone.
        settings.tone = presetNames.includes(value)
          ? readPreset(value).tone
          : value;
      } else settings[key] = value;
    }
    const written = writePersonalization(dir, settings);
    const warnings = refreshAfterWrite(deps.rootDir);
    output(
      deps,
      options,
      { settings: written, warnings },
      withWarnings(
        renderPersonalization(written) || 'Personalization cleared.',
        warnings
      )
    );
    return 0;
  },

  set(options, deps) {
    const dir = dirOf(deps);
    let config = readConfig(dir);
    if (options.extractModel !== undefined) {
      config = {
        ...config,
        extractModel:
          options.extractModel === 'default' ? null : options.extractModel,
      };
    }
    if (options.budget !== undefined) {
      const { budget } = options;
      if (budget !== 'default' && !/^\d+$/.test(budget)) {
        throw new Error('--budget takes a number of characters, or default.');
      }
      config = {
        ...config,
        budget: budget === 'default' ? null : Number(budget),
      };
    }
    /** @type {string[]} */
    let warnings = [];
    if (options.extractModel !== undefined || options.budget !== undefined) {
      config = writeConfig(dir, config);
      warnings = refreshAfterWrite(deps.rootDir);
    }
    output(
      deps,
      options,
      { config, warnings },
      withWarnings(
        [
          `Extraction model: ${config.extractModel ?? "the main session's model"}`,
          `Core budget: ${config.budget ?? CORE_BUDGET} characters${config.budget === null ? ' (default)' : ''}`,
        ].join('\n'),
        warnings
      )
    );
    return 0;
  },

  off(options, deps) {
    const dir = dirOf(deps);
    const session = options.session ? needSession(deps) : null;
    writeConfig(dir, setSaving(readConfig(dir), false, session));
    output(
      deps,
      options,
      { saving: session ? 'off for this session' : 'off everywhere' },
      `Saving to memory is off ${session ? `for this session (${session})` : 'everywhere'}. Recall still works. Turn it back on: pnpm memory on`
    );
    return 0;
  },

  on(options, deps) {
    const dir = dirOf(deps);
    const session = options.session
      ? needSession(deps)
      : sessionFromEnv(deps.env);
    const config = writeConfig(
      dir,
      setSaving(readConfig(dir), true, session, {
        sessionOnly: options.session,
      })
    );
    const stillOff = savingOff(config, session) === 'global';
    output(
      deps,
      options,
      { saving: stillOff ? 'off everywhere' : 'on' },
      stillOff
        ? 'Saving is on for this session, but still off everywhere: pnpm memory on'
        : 'Saving to memory is on.'
    );
    return 0;
  },
};

/**
 * @param {{ argv?: string[], deps?: Partial<Deps> }} [options]
 * @returns {number}
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  const resolved = defaultDeps(deps);
  const options = parseArgs(argv);
  const command = options.positionals[0] ?? 'status';
  if (options.help || command === 'help') {
    return COMMANDS.help(options, resolved);
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`Unknown command "${command}". Run: pnpm memory help`);
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
