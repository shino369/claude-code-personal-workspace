/**
 * Session transcripts → the condensed text extraction reads (design §6 path
 * B): what the user typed, the agent's final reply of each turn, and failed
 * shell commands with their errors. Everything else (tool inputs and
 * results, thinking, hook output, subagent turns) is left out.
 *
 * Secrets never reach the extraction model: a failed command whose text
 * holds a secret is dropped whole, and secrets in the rest are redacted.
 * Notes refuse secrets anyway (store.js); this keeps them out of the prompt.
 *
 * One adapter per harness transcript format: Claude Code's JSONL and the
 * Codex rollout (dsh is a later phase).
 */
import fs from 'fs';
import { TAIL_CHUNK_BYTES } from '../harness/input.js';
import { findSecrets, redactSecrets } from '../redact.js';

/** Characters kept per item. */
export const ITEM_CHARS = { user: 2000, reply: 1500, command: 300, error: 500 };
/** Characters of condensed session one extraction reads (the newest part). */
export const SESSION_BUDGET = 24_000;
/** A session with less condensed text than this is not worth a model call. */
export const MIN_SESSION_CHARS = 200;

/** Typed text that is not a prompt: slash commands, their output, notices. */
const NOT_PROMPT_RE =
  /^(<command-name>|<command-message>|<local-command-|<task-notification>|\[Request interrupted)/;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ELLIPSIS = ' … ';

/**
 * @typedef {{ kind: 'user' | 'reply', text: string }
 *   | { kind: 'failure', command: string, error: string }} Item
 * @typedef {{ items: Item[], model: string | null, cwd: string | null, dropped: number }} Condensed
 *   `dropped`: failed commands left out because they held a secret
 */

/**
 * Text within `max` characters: as it is, else its head and tail.
 *
 * @param {string} text
 * @param {number} max
 */
export function clip(text, max) {
  if (text.length <= max) return text;
  const room = max - ELLIPSIS.length;
  const head = Math.ceil(room * 0.6);
  return `${text.slice(0, head)}${ELLIPSIS}${text.slice(text.length - (room - head))}`;
}

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The text of a message's content: a string, or its text blocks joined.
 *
 * @param {unknown} content
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * What the user typed in a transcript entry, or '' when it is not a prompt.
 *
 * @param {Record<string, any>} entry
 */
function promptOf(entry) {
  if (entry.isMeta || (entry.origin && entry.origin.kind !== 'human'))
    return '';
  const text = textOf(entry.message?.content).replace(REMINDER_RE, '').trim();
  return NOT_PROMPT_RE.test(text) ? '' : text;
}

/**
 * Condense a Claude Code transcript (JSONL lines).
 *
 * @param {string} text
 * @returns {Condensed}
 */
export function condenseClaude(text) {
  /** @type {Item[]} */
  const items = [];
  /** @type {Map<string, string>} tool_use id → Bash command */
  const commands = new Map();
  let model = null;
  let cwd = null;
  let dropped = 0;
  let reply = '';
  const flushReply = () => {
    if (reply) {
      items.push({
        kind: 'reply',
        text: clip(redactSecrets(reply), ITEM_CHARS.reply),
      });
    }
    reply = '';
  };

  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.isSidechain) continue;
    if (typeof entry.cwd === 'string') cwd = entry.cwd;
    const content = entry.message?.content;

    if (entry.type === 'assistant') {
      model = entry.requestedModel ?? entry.message?.model ?? model;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          if (block.text.trim()) reply = block.text.trim();
        } else if (
          block?.type === 'tool_use' &&
          block.name === 'Bash' &&
          typeof block.input?.command === 'string'
        ) {
          commands.set(block.id, block.input.command);
        }
      }
    } else if (entry.type === 'user') {
      const results = Array.isArray(content)
        ? content.filter((block) => block?.type === 'tool_result')
        : [];
      for (const block of results) {
        const command = commands.get(block.tool_use_id);
        if (!block.is_error || command === undefined) continue;
        if (findSecrets(command).length > 0) {
          dropped += 1;
          continue;
        }
        items.push({
          kind: 'failure',
          command: clip(command.trim(), ITEM_CHARS.command),
          error: clip(
            redactSecrets(textOf(block.content).trim()),
            ITEM_CHARS.error
          ),
        });
      }
      const prompt = results.length > 0 ? '' : promptOf(entry);
      if (prompt) {
        flushReply();
        items.push({
          kind: 'user',
          text: clip(redactSecrets(prompt), ITEM_CHARS.user),
        });
      }
    }
  }
  flushReply();
  return { items, model, cwd, dropped };
}

