#!/usr/bin/env node
/**
 * Memory hook: one script for Claude Code (`.claude/settings.json`) and
 * Codex (`.codex/hooks.json`), run as `node utils/memory/hook.js --harness
 * claude|codex` (design §7, §8). It reads the hook's JSON on stdin and may
 * print `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}`:
 *
 * - SessionStart: Codex gets the core block (it does not load
 *   AGENTS.local.md natively); Claude Code only when CLAUDE.local.md is
 *   missing. Both hear when saving is off. /clear and compaction forget what
 *   this session was shown.
 * - UserPromptSubmit: a one-line persona reminder when personalization is
 *   set (the core block loads once; this keeps it near each turn), then the
 *   notes recalled for the prompt and the task's goal (not for slash
 *   commands or background-task notifications).
 * - PreToolUse: notes whose triggers are in the command (no scoring).
 * - PostToolUseFailure (Claude) or PostToolUse with a non-zero exit (Codex):
 *   notes recalled for the command and its error output.
 * - Extraction (path B, harnesses with a transcript adapter: Claude Code
 *   and Codex; DSH has no SessionEnd and gives hooks no transcript):
 *   SessionStart records the session as open, queues sessions that ended
 *   without a SessionEnd, and starts the worker (also when consolidation is
 *   due); SessionEnd queues the
 *   session and starts the worker (detached, so nothing waits). SessionStart
 *   also announces what extraction saved since the last session.
 *
 * Silence is the default: nothing is printed when nothing matches, before
 * memory is set up, for the reviewer and verifier roles (clean-context
 * reviews), for the extraction agent (EXTRACT_ENV), or on any error (fail
 * open). A note is injected once per session. Reads only the caches on the
 * warm path, so it stays fast.
 */
import fs from 'fs';
import path from 'path';
import {
  HARNESSES,
  agyInjectOutput,
  normalizeHookInput,
} from '../harness/input.js';
import { runIfMain } from '../module-runner.js';
import { SESSION_ID_RE, readIfExists } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readConfig, savingOff } from './config.js';
import { consolidationDue } from './consolidate.js';
import { taskContext } from './context.js';
import { announcement } from './extract.js';
import {
  EXTRACT_ENV,
  catchUp,
  enqueue,
  kickWorker,
  readQueue,
  registerOpen,
  workerRunning,
} from './queue.js';
import {
  RECALL_LIMIT,
  formatRecall,
  loadIndex,
  matchTriggers,
  recall,
} from './recall.js';
import {
  AGENTS_LOCAL_FILE,
  CLAUDE_LOCAL_FILE,
  CORE_END,
  CORE_START,
  renderStored,
} from './render.js';
import { readPersonalization, renderPersonalization } from './personalize.js';
import { mainCheckout } from './repo.js';
import {
  CACHE_DIR,
  memoryDir,
  readJsonOrNull,
  readUsage,
  recordHits,
} from './store.js';
import { recentAgyFailures } from './transcript.js';

/** Roles that must review in a clean context. */
export const SKIP_AGENTS = ['reviewer', 'verifier'];
export const SESSIONS_DIR = 'sessions';
/** Session records older than this are pruned at SessionStart. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Characters of a failed command's output used in the query. */
export const ERROR_CHARS = 600;
const EXIT_CODE_RE = /\bexit code:?\s*(-?\d+)/i;
const NOTE_ID_RE = /^- ([mt][1-9]\d*) \(/;
/** Repeated at every typed prompt, so progress notes keep the persona. */
export const PERSONA_REMINDER =
  '[Persona] Every message to the user, progress notes between tool calls included, follows the Personalization section.';
const PERSONALIZATION_OFF =
  '[Persona] Workspace memory personalization is off. Disregard the memory-generated Personalization section and its persona reminders.';
const PERSONALIZATION_EMPTY =
  '[Persona] No workspace memory personalization settings are saved. Use the session’s usual response style.';
/** Characters of the language setting quoted in the reminder. */
export const REMINDER_LANGUAGE_CHARS = 200;

/**
 * @typedef {import('../harness/input.js').Harness} Harness
 * @typedef {Record<string, any>} HookInput
 * @typedef {{ hookSpecificOutput: { hookEventName: string, additionalContext: string }, systemMessage?: string }} StandardHookOutput
 * @typedef {StandardHookOutput | import('../harness/input.js').AgyInjectOutput} HookOutput
 * @typedef {{ harness?: Harness, rootDir?: string, now?: Date, env?: NodeJS.ProcessEnv, kick?: typeof kickWorker }} HookOptions
 */

/**
 * @param {string[]} argv
 * @returns {Harness}
 */
export function parseHarness(argv) {
  const value = argv[argv.indexOf('--harness') + 1];
  return HARNESSES.find((name) => name === value) ?? 'claude';
}

/**
 * @param {string} dir the memory directory
 * @param {string} session
 */
export const sessionFile = (dir, session) =>
  path.join(dir, CACHE_DIR, SESSIONS_DIR, `${session}.json`);

/**
 * The note ids this session was already shown.
 *
 * @param {string} dir
 * @param {string | null} session
 * @returns {Set<string>}
 */
export function readInjected(dir, session) {
  if (!session) return new Set();
  const data = /** @type {any} */ (readJsonOrNull(sessionFile(dir, session)));
  return new Set(Array.isArray(data?.injected) ? data.injected : []);
}

/**
 * @param {string} dir
 * @param {string | null} session
 * @param {Set<string>} injected
 */
function writeInjected(dir, session, injected) {
  if (!session) return;
  const file = sessionFile(dir, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ injected: [...injected] }));
}

