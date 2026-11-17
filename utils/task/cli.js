#!/usr/bin/env node
/**
 * `pnpm task <command>` — the task protocol CLI shared by every harness.
 *
 * Task state lives in `tasks/<name-yymmdd>/state.json` and is changed only
 * through this CLI; plan.md (human-readable) and NOTES.md (append-only log)
 * sit next to it. Run `pnpm task help` for commands.
 */
import fs from 'fs';
import path from 'path';
import { runIfMain } from '../module-runner.js';
import {
  formatBrief,
  formatNoActiveBrief,
  statusLabel,
  summarizeTask,
} from './brief.js';
import { defaultDeps } from './deps.js';
import { formatGit } from './git.js';
import {
  appendSeparator,
  formatLocal,
  formatNoteEntry,
  parsePlan,
  renderTemplate,
} from './markdown.js';
import {
  E2E_MODES,
  STEP_STATUSES,
  TASK_KINDS,
  addStep,
  claimStep,
  createState,
  idleReason,
  makeSteps,
  nextStep,
  setStepStatus,
  taskDirName,
  TASK_NAME_RE,
  DATE_SUFFIX_RE,
} from './state.js';
import {
  STATE_FILE,
  appendNotes,
  listTaskNames,
  loadTask,
  readActive,
  resolveTaskName,
  saveState,
  scaffoldTask,
  tasksRoot,
  updateState,
  writeActive,
} from './store.js';
import { formatCheck, withCheck } from './check.js';
import { FRESH_LOOP, parseMax } from './loop.js';
import { countFindings, freshQuality, toFix } from './quality.js';
import {
  findingsTemplate,
  fingerprint,
  formatReviewBrief,
  openRound,
  parseFindings,
  recordFindings,
  reviewBase,
  reviewFiles,
  reviewScope,
} from './review.js';
import { summarize, tail } from './verify.js';
import { relPosix } from '../paths.js';

export const HELP = `Usage: pnpm task <command> [options]

Start / resume
  status [name]                 Resume brief: goal, next step, last notes, verify, git
  list [--all]                  Tasks with status and next step (--all includes done)
  switch <name>                 Make <name> the active task
  new <name> --goal "…"         Create tasks/<name>-<yymmdd>/ and make it active
      [--acceptance "…"] [--step "…"]… [--verify "cmd"]… [--verify-fast "cmd"]…
      [--kind code|general] [--e2e required|no]
                                --kind code (the default when --verify is given): the
                                inner loop starts on and pnpm task check runs before verify
  init [name] [--goal "…"] [--verify "cmd"]… [--kind …] [--e2e …]
                                Add state.json to a hand-written task (steps from plan.md)

Work
  next                          Print the next ready step
  claim [id]                    Atomically take the next ready step (or <id>) for --agent;
                                exit 2 when nothing is ready (prints why)
  step add "title" [--deps s1,s2]
  step <id> start|done|blocked|todo [-m "…"] [--force]
                                Update a step (blocked needs -m "reason"; todo releases a
                                claim; --force takes over a step another agent claimed)
  note --done "…" --next "…" [--open "…"] [-m "…"]
                                Append a NOTES.md entry (State line is filled in for you)
  check [--fix]                 Lint (ESLint), format-check (Prettier), and typecheck (tsc)
                                the task's code; --fix rewrites what ESLint/Prettier can fix
  verify [--fast] [--no-check]  Run the task's verify commands; exit 1 on failure. Tasks
                                with code run pnpm task check first (--no-check skips it)
  set [--goal "…"] [--verify "cmd"]… [--verify-fast "cmd"]…
                                Change the goal or replace the verify command lists
  set --kind code|general [--e2e required|no]
                                Change the task kind (code turns the loop on) or e2e mode
  set --loop on|off [--loop-max N]
                                Inner loop (Claude Stop hook): keep working until the
                                fast verify passes, at most N times (default 5)
  review [--base <ref>] [--force]
                                Code tasks: open the next review round (max 2) and write the
                                brief + findings file for clean-context reviewers. Scope: the
                                task's code, else git changes since --base (default: the
                                commit the task started from, else main)
  review record [file]          Read the triaged findings table; CONFIRMED must-fix/high
                                findings become fix: steps
  template review|study [--name <kebab>]
                                Copy a REVIEW_/STUDIES_ template into the task
  done [-m "…"] [--force]       Close the task (needs every step done and a passing verify;
                                code tasks also a finished review loop; --force overrides)

Options
  --task <name>   Act on <name> instead of the active task
  --agent <name>  Who is acting (default: $TASK_AGENT, "claude" in Claude Code, else "agent")
  --json          Machine-readable output
  --help          Show this help`;

const VALUE_FLAGS = {
  '--goal': 'goal',
  '--acceptance': 'acceptance',
  '--step': 'step',
  '--verify': 'verify',
  '--verify-fast': 'verifyFast',
  '--deps': 'deps',
  '--message': 'message',
  '-m': 'message',
  '--done': 'done',
  '--next': 'next',
  '--open': 'open',
  '--agent': 'agent',
  '--task': 'task',
  '--name': 'name',
  '--loop': 'loop',
  '--loop-max': 'loopMax',
  '--kind': 'kind',
  '--e2e': 'e2e',
  '--base': 'base',
};
const REPEATABLE = new Set(['step', 'verify', 'verifyFast']);
const BOOLEAN_FLAGS = {
  '--json': 'json',
  '--fast': 'fast',
  '--all': 'all',
  '--force': 'force',
  '--fix': 'fix',
  '--no-check': 'noCheck',
  '--help': 'help',
  '-h': 'help',
};