/** Codex user text that is injected context rather than a typed prompt. */
const CODEX_CONTEXT_RE =
  /^(# AGENTS\.md instructions|<(environment_context|user_instructions|instructions|subagent_notification|turn_aborted|user_shell_command|skill|codex_internal_context|goal_context|recommended_plugins|permissions|collaboration_mode|current_time_reminder|model_switch|hook_prompt)\b)/i;
/** Codex tools that run a shell command. */
const CODEX_SHELL_TOOLS = ['exec_command', 'shell', 'shell_command'];
const CODEX_EXIT_RE = /^(?:Process exited with code|Exit code:) (-?\d+)$/m;
const CODEX_OUTPUT_RE = /\nOutput:\n([\s\S]*)$/;

/**
 * What the user typed in a Codex user message. Codex labels each content
 * block (`content_item_kinds`: `user.text` is typed text); without labels,
 * known injected-context markers are skipped.
 *
 * @param {Record<string, any>} payload
 */
function codexPromptOf(payload) {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const kinds =
    payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const labeled = Array.isArray(kinds) && kinds.length === content.length;
  return content
    .filter(
      (block, i) =>
        block?.type === 'input_text' &&
        typeof block.text === 'string' &&
        (labeled
          ? kinds[i] === 'user.text'
          : !CODEX_CONTEXT_RE.test(block.text.trimStart()))
    )
    .map((block) => block.text.replace(REMINDER_RE, '').trim())
    .filter((text) => text && !NOT_PROMPT_RE.test(text))
    .join('\n');
}

/**
 * A shell command as text: a string, or an argv array joined.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function codexCommandOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ');
  }
  return undefined;
}

/**
 * A command's exit code and output from a function_call_output: the
 * unified-exec text ("Process exited with code N"), the shell text ("Exit
 * code: N"), or JSON with `metadata.exit_code`. null when it did not finish.
 *
 * @param {unknown} output a string, or content items
 * @returns {{ code: number, body: string } | null}
 */
function codexResultOf(output) {
  const text = Array.isArray(output)
    ? output
        .filter((block) => typeof block?.text === 'string')
        .map((block) => block.text)
        .join('\n')
    : output;
  if (typeof text !== 'string') return null;
  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const code = json?.metadata?.exit_code;
      return typeof code === 'number'
        ? { code, body: String(json.output) }
        : null;
    } catch {
      return null;
    }
  }
  const exit = CODEX_EXIT_RE.exec(text);
  if (!exit) return null;
  return { code: Number(exit[1]), body: CODEX_OUTPUT_RE.exec(text)?.[1] ?? '' };
}

/**
 * Condense a Codex rollout (JSONL lines): typed prompts from `message`
 * response items (role user), the last non-commentary assistant message of
 * each turn, and failed shell commands (`function_call` paired with its
 * `function_call_output` by call_id).
 *
 * @param {string} text
 * @returns {Condensed}
 */
export function condenseCodex(text) {
  /** @type {Item[]} */
  const items = [];
  /** @type {Map<string, string>} call_id → shell command */
  const commands = new Map();
  let model = null;
  let cwd = null;
  let dropped = 0;
  let reply = '';
  const flushReply = () => {
    if (reply) {
      items.push({
        kind: 'reply',
        text: clip(redactSecrets(reply), ITEM_CHARS.reply),
      });
    }
    reply = '';
  };

  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry.payload)) continue;
    const payload = entry.payload;

    if (entry.type === 'session_meta' || entry.type === 'turn_context') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      if (typeof payload.model === 'string') model = payload.model;
    } else if (entry.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'user') {
        const prompt = codexPromptOf(payload);
        if (prompt) {
          flushReply();
          items.push({
            kind: 'user',
            text: clip(redactSecrets(prompt), ITEM_CHARS.user),
          });
        }
      } else if (payload.type === 'message' && payload.role === 'assistant') {
        /** @type {any[]} */
        const content = Array.isArray(payload.content) ? payload.content : [];
        const said = content
          .filter(
            (block) =>
              block?.type === 'output_text' && typeof block.text === 'string'
          )
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (said && payload.phase !== 'commentary') reply = said;
      } else if (
        payload.type === 'function_call' &&
        CODEX_SHELL_TOOLS.includes(payload.name)
      ) {
        let args = null;
        try {
          args = JSON.parse(payload.arguments);
        } catch {
          continue;
        }
        const command = codexCommandOf(
          isObject(args) ? (args.cmd ?? args.command) : undefined
        );
        if (command !== undefined) commands.set(payload.call_id, command);
      } else if (payload.type === 'local_shell_call') {
        const command = codexCommandOf(payload.action?.command);
        if (command !== undefined) commands.set(payload.call_id, command);
      } else if (payload.type === 'function_call_output') {
        const command = commands.get(payload.call_id);
        const result = codexResultOf(payload.output);
        if (command === undefined || !result || result.code === 0) continue;
        if (findSecrets(command).length > 0) {
          dropped += 1;
          continue;
        }
        items.push({
          kind: 'failure',
          command: clip(command.trim(), ITEM_CHARS.command),
          error: clip(redactSecrets(result.body.trim()), ITEM_CHARS.error),
        });
      }
    }
  }
  flushReply();
  return { items, model, cwd, dropped };
}