/**
 * Remove the records of sessions untouched for SESSION_MAX_AGE_MS.
 *
 * @param {string} dir
 * @param {Date} now
 */
function pruneSessions(dir, now) {
  const sessions = path.join(dir, CACHE_DIR, SESSIONS_DIR);
  if (!fs.existsSync(sessions)) return;
  for (const name of fs.readdirSync(sessions)) {
    const file = path.join(sessions, name);
    if (now.getTime() - fs.statSync(file).mtimeMs > SESSION_MAX_AGE_MS) {
      fs.rmSync(file, { force: true });
    }
  }
}

/**
 * @param {string} event
 * @param {string | null} text
 * @param {Harness} harness
 * @param {string} [userMarkdown]
 * @returns {HookOutput | null}
 */
function contextOutput(event, text, harness, userMarkdown) {
  if (!text) return null;
  if (harness === 'agy') return agyInjectOutput(text, userMarkdown);
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  };
}

/**
 * The shell command of a tool event, as one string.
 *
 * @param {HookInput} input
 */
function commandOf(input) {
  const command = input.tool_input?.command;
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : '';
}

/**
 * The error output of a failed command (at most ERROR_CHARS), or null when
 * the event is not a failure. Claude Code reports failures as
 * PostToolUseFailure with an `error`; Codex as PostToolUse, whose response
 * holds the exit code (a field, or an "Exit code: N" line).
 *
 * @param {HookInput} input
 * @returns {string | null}
 */
export function failureText(input) {
  if (input.hook_event_name === 'PostToolUseFailure') {
    return String(input.error ?? '').slice(0, ERROR_CHARS);
  }
  const response = input.tool_response;
  const text =
    typeof response === 'string'
      ? response
      : ['stderr', 'stdout', 'output']
          .map((key) => response?.[key])
          .filter((value) => typeof value === 'string')
          .join('\n');
  const field = response?.exit_code ?? response?.exitCode;
  const exit =
    typeof field === 'number'
      ? field
      : Number(EXIT_CODE_RE.exec(text)?.[1] ?? 0);
  return exit === 0 ? null : text.slice(0, ERROR_CHARS);
}

/**
 * The persona reminder for the user's settings, or '' without any (or with
 * a broken settings file: the reminder is optional, recall must still run).
 *
 * @param {string} dir the memory directory
 */
function personaReminder(dir) {
  let settings;
  try {
    if (!readConfig(dir).personalizationEnabled) return PERSONALIZATION_OFF;
    settings = readPersonalization(dir);
  } catch {
    return '';
  }
  if (Object.keys(settings).length === 0) return '';
  if (!settings.language) return PERSONA_REMINDER;
  const language = settings.language.replace(/\s+/g, ' ');
  return `${PERSONA_REMINDER} Language: ${
    language.length > REMINDER_LANGUAGE_CHARS
      ? `${language.slice(0, REMINDER_LANGUAGE_CHARS)}…`
      : language
  }`;
}