/**
 * @typedef {{
 *   positionals: string[],
 *   goal?: string, acceptance?: string, deps?: string, message?: string,
 *   done?: string, next?: string, open?: string, agent?: string, task?: string, name?: string,
 *   loop?: string, loopMax?: string, kind?: string, e2e?: string, base?: string,
 *   step: string[], verify: string[], verifyFast: string[],
 *   json: boolean, fast: boolean, all: boolean, force: boolean, help: boolean,
 *   fix: boolean, noCheck: boolean,
 * }} Options
 * @typedef {import('./deps.js').Deps} Deps
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    positionals: [],
    step: [],
    verify: [],
    verifyFast: [],
    json: false,
    fast: false,
    all: false,
    force: false,
    help: false,
    fix: false,
    noCheck: false,
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
      if (REPEATABLE.has(key)) {
        /** @type {string[]} */ (record[key]).push(value);
      } else {
        record[key] = value;
      }
    } else if (Object.hasOwn(BOOLEAN_FLAGS, flag)) {
      record[BOOLEAN_FLAGS[/** @type {keyof typeof BOOLEAN_FLAGS} */ (flag)]] =
        true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`Unknown option: ${arg} (see pnpm task help)`);
    } else {
      options.positionals.push(arg);
    }
  }
  return options;
}

/**
 * Who is acting: --agent, then $TASK_AGENT, then "claude" inside Claude Code.
 *
 * @param {Options} options
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function detectAgent(options, env) {
  if (options.agent) return options.agent;
  if (env.TASK_AGENT) return env.TASK_AGENT;
  if (env.CLAUDECODE === '1') return 'claude';
  return 'agent';
}

/**
 * Last-updated time for a task: state.updatedAt, else the newest file mtime.
 *
 * @param {import('./store.js').Task} task
 * @returns {Date}
 */
function updatedAt(task) {
  if (task.state) return new Date(task.state.updatedAt);
  const times = ['plan.md', 'NOTES.md']
    .map((file) =>
      fs.statSync(path.join(task.dir, file), { throwIfNoEntry: false })
    )
    .filter((stat) => stat !== undefined)
    .map((stat) => stat.mtimeMs);
  return new Date(Math.max(0, ...times));
}

/**
 * Summaries of every task, newest first.
 *
 * @param {Deps} deps
 * @returns {Array<{ name: string, status: string, tracked: boolean, active: boolean, next: string, updated: string, updatedMs: number }>}
 */
export function listTasks(deps) {
  const active = readActive(deps.rootDir);
  return listTaskNames(deps.rootDir)
    .map((name) => {
      const task = loadTask(deps.rootDir, name);
      const summary = summarizeTask(task, {
        branch: null,
        changed: null,
        diffStat: null,
      });
      const when = updatedAt(task);
      const step = summary.nextStep;
      return {
        name,
        status: summary.status,
        tracked: summary.tracked,
        active: name === active,
        next: step ? `${step.id ? `${step.id}. ` : ''}${step.title}` : '—',
        updated: formatLocal(when, { withTime: true }),
        updatedMs: when.getTime(),
      };
    })
    .sort((a, b) => b.updatedMs - a.updatedMs);
}

/**
 * The brief shown on session start: the active task, or a pick list.
 * Returns null when there are no tasks at all.
 *
 * @param {Deps} deps
 * @returns {string | null}
 */
export function sessionBrief(deps) {
  const active = readActive(deps.rootDir);
  if (active) {
    const task = loadTask(deps.rootDir, active);
    return formatBrief(summarizeTask(task, deps.git(deps.rootDir)), {
      active: true,
    });
  }
  const tasks = listTasks(deps);
  return tasks.length === 0 ? null : formatNoActiveBrief(tasks);
}

/**
 * The State: line for NOTES entries.
 *
 * @param {Deps} deps
 * @param {import('./store.js').Task} task
 * @returns {string}
 */
export function stateLine(deps, task) {
  const verify = task.state?.lastVerify;
  const result = verify ? (verify.ok ? 'pass' : 'fail') : 'not run';
  return `${formatGit(deps.git(deps.rootDir))}; verify ${result}`;
}

/**
 * Append a NOTES entry to a task.
 *
 * @param {Deps} deps
 * @param {import('./store.js').Task} task
 * @param {Parameters<typeof formatNoteEntry>[0]} entry
 */
export function writeNote(deps, task, entry) {
  appendNotes(task.dir, formatNoteEntry(entry), appendSeparator);
}

/**
 * @param {Options} options
 * @param {Deps} deps
 * @returns {string}
 */