const AGY_USER_REQUEST_RE =
  /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;
const AGY_EXIT_RE = /^Command exited with code (-?\d+)\.$/m;

/**
 * Extract the user prompt from an Antigravity `USER_INPUT` step's content.
 *
 * @param {unknown} content
 * @returns {string}
 */
function agyPromptOf(content) {
  if (typeof content !== 'string') return '';
  const matched = AGY_USER_REQUEST_RE.exec(content);
  const raw = (matched ? matched[1] : content).replace(REMINDER_RE, '').trim();
  return NOT_PROMPT_RE.test(raw) ? '' : raw;
}

/**
 * Error text of a failed Antigravity `GENERIC` tool result step, or null when
 * it succeeded. Antigravity records shell non-zero exits in `content` as
 * `Command exited with code N.` with `status: "DONE"`, and tool errors with
 * `status: "ERROR"`.
 *
 * @param {Record<string, any>} entry
 * @returns {string | null}
 */
function agyFailureText(entry) {
  const content = typeof entry.content === 'string' ? entry.content : '';
  const err = typeof entry.error === 'string' ? entry.error : '';
  const exit = AGY_EXIT_RE.exec(content);
  const failed =
    entry.status === 'ERROR' || (exit !== null && Number(exit[1]) !== 0);
  if (!failed) return null;
  return [err, content].filter(Boolean).join('\n');
}

/**
 * Condense an Antigravity CLI transcript (`transcript_full.jsonl`): typed
 * prompts from `USER_INPUT`, final text from `PLANNER_RESPONSE` per turn, and
 * failed `run_command` tool calls paired in order with their following
 * `GENERIC` tool result steps.
 *
 * @param {string} text
 * @returns {Condensed}
 */
export function condenseAgy(text) {
  /** @type {Item[]} */
  const items = [];
  /** @type {Record<string, any>[]} */
  let pendingCalls = [];
  let model = null;
  let dropped = 0;
  let reply = '';
  const flushReply = () => {
    if (reply) {
      items.push({
        kind: 'reply',
        text: clip(redactSecrets(reply), ITEM_CHARS.reply),
      });
    }
    reply = '';
  };

  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;

    if (entry.type === 'USER_INPUT') {
      pendingCalls = [];
      const prompt = agyPromptOf(entry.content);
      if (prompt) {
        flushReply();
        items.push({
          kind: 'user',
          text: clip(redactSecrets(prompt), ITEM_CHARS.user),
        });
      }
    } else if (entry.type === 'PLANNER_RESPONSE') {
      if (typeof entry.model === 'string') model = entry.model;
      if (typeof entry.content === 'string' && entry.content.trim()) {
        reply = entry.content.trim();
      }
      pendingCalls = Array.isArray(entry.tool_calls)
        ? [...entry.tool_calls]
        : [];
    } else if (entry.type === 'GENERIC' && pendingCalls.length > 0) {
      const call = pendingCalls.shift();
      if (
        call?.name !== 'run_command' ||
        typeof call.args?.CommandLine !== 'string'
      ) {
        continue;
      }
      const error = agyFailureText(entry);
      if (error === null) continue;
      if (findSecrets(call.args.CommandLine).length > 0) {
        dropped += 1;
        continue;
      }
      items.push({
        kind: 'failure',
        command: clip(call.args.CommandLine.trim(), ITEM_CHARS.command),
        error: clip(redactSecrets(error.trim()), ITEM_CHARS.error),
      });
    }
  }
  flushReply();
  return { items, model, cwd: null, dropped };
}