/**
 * Supply the core when the harness did not load a local file. A linked
 * worktree can hold an older copy, so supply just its current personalization.
 *
 * @param {string} rootDir
 * @param {string} home
 * @param {Harness} harness
 * @param {import('./config.js').MemoryConfig} config
 */
function startupMemory(rootDir, home, harness, config) {
  const localFile = harness === 'dsh' ? AGENTS_LOCAL_FILE : CLAUDE_LOCAL_FILE;
  if (
    harness === 'codex' ||
    harness === 'agy' ||
    !fs.existsSync(path.join(rootDir, localFile))
  ) {
    return renderStored(home, config).block;
  }
  if (rootDir === home) return '';

  const local = readIfExists(path.join(rootDir, AGENTS_LOCAL_FILE)) ?? '';
  const start = local.indexOf(CORE_START);
  if (start < 0) return renderStored(home, config).block;
  if (!config.personalizationEnabled) return '';

  const block = local.slice(start, local.indexOf(CORE_END, start));
  const { personalization } = renderStored(home, config);
  const current = renderPersonalization(personalization);
  if (current) {
    return block.includes(current)
      ? ''
      : `[Persona] Apply the current workspace memory personalization below.\n\n${current}`;
  }
  return block.includes('\n## Personalization\n') ? PERSONALIZATION_EMPTY : '';
}

/**
 * Recall for `query`, skipping what the session was shown; record the
 * injection (usage and the session's record).
 *
 * @param {{ dir: string, session: string | null, now: Date }} store
 * @param {(notes: import('./store.js').Note[], index: import('./recall.js').Index) => import('./recall.js').RecallResult[] | { note: import('./store.js').Note }[]} pick
 * @returns {string | null}
 */
function injectText({ dir, session, now }, pick) {
  const { notes, index } = loadIndex(dir);
  const injected = readInjected(dir, session);
  const text = formatRecall(
    pick(
      notes.filter((note) => !injected.has(note.id)),
      index
    ),
    { now }
  );
  if (!text) return null;
  const ids = text
    .split('\n')
    .map((line) => NOTE_ID_RE.exec(line)?.[1])
    .filter((id) => id !== undefined);
  recordHits(dir, ids, now);
  writeInjected(dir, session, new Set([...injected, ...ids]));
  return text;
}

/**
 * @template {Harness} [H='claude']
 * @param {HookInput} input
 * @param {{ harness?: H, rootDir?: string, now?: Date, env?: NodeJS.ProcessEnv, kick?: typeof kickWorker }} [options]
 * @returns {(H extends 'agy' ? import('../harness/input.js').AgyInjectOutput : StandardHookOutput) | null}
 */