function targetName(options, deps) {
  return resolveTaskName(deps.rootDir, options.task ?? options.positionals[1]);
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
 * Validate --kind / --e2e values.
 *
 * @param {Options} options
 * @returns {{ kind?: 'code' | 'general', e2e?: 'required' | 'no' }}
 */
export function parseKind(options) {
  if (options.kind !== undefined && !TASK_KINDS.includes(options.kind)) {
    throw new Error(
      `--kind must be ${TASK_KINDS.join(' or ')} (got "${options.kind}")`
    );
  }
  if (options.e2e !== undefined && !E2E_MODES.includes(options.e2e)) {
    throw new Error(
      `--e2e must be ${E2E_MODES.join(' or ')} (got "${options.e2e}")`
    );
  }
  return /** @type {{ kind?: 'code' | 'general', e2e?: 'required' | 'no' }} */ ({
    kind: options.kind,
    e2e: options.e2e,
  });
}

/**
 * Kind and e2e mode for a new task: --kind, else `code` when verify commands
 * are given. A code task needs verify commands (the loop's finish line).
 *
 * @param {Options} options
 * @returns {{ kind: 'code' | 'general', e2e: 'required' | 'no' }}
 */
export function resolveKind(options) {
  const parsed = parseKind(options);
  const kind = parsed.kind ?? (options.verify.length > 0 ? 'code' : 'general');
  if (kind === 'code' && options.verify.length === 0) {
    throw new Error(
      'A code task needs a finish line: its test command. pnpm task check (lint, format, types) runs before it automatically.\nFix: add --verify "<test command>" (e.g. pnpm exec vitest run --root tasks/<name>/app), or use --kind general'
    );
  }
  return { kind, e2e: parsed.e2e ?? 'no' };
}

/** Matches verify commands that run end-to-end tests. */
export const E2E_COMMAND_RE = /e2e|playwright/i;

/**
 * What a new or re-kinded code task does, for the CLI output.
 *
 * @param {import('./state.js').TaskState} state
 * @returns {string[]}
 */
export function codeTaskLines(state) {
  if (state.kind !== 'code') return [];
  const lines = [
    `Coding task: work test-first (failing test, then code); verify = ${state.verify.join(' && ')}; pnpm task check (lint, format, types) runs before it once the task has code; inner loop ${state.loop.enabled ? `on (max ${state.loop.max})` : 'off'}.`,
  ];
  if (
    state.e2e === 'required' &&
    !state.verify.some((command) => E2E_COMMAND_RE.test(command))
  ) {
    lines.push(
      'e2e: required, but no verify command runs e2e tests yet. Fix: pnpm task set --verify "<unit tests>" --verify "<e2e tests>" once the e2e suite exists.'
    );
  }
  return lines;
}

/**
 * Why a task cannot be closed yet (empty = it can). Every task: no step left
 * open. Code tasks also need the quality loop (AGENTS.md §4.5) finished: at
 * least one review round, no open round, no open CONFIRMED must-fix/high
 * finding, and an e2e verify command when e2e is required.
 *
 * @param {import('./state.js').TaskState} state
 * @returns {string[]} one "problem. Fix: …" line each
 */
export function doneBlockers(state) {
  const quality = state.quality ?? freshQuality();
  // Fix steps of open findings are reported with the findings below.
  const fixSteps = new Set(toFix(quality).map((f) => f.step));
  const unfinished = state.steps.filter(
    (s) => s.status !== 'done' && !fixSteps.has(s.id)
  );
  /** @type {string[]} */
  const blockers =
    unfinished.length > 0
      ? [
          `${unfinished.length} step(s) not done: ${unfinished.map((s) => `${s.id} (${s.status})`).join(', ')}. Fix: finish them (pnpm task next), or drop what is out of scope: pnpm task step <id> done -m "dropped: <why>"`,
        ]
      : [];
  if (state.kind !== 'code') return blockers;
  if (quality.reviewRounds === 0) {
    blockers.push(
      'No review round ran. Fix: pnpm task review, then the reviewer and the triage in clean contexts, then pnpm task review record'
    );
  } else if (quality.phase === 'review') {
    blockers.push(
      `Review round ${quality.reviewRounds} is open but not recorded. Fix: finish the reviewer and the triage, then pnpm task review record`
    );
  }
  const done = new Set(
    state.steps.filter((s) => s.status === 'done').map((s) => s.id)
  );
  const open = toFix(quality).filter((f) => !f.step || !done.has(f.step));
  if (open.length > 0) {
    blockers.push(
      `${open.length} CONFIRMED must-fix/high finding(s) not fixed: ${open.map((f) => `${f.id}${f.step ? ` (step ${f.step})` : ''}`).join(', ')}. Fix: fix each test-first, then pnpm task step <id> done`
    );
  }
  if (
    state.e2e === 'required' &&
    !state.verify.some((command) => E2E_COMMAND_RE.test(command))
  ) {
    blockers.push(
      'e2e: required, but no verify command runs e2e tests. Fix: pnpm task set --verify "<unit tests>" --verify "<e2e tests>", then pnpm task verify'
    );
  }
  return blockers;
}

/**
 * The default Acceptance line for a new task.
 *
 * @param {Options} options
 * @param {{ kind: string, e2e: string }} mode
 * @returns {string}
 */
export function defaultAcceptance(options, { kind, e2e }) {
  const parts = [
    options.verify.length > 0
      ? `\`${options.verify.join('` and `')}\` ${options.verify.length === 1 ? 'passes' : 'pass'}`
      : '`pnpm check` passes',
  ];
  if (kind === 'code')
    parts.push('`pnpm task check` passes (lint, format, types)');
  if (e2e === 'required') parts.push('e2e tests cover the user-facing flows');
  return parts.join('; ');
}

/** @type {Record<string, (options: Options, deps: Deps) => number | Promise<number>>} */
export const COMMANDS = {
  help(_options, deps) {
    deps.log(HELP);
    return 0;
  },

  new(options, deps) {
    const raw = options.positionals[1];
    if (!raw) throw new Error('Usage: pnpm task new <name> --goal "…"');
    if (!options.goal) {
      throw new Error('A task needs a goal: --goal "one sentence"');
    }
    const now = deps.now();
    const name = taskDirName(raw, now);
    const agent = detectAgent(options, deps.env);
    const mode = resolveKind(options);
    const state = createState({
      name,
      goal: options.goal,
      steps: makeSteps(options.step),
      verify: options.verify,
      verifyFast: options.verifyFast,
      branch: deps.git(deps.rootDir).branch,
      agent,
      now,
      startCommit: deps.runGit(['rev-parse', 'HEAD'], deps.rootDir),
      ...mode,
    });
    const dir = scaffoldTask({
      rootDir: deps.rootDir,
      name,
      state,
      acceptance: options.acceptance ?? defaultAcceptance(options, mode),
      date: formatLocal(now),
      templatesDir: deps.templatesDir,
    });
    writeActive(deps.rootDir, name);
    output(
      deps,
      options,
      { ok: true, name, dir, state },
      [
        `Created ${relPosix(deps.rootDir, dir)}/ (active task).`,
        ...codeTaskLines(state),
        state.steps.length === 0
          ? 'Next: add steps — pnpm task step add "…"'
          : `Next: pnpm task step ${state.steps[0].id} start`,
      ].join('\n')
    );
    return 0;
  },

  init(options, deps) {
    const name = targetName(options, deps);
    const task = loadTask(deps.rootDir, name);
    if (task.state) {
      throw new Error(`${name} already has ${STATE_FILE}.`);
    }
    const plan = parsePlan(task.plan ?? '');
    const goal = options.goal ?? plan.goal;
    if (!goal) {
      throw new Error(`${name}/plan.md has no Goal: line. Pass --goal "…".`);
    }
    const state = createState({
      name,
      goal,
      steps: makeSteps(plan.steps),
      verify: options.verify,
      verifyFast: options.verifyFast,
      branch: deps.git(deps.rootDir).branch,
      agent: detectAgent(options, deps.env),
      now: deps.now(),
      ...resolveKind(options),
    });
    saveState(task.dir, state);
    output(
      deps,
      options,
      { ok: true, name, state },
      [
        `Created ${name}/${STATE_FILE} with ${state.steps.length} step(s) from plan.md. state.json now tracks the steps; plan.md is unchanged.`,
        ...codeTaskLines(state),
      ].join('\n')
    );
    return 0;
  },

  list(options, deps) {
    const tasks = listTasks(deps).filter(
      (t) => options.all || t.status !== 'done'
    );
    if (options.json) {
      output(deps, options, tasks, '');
      return 0;
    }
    if (tasks.length === 0) {
      deps.log('No tasks. Start one: pnpm task new <name> --goal "…"');
      return 0;
    }
    for (const t of tasks) {
      deps.log(
        `${t.active ? '*' : ' '} ${t.name}  [${statusLabel(t.status, t.tracked)}${t.active ? ', active task' : ''}]  updated ${t.updated}  next: ${t.next}`
      );
    }
    return 0;
  },

  status(options, deps) {
    const name = targetName(options, deps);
    const summary = summarizeTask(
      loadTask(deps.rootDir, name),
      deps.git(deps.rootDir)
    );
    output(
      deps,
      options,
      summary,
      formatBrief(summary, { active: name === readActive(deps.rootDir) })
    );
    return 0;
  },

  switch(options, deps) {
    const query = options.positionals[1] ?? options.task;
    if (!query) throw new Error('Usage: pnpm task switch <name>');
    const name = resolveTaskName(deps.rootDir, query);
    writeActive(deps.rootDir, name);
    output(
      deps,
      options,
      { ok: true, active: name },
      `Active task: ${name}. Next: pnpm task status`
    );
    return 0;
  },

  next(options, deps) {
    const name = targetName(options, deps);
    const { state } = loadTask(deps.rootDir, name);
    if (!state) {
      throw new Error(
        `${name} has no ${STATE_FILE}.\nFix: pnpm task init ${name}`
      );
    }
    const step = nextStep(state);
    output(
      deps,
      options,
      { task: name, step },
      step
        ? `${step.id}. ${step.title} [${step.status}] — ${step.status === 'in_progress' ? `when finished: pnpm task step ${step.id} done` : `start: pnpm task step ${step.id} start`}`
        : 'No ready step. Check pnpm task status for blocked steps, or add one: pnpm task step add "…"'
    );
    return 0;
  },

  claim(options, deps) {
    const name = resolveTaskName(deps.rootDir, options.task);
    const agent = detectAgent(options, deps.env);
    const now = deps.now();
    const id = options.positionals[1];
    /** @type {import('./state.js').Step | null} */
    let claimed = null;
    let reason = '';
    updateState(
      deps.rootDir,
      name,
      (current) => {
        const result = claimStep(current, { agent, id, now });
        claimed = result.step;
        if (!claimed) reason = idleReason(current);
        return result.state;
      },
      { now, agent }
    );
    const step = /** @type {import('./state.js').Step | null} */ (claimed);
    output(
      deps,
      options,
      { ok: step !== null, task: name, step, reason: step ? null : reason },
      step
        ? `Claimed ${step.id}. ${step.title} for ${agent}. When finished: pnpm task step ${step.id} done -m "…" (give it back: pnpm task step ${step.id} todo)`
        : `Nothing to claim: ${reason}.`
    );
    return step ? 0 : 2;
  },

  step(options, deps) {
    const [, first, second] = options.positionals;
    if (!first) {
      throw new Error(
        `Usage: pnpm task step add "title" | pnpm task step <id> ${STEP_STATUSES.join('|')}`
      );
    }
    const name = resolveTaskName(deps.rootDir, options.task);
    const agent = detectAgent(options, deps.env);
    const now = deps.now();

    if (first === 'add') {
      if (!second) throw new Error('Usage: pnpm task step add "title"');
      /** @type {import('./state.js').Step | undefined} */
      let added;
      updateState(
        deps.rootDir,
        name,
        (state) => {
          const result = addStep(state, {
            title: second,
            deps: options.deps
              ? options.deps
                  .split(',')
                  .map((d) => d.trim())
                  .filter(Boolean)
              : [],
          });
          added = result.step;
          return result.state;
        },
        { now, agent }
      );
      const step = /** @type {import('./state.js').Step} */ (added);
      output(
        deps,
        options,
        { ok: true, task: name, step },
        `Added ${step.id}. ${step.title}`
      );
      return 0;
    }

    const action = second;
    /** @type {Record<string, import('./state.js').StepStatus>} */
    const actions = {
      start: 'in_progress',
      done: 'done',
      blocked: 'blocked',
      todo: 'todo',
    };
    if (!action || !Object.hasOwn(actions, action)) {
      throw new Error(
        `Usage: pnpm task step ${first} start|done|blocked|todo [-m "…"]`
      );
    }
    /** @type {import('./state.js').Step | undefined} */
    let changed;
    const state = updateState(
      deps.rootDir,
      name,
      (current) => {
        const result = setStepStatus(current, {
          id: first,
          status: actions[action],
          agent,
          note: options.message,
          force: options.force,
          now,
        });
        changed = result.step;
        return result.state;
      },
      { now, agent }
    );
    const step = /** @type {import('./state.js').Step} */ (changed);

    if (action === 'done' || action === 'blocked') {
      const task = loadTask(deps.rootDir, name);
      writeNote(deps, task, {
        at: now,
        agent,
        label: `step ${step.id} ${action}`,
        message: `${step.id}. ${step.title} → ${action}${options.message ? `: ${options.message}` : ''}`,
      });
    }

    const following = nextStep(state);
    output(
      deps,
      options,
      { ok: true, task: name, step, next: following },
      [
        `${step.id}. ${step.title} → ${step.status}`,
        following
          ? `Next step: ${following.id}. ${following.title}`
          : 'No ready step left. When verify passes: pnpm task done',
      ].join('\n')
    );
    return 0;
  },

  note(options, deps) {
    if (!options.done && !options.next && !options.open && !options.message) {
      throw new Error(
        'Usage: pnpm task note --done "what changed" --next "the single next action" [--open "…"]'
      );
    }
    const name = resolveTaskName(deps.rootDir, options.task);
    const agent = detectAgent(options, deps.env);
    const now = deps.now();
    const task = loadTask(deps.rootDir, name);
    writeNote(deps, task, {
      at: now,
      agent,
      message: options.message,
      done: options.done,
      state: stateLine(deps, task),
      next: options.next,
      open: options.open,
    });
    const { next } = options;
    if (task.state && next) {
      updateState(deps.rootDir, name, (state) => ({ ...state, next }), {
        now,
        agent,
      });
    }
    output(
      deps,
      options,
      { ok: true, task: name },
      `Appended a note to tasks/${name}/NOTES.md`
    );
    return 0;
  },

  verify(options, deps) {
    const name = resolveTaskName(deps.rootDir, options.task);
    const task = loadTask(deps.rootDir, name);
    if (!task.state) {
      throw new Error(
        `${name} has no ${STATE_FILE}.\nFix: pnpm task init ${name} --verify "pnpm check"`
      );
    }
    const listed =
      options.fast && task.state.verifyFast.length > 0
        ? task.state.verifyFast
        : task.state.verify;
    const commands = options.noCheck
      ? listed
      : withCheck(listed, { name, taskDir: task.dir });
    if (commands.length === 0) {
      throw new Error(
        `${name} has no verify commands.\nFix: pnpm task set --verify "pnpm check" (add --verify-fast "…" for a quick subset)`
      );
    }
    const results = deps.runCommands({
      commands,
      cwd: deps.rootDir,
      onStart: (command) => {
        if (!options.json) deps.log(`▶ ${command}`);
      },
    });
    const now = deps.now();
    const lastVerify = summarize(results, now);
    updateState(deps.rootDir, name, (state) => ({ ...state, lastVerify }), {
      now,
      agent: detectAgent(options, deps.env),
    });

    const failed = results.find((r) => !r.ok);
    output(
      deps,
      options,
      {
        ok: lastVerify.ok,
        task: name,
        lastVerify,
        results: results.map(({ output: out, ...rest }) => ({
          ...rest,
          tail: tail(out),
        })),
      },
      failed
        ? `✗ ${failed.command} failed (exit ${failed.code}):\n${lastVerify.summary}\nFix the failure above, then re-run: pnpm task verify`
        : `✓ verify passed (${results.length} command(s))`
    );
    return lastVerify.ok ? 0 : 1;
  },

  set(options, deps) {
    if (
      !options.goal &&
      options.verify.length === 0 &&
      options.verifyFast.length === 0 &&
      options.loop === undefined &&
      options.loopMax === undefined &&
      options.kind === undefined &&
      options.e2e === undefined
    ) {
      throw new Error(
        'Usage: pnpm task set [--goal "…"] [--verify "cmd"]… [--verify-fast "cmd"]… (each list replaces the old one) [--loop on|off] [--loop-max N] [--kind code|general] [--e2e required|no]'
      );
    }
    const mode = parseKind(options);
    if (options.loop !== undefined && !['on', 'off'].includes(options.loop)) {
      throw new Error(`--loop must be on or off (got "${options.loop}")`);
    }
    const max =
      options.loopMax === undefined
        ? undefined
        : parseMax(options.loopMax, '--loop-max');
    const name = resolveTaskName(deps.rootDir, options.task);
    const state = updateState(
      deps.rootDir,
      name,
      (current) => {
        const verify =
          options.verify.length > 0 ? options.verify : current.verify;
        // Becoming a code task turns the loop on unless --loop says otherwise.
        const becomesCode = mode.kind === 'code' && current.kind !== 'code';
        const turnsOn =
          options.loop === 'on' || (options.loop === undefined && becomesCode);
        const enabled =
          options.loop === undefined
            ? current.loop.enabled || becomesCode
            : options.loop === 'on';
        if (turnsOn && verify.length === 0) {
          throw new Error(
            `${name} has no verify commands, so the loop has no finish line.\nFix: pnpm task set --verify "<test command>" ${becomesCode ? '--kind code' : '--loop on'}`
          );
        }
        return {
          ...current,
          ...(mode.kind ? { kind: mode.kind } : {}),
          ...(becomesCode && !current.quality
            ? { quality: freshQuality() }
            : {}),
          ...(mode.e2e ? { e2e: mode.e2e } : {}),
          goal: options.goal ?? current.goal,
          verify,
          verifyFast:
            options.verifyFast.length > 0
              ? options.verifyFast
              : current.verifyFast,
          loop:
            options.loop === undefined && max === undefined && !becomesCode
              ? current.loop
              : { enabled, max: max ?? current.loop.max, ...FRESH_LOOP },
        };
      },
      { now: deps.now(), agent: detectAgent(options, deps.env) }
    );
    output(
      deps,
      options,
      { ok: true, task: name, state },
      [
        `Updated ${name}: verify = ${state.verify.join(' && ') || '(none)'}; fast = ${state.verifyFast.join(' && ') || '(same as verify)'}`,
        state.loop.enabled
          ? `Inner loop: on (max ${state.loop.max}) — in Claude Code, each stop re-runs the fast verify until it passes. Turn off: pnpm task set --loop off`
          : 'Inner loop: off',
        ...(mode.kind || mode.e2e ? codeTaskLines(state) : []),
      ].join('\n')
    );
    return 0;
  },

  review(options, deps) {
    const sub = options.positionals[1];
    if (sub === 'record') return recordReview(options, deps);
    if (sub !== undefined) {
      throw new Error(
        'Usage: pnpm task review [--base <ref>] [--force] | pnpm task review record [file]'
      );
    }
    const name = resolveTaskName(deps.rootDir, options.task);
    const task = loadTask(deps.rootDir, name);
    if (!task.state) {
      throw new Error(
        `${name} has no ${STATE_FILE}.\nFix: pnpm task init ${name} --verify "<test command>"`
      );
    }
    const quality = task.state.quality ?? freshQuality();
    const base = reviewBase({
      quality,
      taskDir: task.dir,
      base: options.base,
      startCommit: task.state.startCommit,
    });
    const scope = reviewScope({
      rootDir: deps.rootDir,
      taskDir: task.dir,
      base,
      runGit: deps.runGit,
    });
    if (scope.files.length === 0 && quality.phase !== 'review') {
      throw new Error(
        // A null base means task code, which is never empty: this is a git scope.
        `Nothing to review for ${name}: no files changed since ${scope.base} (merge base ${String(scope.mergeBase).slice(0, 7)}). If the work is already committed there, review against the commit before it.\nFix: pnpm task review --base <the commit before the task's first commit>`
      );
    }
    const print = fingerprint(deps.rootDir, scope.files);
    const now = deps.now();
    const agent = detectAgent(options, deps.env);
    let round = 0;
    let reopened = false;
    const state = updateState(
      deps.rootDir,
      name,
      (current) => {
        const result = openRound(current, {
          fingerprint: print,
          base,
          force: options.force,
        });
        round = result.round;
        reopened = result.reopened;
        return result.state;
      },
      { now, agent }
    );
    const taskRel = path
      .relative(deps.rootDir, task.dir)
      .split(path.sep)
      .join('/');
    const files = reviewFiles(name, round);
    fs.mkdirSync(path.join(task.dir, 'reviews'), { recursive: true });
    fs.writeFileSync(
      path.join(task.dir, files.brief),
      formatReviewBrief({ state, round, scope, taskRel }),
      'utf-8'
    );
    const findingsPath = path.join(task.dir, files.findings);
    if (!fs.existsSync(findingsPath)) {
      fs.writeFileSync(
        findingsPath,
        findingsTemplate({ name, round, brief: `${taskRel}/${files.brief}` }),
        'utf-8'
      );
    }
    if (!reopened) {
      writeNote(deps, task, {
        at: now,
        agent,
        label: `review r${round} opened`,
        message: `Review round ${round}/${quality.maxRounds} opened: ${scope.files.length} file(s), fingerprint ${print}.`,
      });
    }
    const brief = `${taskRel}/${files.brief}`;
    const findings = `${taskRel}/${files.findings}`;
    output(
      deps,
      options,
      { ok: true, task: name, round, reopened, scope, brief, findings },
      [
        `${reopened ? 'Review round still open' : 'Opened review round'} ${round}/${quality.maxRounds} for ${name} (${scope.files.length} file(s)).`,
        `Brief: ${brief}`,
        `Findings: ${findings}`,
        'Run the review and the triage in clean contexts, not yourself (you wrote the code):',
        `  Claude Code: Agent tool, subagent_type "reviewer", prompt "Follow ${brief}"; then subagent_type "verifier", prompt "Triage ${findings} as step 2 of ${brief} says".`,
        `  Other harnesses: pnpm agent ask --agent <another agent> - < ${brief}, paste its rows into the findings table, then ask another agent for the triage.`,
        'Then: pnpm task review record',
      ].join('\n')
    );
    return 0;
  },

  template(options, deps) {
    const kind = options.positionals[1];
    /** @type {Record<string, { file: string, dir: string, prefix: string }>} */
    const kinds = {
      review: { file: 'REVIEW.md', dir: 'reviews', prefix: 'REVIEW_' },
      study: { file: 'STUDIES.md', dir: 'studies', prefix: 'STUDIES_' },
    };
    if (!kind || !Object.hasOwn(kinds, kind)) {
      throw new Error(
        'Usage: pnpm task template review|study [--name <kebab>]'
      );
    }
    const name = resolveTaskName(deps.rootDir, options.task);
    const label = options.name ?? name.replace(DATE_SUFFIX_RE, '');
    if (!TASK_NAME_RE.test(label)) {
      throw new Error(`Invalid --name "${label}": use lowercase kebab-case`);
    }
    const { file, dir, prefix } = kinds[kind];
    const target = path.join(
      tasksRoot(deps.rootDir),
      name,
      dir,
      `${prefix}${label}.md`
    );
    if (fs.existsSync(target)) {
      throw new Error(`${relPosix(deps.rootDir, target)} already exists.`);
    }
    const content = renderTemplate(
      fs.readFileSync(path.join(deps.templatesDir, file), 'utf-8'),
      { name: label, date: formatLocal(deps.now()) }
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
    const relative = relPosix(deps.rootDir, target);
    output(
      deps,
      options,
      { ok: true, file: relative },
      `Created ${relative} — fill in every (…) placeholder.`
    );
    return 0;
  },

  async check(options, deps) {
    const name = targetName(options, deps);
    const task = loadTask(deps.rootDir, name);
    const result = await deps.runCheck({
      rootDir: deps.rootDir,
      taskDir: task.dir,
      fix: options.fix,
    });
    output(deps, options, { task: name, ...result }, formatCheck(result, name));
    return result.ok ? 0 : 1;
  },

  done(options, deps) {
    const name = targetName(options, deps);
    const task = loadTask(deps.rootDir, name);
    if (!task.state) {
      throw new Error(
        `${name} has no ${STATE_FILE}.\nFix: pnpm task init ${name}`
      );
    }
    const verify = task.state.lastVerify;
    if (task.state.verify.length > 0 && !verify?.ok && !options.force) {
      throw new Error(
        `The last verify did not pass (${verify ? `\`${verify.failed}\` failed` : 'not run'}).\nFix: pnpm task verify — or, if the user agrees, pnpm task done --force`
      );
    }
    const blockers = doneBlockers(task.state);
    if (blockers.length > 0 && !options.force) {
      throw new Error(
        [
          `${name} is not finished:`,
          ...blockers.map((b) => `- ${b}`),
          'Fix: the lines above — or, if the user agrees, pnpm task done --force',
        ].join('\n')
      );
    }
    const forced =
      blockers.length > 0
        ? ` Forced past: ${blockers.map((b) => b.split('. Fix:')[0]).join('; ')}.`
        : '';
    const now = deps.now();
    const agent = detectAgent(options, deps.env);
    updateState(
      deps.rootDir,
      name,
      (state) => ({ ...state, status: 'done', next: null }),
      { now, agent }
    );
    writeNote(deps, task, {
      at: now,
      agent,
      label: 'done',
      message: `Task closed.${options.message ? ` ${options.message}` : ''}${forced}`,
      state: stateLine(deps, task),
    });
    if (readActive(deps.rootDir) === name) writeActive(deps.rootDir, null);
    output(deps, options, { ok: true, task: name }, `Closed ${name}.`);
    return 0;
  },
};

/**
 * `pnpm task review record [file]`: close the open round with its findings.
 *
 * @param {Options} options
 * @param {Deps} deps
 * @returns {number}
 */
function recordReview(options, deps) {
  const name = resolveTaskName(deps.rootDir, options.task);
  const task = loadTask(deps.rootDir, name);
  if (!task.state) {
    throw new Error(
      `${name} has no ${STATE_FILE}.\nFix: pnpm task init ${name}`
    );
  }
  const quality = task.state.quality ?? freshQuality();
  const round = quality.reviewRounds;
  const given = options.positionals[2];
  const file = given
    ? path.resolve(deps.rootDir, given)
    : path.join(task.dir, reviewFiles(name, round).findings);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No findings file at ${relPosix(deps.rootDir, file)}.\nFix: pnpm task review (opens a round and creates it)`
    );
  }
  const { findings, errors } = parseFindings(fs.readFileSync(file, 'utf-8'), {
    round,
    takenIds: new Set(quality.findings.map((f) => f.id)),
  });
  if (errors.length > 0) {
    throw new Error(
      `${relPosix(deps.rootDir, file)} is not ready:\n${errors.map((e) => `- ${e}`).join('\n')}\nFix the rows above, then re-run: pnpm task review record`
    );
  }
  const now = deps.now();
  const agent = detectAgent(options, deps.env);
  /** @type {import('./state.js').Step[]} */
  let fixSteps = [];
  const state = updateState(
    deps.rootDir,
    name,
    (current) => {
      const result = recordFindings(current, findings);
      fixSteps = result.fixSteps;
      return result.state;
    },
    { now, agent }
  );
  const recordedQuality = /** @type {import('./quality.js').Quality} */ (
    state.quality
  );
  const counts = countFindings({ ...recordedQuality, findings }, state.steps);
  const fixIds = new Set(
    toFix({ ...recordedQuality, findings }).map((f) => f.id)
  );
  const recordedOnly = findings.filter(
    (f) => f.verdict === 'CONFIRMED' && !fixIds.has(f.id)
  );
  const summary = `Round ${round}: ${counts.total} finding(s) — ${counts.confirmed} confirmed, ${counts.refuted} refuted; ${fixSteps.length} fix step(s)${fixSteps.length > 0 ? ` (${fixSteps.map((s) => s.id).join(', ')})` : ''}; ${recordedOnly.length} medium/low recorded.`;
  writeNote(deps, task, {
    at: now,
    agent,
    label: `review r${round} recorded`,
    message: summary,
  });
  const last = round >= recordedQuality.maxRounds;
  output(
    deps,
    options,
    {
      ok: true,
      task: name,
      round,
      findings,
      fixSteps,
      quality: recordedQuality,
    },
    [
      summary,
      ...fixSteps.map((s) => `  ${s.id}. ${s.title}`),
      ...(recordedOnly.length > 0
        ? [
            `Recorded, not fixed (medium/low): ${recordedOnly.map((f) => f.id).join(', ')} — list them under Open in the final note.`,
          ]
        : []),
      fixSteps.length === 0
        ? 'No must-fix/high findings: the quality loop is complete. When verify passes: pnpm task done'
        : `Next: pnpm task step ${fixSteps[0].id} start — fix test-first, then pnpm task verify. ${last ? `That was the last review round (${round}/${recordedQuality.maxRounds}): after the fixes, no more reviews.` : 'After all fixes pass verify: pnpm task review (next round).'}`,
    ].join('\n')
  );
  return 0;
}

/**
 * @param {{ argv?: string[], deps?: Partial<Deps> }} [options]
 * @returns {number | Promise<number>}
 */
export function main({ argv = process.argv.slice(2), deps = {} } = {}) {
  /** @type {Deps} */
  const resolved = defaultDeps(deps);
  const options = parseArgs(argv);
  const command = options.positionals[0] ?? 'help';
  if (options.help || command === 'help') {
    return COMMANDS.help(options, resolved);
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error(`Unknown command "${command}". Run: pnpm task help`);
  }
  return COMMANDS[command](options, resolved);
}

/* c8 ignore next 9 - CLI entry point */
runIfMain(import.meta.url, async () => {
  try {
    process.exit(await main());
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
});