/**
 * Failed `run_command` steps from the latest Antigravity invocation, read from
 * the tail of `transcriptPath`. When `initialNumSteps` is given (as in
 * `PostInvocation`), only steps at or after that index are inspected; otherwise
 * the latest `PLANNER_RESPONSE` and its following `GENERIC` steps are used.
 *
 * @param {string | undefined} transcriptPath
 * @param {unknown} [initialNumSteps]
 * @returns {{ command: string, error: string }[]}
 */
export function recentAgyFailures(transcriptPath, initialNumSteps) {
  if (!transcriptPath) return [];
  let text;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_CHUNK_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  /** @type {Record<string, any>[]} */
  const entries = [];
  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(entry)) entries.push(entry);
  }
  const hasCutoff = typeof initialNumSteps === 'number';
  const relevant = hasCutoff
    ? entries.filter(
        (e) =>
          typeof e.step_index === 'number' && e.step_index >= initialNumSteps
      )
    : (() => {
        const idx = entries.findLastIndex((e) => e.type === 'PLANNER_RESPONSE');
        return idx === -1 ? [] : entries.slice(idx);
      })();
  /** @type {{ command: string, error: string }[]} */
  const failures = [];
  /** @type {Record<string, any>[]} */
  let pending = [];
  for (const entry of relevant) {
    if (entry.type === 'PLANNER_RESPONSE') {
      pending = Array.isArray(entry.tool_calls) ? [...entry.tool_calls] : [];
    } else if (entry.type === 'GENERIC' && pending.length > 0) {
      const call = pending.shift();
      if (
        call?.name !== 'run_command' ||
        typeof call.args?.CommandLine !== 'string'
      ) {
        continue;
      }
      const error = agyFailureText(entry);
      if (error !== null) {
        failures.push({ command: call.args.CommandLine, error });
      }
    }
  }
  return failures;
}

/** Transcript adapters by harness. */
export const TRANSCRIPT_ADAPTERS = {
  claude: condenseClaude,
  codex: condenseCodex,
  agy: condenseAgy,
};

/** @param {Item} item */
function formatItem(item) {
  if (item.kind === 'failure') {
    return `[failed command] $ ${item.command}\n${item.error}`;
  }
  return `${item.kind === 'user' ? '[user]' : '[assistant]'} ${item.text}`;
}

/**
 * The items as labeled paragraphs, newest kept within `budget` characters.
 *
 * @param {Item[]} items
 * @param {number} [budget]
 * @returns {{ text: string, omitted: number }}
 */
export function formatSession(items, budget = SESSION_BUDGET) {
  /** @type {string[]} */
  const kept = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const paragraph = formatItem(items[i]);
    const cost = paragraph.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > budget) break;
    kept.unshift(paragraph);
    used += cost;
  }
  const omitted = items.length - kept.length;
  if (omitted > 0) {
    kept.unshift(
      `(${omitted} earlier item${omitted === 1 ? '' : 's'} omitted)`
    );
  }
  return { text: kept.join('\n\n'), omitted };
}

/**
 * Whether a session has too little to learn from: no user message, or less
 * than MIN_SESSION_CHARS of condensed text.
 *
 * @param {Item[]} items
 */
export function isTrivial(items) {
  if (!items.some((item) => item.kind === 'user')) return true;
  const size = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === 'failure'
        ? item.command.length + item.error.length
        : item.text.length),
    0
  );
  return size < MIN_SESSION_CHARS;
}

/**
 * The complete lines a transcript gained since `offset` (bytes). A
 * transcript shorter than the offset was rewritten: read it from the start.
 *
 * @param {string} file
 * @param {number} offset
 * @returns {{ text: string, start: number, end: number } | null} null when missing
 */
export function readNewLines(file, offset) {
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  const start = content.length < offset ? 0 : offset;
  const last = content.lastIndexOf(0x0a);
  const end = last + 1 > start ? last + 1 : start;
  return { text: content.subarray(start, end).toString('utf-8'), start, end };
}