export function handleHook(
  input,
  {
    harness = /** @type {H} */ ('claude'),
    rootDir = ROOT_DIR,
    now = new Date(),
    env = process.env,
    kick = kickWorker,
  } = {}
) {
  const normalized = normalizeHookInput(input, harness);
  const event = normalized.hook_event_name;
  if (env[EXTRACT_ENV] === '1' || SKIP_AGENTS.includes(normalized.agent_type)) {
    return null;
  }
  const home = mainCheckout(rootDir);
  const dir = memoryDir(home);
  if (!fs.existsSync(dir)) return null;
  const session =
    typeof normalized.session_id === 'string' &&
    SESSION_ID_RE.test(normalized.session_id)
      ? normalized.session_id
      : null;
  const store = { dir, session, now };
  const context = () =>
    taskContext({
      rootDir,
      session,
      cwd: typeof normalized.cwd === 'string' ? normalized.cwd : rootDir,
    });

  const entry = {
    session,
    harness,
    transcript: normalized.transcript_path,
    cwd: normalized.cwd,
    at: now.toISOString(),
  };
  const startWorker = (/** @type {boolean} */ orConsolidate) => {
    const work =
      readQueue(dir).length > 0 ||
      (orConsolidate && consolidationDue(home, { now }) !== null);
    if (work && !workerRunning(dir)) kick({ rootDir: home, env });
  };

  if (event === 'SessionEnd') {
    // Headless runs (--no-session-persistence) leave no transcript to read.
    const saved =
      typeof entry.transcript === 'string' && fs.existsSync(entry.transcript);
    if (saved && enqueue(dir, entry)) startWorker(false);
    return null;
  }
  if (event === 'SessionStart') {
    if (normalized.source !== 'resume') writeInjected(dir, session, new Set());
    pruneSessions(dir, now);
    registerOpen(dir, entry);
    catchUp(dir, { current: session, now });
    startWorker(true);
    const news = announcement(dir);
    const config = readConfig(dir);
    const off = savingOff(config, session);
    const parts = [
      startupMemory(rootDir, home, harness, config),
      config.personalizationEnabled ? '' : PERSONALIZATION_OFF,
      ...(off
        ? [
            `[Memory] Saving to memory is off ${off === 'global' ? 'everywhere' : 'for this session'}: do not save notes (pnpm memory add) unless the user asks; recall still works.`,
          ]
        : []),
      // Claude Code and Antigravity show the user a UI message; Codex relies on the agent.
      ...(news
        ? [
            harness === 'claude' || harness === 'agy'
              ? news
              : `${news}\nMention these saves to the user in one line.`,
          ]
        : []),
    ].filter(Boolean);
    const output = contextOutput(
      event,
      parts.join('\n\n'),
      harness,
      news ?? undefined
    );
    return /** @type {any} */ (
      output && news && harness === 'claude'
        ? { ...output, systemMessage: news }
        : output
    );
  }
  if (
    event === 'UserPromptSubmit' ||
    (harness === 'agy' && event === 'PreInvocation')
  ) {
    if (
      harness === 'agy' &&
      typeof normalized.invocationNum === 'number' &&
      normalized.invocationNum !== 0
    ) {
      return null;
    }
    const prompt =
      typeof normalized.prompt === 'string' ? normalized.prompt.trim() : '';
    // Slash commands, and queued background-task notifications (not typed).
    if (
      !prompt ||
      prompt.startsWith('/') ||
      prompt.startsWith('<task-notification>')
    ) {
      return null;
    }
    const { goal, repo } = context();
    const query = [prompt, goal].filter(Boolean).join('\n');
    const recalled = injectText(store, (notes, index) =>
      recall(notes, query, { index, repo, usage: readUsage(dir), now })
    );
    return /** @type {any} */ (
      contextOutput(
        event,
        [personaReminder(dir), recalled].filter(Boolean).join('\n\n'),
        harness
      )
    );
  }
  if (harness === 'agy' && event === 'PostInvocation') {
    const failures = recentAgyFailures(
      normalized.transcript_path,
      normalized.initialNumSteps
    );
    const query = failures
      .map((f) => `${f.command}\n${f.error.slice(0, ERROR_CHARS)}`)
      .join('\n')
      .trim();
    if (!query) return null;
    const { repo } = context();
    const recalled = injectText(store, (notes, index) =>
      recall(notes, query, {
        index,
        repo,
        failure: true,
        usage: readUsage(dir),
        now,
      })
    );
    return /** @type {any} */ (contextOutput(event, recalled, harness));
  }
  if (event === 'PreToolUse') {
    const command = commandOf(normalized);
    if (!command) return null;
    const recalled = injectText(store, (notes) =>
      matchTriggers(notes, command)
        .slice(0, RECALL_LIMIT)
        .map((note) => ({ note }))
    );
    return /** @type {any} */ (contextOutput(event, recalled, harness));
  }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const error = failureText(normalized);
    const query = [commandOf(normalized), error ?? ''].join('\n').trim();
    if (error === null || !query) return null;
    const { repo } = context();
    const recalled = injectText(store, (notes, index) =>
      recall(notes, query, {
        index,
        repo,
        failure: true,
        usage: readUsage(dir),
        now,
      })
    );
    return /** @type {any} */ (contextOutput(event, recalled, harness));
  }
  return null;
}

/**
 * Parse the hook's stdin and answer it; '' (or '{}' for Antigravity) when
 * there is nothing to say or anything goes wrong (a hook must never break the
 * session).
 *
 * @param {string} raw stdin
 * @param {HookOptions} [options]
 * @returns {string}
 */
export function runHook(raw, options = {}) {
  const empty = options.harness === 'agy' ? '{}' : '';
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const output = handleHook(input, options);
    return output ? JSON.stringify(output) : empty;
  } catch {
    return empty;
  }
}

/* c8 ignore start - stdin/stdout wiring; the logic is tested through runHook */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  const failOpen = () => {
    if (harness === 'agy') process.stdout.write('{}', () => process.exit(0));
    else process.exit(0);
  };
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    const out = runHook(data, { harness });
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
  process.stdin.on('error', failOpen);
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
