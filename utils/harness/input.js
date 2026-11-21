/**
 * What every hook needs to know about the harness that runs it, in one
 * shape. Hook scripts are written once and run under Claude Code, Codex,
 * DSH (its Claude hooks bridge), and Antigravity CLI (`agy`); each is started
 * with `--harness <name>` (default `claude`) and reads its payload through
 * these helpers.
 *
 * Payload differences this covers:
 * - Field casing: Antigravity uses camelCase (`conversationId`, `transcriptPath`,
 *   `hookEventName`, `lastUserInput`, `toolCall: { name, args }`); the others
 *   use snake_case (`session_id`, `transcript_path`, `hook_event_name`,
 *   `prompt`, `tool_name`, `tool_input`).
 * - Tool names: Claude `Bash`/`Edit`/`Write`/`Read`; Codex `Bash` for shell
 *   commands *and* shell-run `apply_patch`, plus an `apply_patch` tool; DSH
 *   `bash`/`pwsh`/`read`/`edit`/`write`/`apply_patch`/`str_replace_editor`;
 *   Antigravity `run_command`/`read_file`/`view_file`/`edit_file`/`write_file`/
 *   `write_to_file`/`replace_file_content`/`multi_replace_file_content`/
 *   `sed_file`/`notebook_edit`.
 * - Patch edits carry no file list: the files come from the patch headers.
 * - Transcripts: Claude JSONL with `message.usage`; Codex rollout JSONL with
 *   `token_count` events; Antigravity `transcript_full.jsonl` with
 *   `PLANNER_RESPONSE` token counts; DSH gives hooks none.
 *
 * Pure apart from reading a transcript file; fails soft (null, empty lists).
 */
import fs from 'fs';

export const HARNESSES = /** @type {const} */ ([
  'claude',
  'codex',
  'dsh',
  'agy',
]);
/** Bytes read per step when scanning a transcript from its end. */
export const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * @typedef {typeof HARNESSES[number]} Harness
 * @typedef {{ kind: 'shell' | 'edit' | 'read' | 'other', name: string, command: string, files: string[], dir?: string }} ToolEvent
 * @typedef {{ injectSteps: [{ systemMessage: { systemMessage: string, metadata?: { user_markdown: string } } }] }} AgyInjectOutput
 */

const SHELL_TOOLS = new Set(['Bash', 'bash', 'pwsh', 'run_command']);
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'edit',
  'write',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
]);
const READ_TOOLS = new Set(['Read', 'read', 'read_file', 'view_file']);
// Linear: `[^\n]*` cannot backtrack, and the trimming is done in code.
const PATCH_HEADER_RE =
  /^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\n]*)/gm;
/**
 * rtk (rtk-ai/rtk) subcommands that run the command after them as it is
 * (`rtk proxy rm x` runs `rm x`). Agents set up for rtk prefix every
 * command with `rtk` or `rtk proxy`, so guardrails must look past it.
 */
export const RTK_PASSTHROUGH = ['proxy', 'bypass', 'err', 'test', 'summary'];
/** rtk's global flags (`rtk --help`); none takes a value. */
export const RTK_FLAGS = [
  '-v',
  '-vv',
  '-vvv',
  '--verbose',
  '--ultra-compact',
  '--skip-env',
];
/** An optional `rtk [-flags] [passthrough]` prefix (`rtk git status` too). */
const RTK_PREFIX = String.raw`(?:(?:\S*[\\/])?rtk(?:\s+-[\w-]+)*\s+(?:(?:${RTK_PASSTHROUGH.join('|')})\s+)?)?`;
/**
 * The shell invocations Codex treats as `apply_patch`
 * (codex-rs/apply-patch/src/invocation.rs, `maybe_parse_apply_patch`):
 * `apply_patch`/`applypatch` directly; inside `bash|zsh|sh -c|-lc`,
 * `pwsh|powershell [-NoProfile] -Command`, or `cmd /c`; with an optional
 * `cd <dir> &&` first (group 1 is that dir). Looser than Codex on quoting:
 * a guard should over-detect. An rtk prefix may come before the shell or
 * before `apply_patch` (Codex does not intercept those, but rtk runs the
 * apply_patch Codex puts on PATH, so the patch still applies).
 */
const APPLY_PATCH_RE = new RegExp(
  String.raw`^\s*${RTK_PREFIX}(?:(?:\S*[\\/])?(?:bash|zsh|sh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-NoProfile\s+)?(?:-lc|-c|-Command|\/c)\s+)?(?:['"]\s*)?(?:cd\s+("[^"]*"|'[^']*'|[^\s&;|'"]+)\s*&&\s*)?${RTK_PREFIX}(?:apply_patch|applypatch)\b`,
  'i'
);

/** `apply_patch` anywhere, and a patch's first line (both linear). */
const APPLY_PATCH_WORD_RE = /\b(?:apply_patch|applypatch)\b/i;
const PATCH_BEGIN_RE = /^[ \t'"(]*\*\*\* Begin Patch\b/m;

/** A `cd <dir>` (group 1 the dir), as in APPLY_PATCH_RE; linear. */
const CD_RE = /(?:^|[\s;&|(])cd\s+("[^"]*"|'[^']*'|[^\s&;|'"()]+)/g;

/**
 * Where the `cd`s in `before` (the text up to `apply_patch`) leave the
 * patch's relative paths: each one joined to the last, an absolute or `~`
 * dir starting over. Undefined without a `cd`.
 *
 * @param {string} before
 * @returns {string | undefined}
 */
function cdDir(before) {
  let dir;
  for (const [, raw] of before.matchAll(CD_RE)) {
    const next = raw.replace(/^(["'])(.*)\1$/, '$2');
    dir =
      dir === undefined || /^(?:[\\/]|~|[A-Za-z]:)/.test(next)
        ? next
        : `${dir}/${next}`;
  }
  return dir;
}

/**
 * The harness named by `--harness`, else `claude`.
 *
 * @param {string[]} argv
 * @returns {Harness}
 */
export function parseHarness(argv) {
  const value = argv[argv.indexOf('--harness') + 1];
  return HARNESSES.find((name) => name === value) ?? 'claude';
}

/**
 * The project the session works in. Claude Code and the DSH bridge set
 * `CLAUDE_PROJECT_DIR`; Codex and Antigravity set nothing (and may inherit a
 * parent Claude session's value), so they get the workspace root the hook
 * script lives in.
 *
 * @param {{ harness: Harness, env: NodeJS.ProcessEnv, rootDir: string }} input
 * @returns {string}
 */
export function projectDir({ harness, env, rootDir }) {
  if (harness === 'codex' || harness === 'agy') return rootDir;
  return env.CLAUDE_PROJECT_DIR || rootDir;
}

/**
 * Normalize a harness hook payload into the shared snake_case shape every
 * hook reads. For Claude Code, Codex, and DSH this returns the object as-is;
 * for Antigravity (`agy`) it maps camelCase fields (`conversationId`,
 * `transcriptPath`, `hookEventName`, `lastUserInput`, `toolCall`) alongside
 * the original fields.
 *
 * @param {unknown} input
 * @param {Harness} [harness]
 * @returns {Record<string, any>}
 */
export function normalizeHookInput(input, harness = 'claude') {
  const raw =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? /** @type {Record<string, any>} */ (input)
      : {};
  if (harness !== 'agy') return raw;
  const toolCall =
    typeof raw.toolCall === 'object' && raw.toolCall !== null
      ? raw.toolCall
      : null;
  return {
    ...raw,
    ...(raw.session_id === undefined && raw.conversationId !== undefined
      ? { session_id: raw.conversationId }
      : {}),
    ...(raw.transcript_path === undefined && raw.transcriptPath !== undefined
      ? { transcript_path: raw.transcriptPath }
      : {}),
    ...(raw.hook_event_name === undefined && raw.hookEventName !== undefined
      ? { hook_event_name: raw.hookEventName }
      : {}),
    ...(raw.prompt === undefined && raw.lastUserInput !== undefined
      ? { prompt: raw.lastUserInput }
      : {}),
    ...(raw.tool_name === undefined && toolCall?.name !== undefined
      ? { tool_name: toolCall.name }
      : {}),
    ...(raw.tool_input === undefined && toolCall?.args !== undefined
      ? { tool_input: toolCall.args }
      : {}),
    ...(raw.tool_response === undefined &&
    typeof raw.error === 'string' &&
    raw.error
      ? { tool_response: { error: raw.error } }
      : {}),
  };
}

/**
 * Build an Antigravity `SessionStart` / `PreInvocation` / `PostInvocation`
 * step-injection payload. When `userMarkdown` is given, the UI renders it
 * inline alongside the system message.
 *
 * @param {string} text
 * @param {string} [userMarkdown]
 * @returns {AgyInjectOutput}
 */
export function agyInjectOutput(text, userMarkdown) {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text,
          ...(userMarkdown
            ? { metadata: { user_markdown: userMarkdown } }
            : {}),
        },
      },
    ],
  };
}

/**
 * The files a patch touches, in order, each once: `*** Add File:`,
 * `*** Update File:`, `*** Delete File:`, and `*** Move to:` headers.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function patchFiles(text) {
  if (typeof text !== 'string') return [];
  const files = [...text.matchAll(PATCH_HEADER_RE)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return [...new Set(files)];
}

/** @param {unknown} value */
const stringOrEmpty = (value) => (typeof value === 'string' ? value : '');

/**
 * A tool call in one shape, whatever the harness called the tool.
 *
 * @param {unknown} input the hook payload (PreToolUse or PostToolUse)
 * @returns {ToolEvent}
 */
export function toolEvent(input) {
  const payload = /** @type {Record<string, any>} */ (input ?? {});
  const name = stringOrEmpty(payload.tool_name ?? payload.toolCall?.name);
  const args = /** @type {Record<string, unknown>} */ (
    payload.tool_input ?? payload.toolCall?.args ?? {}
  );
  const rawCommand = args.command ?? args.CommandLine;
  const command = Array.isArray(rawCommand)
    ? rawCommand.join(' ')
    : stringOrEmpty(rawCommand);
  /** @param {ToolEvent['kind']} kind @param {string[]} [files] @param {string} [dir] */
  const event = (kind, files = [], dir) => ({
    kind,
    name,
    command,
    files,
    ...(dir ? { dir } : {}),
  });
  /** @param {unknown} file */
  const one = (file) => (typeof file === 'string' ? [file] : []);

  if (SHELL_TOOLS.has(name)) {
    const patch = APPLY_PATCH_RE.exec(command);
    if (!patch) {
      // Any other shape that runs apply_patch on a patch (`env apply_patch`,
      // `true && apply_patch`, `rtk run "apply_patch …"`) still applies it:
      // over-detect, so the guard checks its paths.
      const word = APPLY_PATCH_WORD_RE.exec(command);
      return word && PATCH_BEGIN_RE.test(command)
        ? event(
            'edit',
            patchFiles(command),
            cdDir(command.slice(0, word.index))
          )
        : event('shell');
    }
    return event(
      'edit',
      patchFiles(command),
      patch[1]?.replace(/^(["'])(.*)\1$/, '$2')
    );
  }
  if (name === 'apply_patch') {
    return event('edit', patchFiles(command || args.input));
  }
  if (EDIT_TOOLS.has(name)) {
    return event(
      'edit',
      one(args.file_path ?? args.notebook_path ?? args.Path ?? args.TargetFile)
    );
  }
  if (READ_TOOLS.has(name)) {
    return event('read', one(args.file_path ?? args.Path ?? args.AbsolutePath));
  }
  if (name === 'str_replace_editor') {
    return event(command === 'view' ? 'read' : 'edit', one(args.path));
  }
  return event('other');
}

/**
 * The newest JSON line of a file that `match` accepts, scanning from the end
 * a chunk at a time (transcripts grow to tens of MB). Lines that are not
 * JSON, such as one still being written, are skipped. Null when nothing
 * matches or the file cannot be read.
 *
 * @param {string} file
 * @param {(entry: any) => boolean} match
 * @returns {any}
 */
export function findLastLine(file, match) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let position = fs.fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(TAIL_CHUNK_BYTES, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, position);
      const data = Buffer.concat([chunk, rest]);
      let start = 0;
      if (position > 0) {
        // Bytes before the first newline may be the end of a line that
        // starts in an earlier chunk: carry them over unparsed.
        const newline = data.indexOf(10);
        if (newline === -1) {
          rest = data;
          continue;
        }
        rest = data.subarray(0, newline);
        start = newline + 1;
      }
      const lines = data.subarray(start).toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = parse(lines[i]);
        if (found !== undefined && match(found)) return found;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * @param {string} line
 * @returns {unknown} the parsed value, or undefined
 */
function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * How full the context window is, from the session transcript: `tokens` in
 * context and the model's `window` when the transcript records it (Codex),
 * else null (Claude and Antigravity: the window comes from config). Null
 * without usage data, and always for DSH, whose hooks get no transcript.
 *
 * - Claude: the newest assistant entry's usage (input + cache read + cache
 *   creation); accurate when prompt caching is active.
 * - Codex: the newest `token_count` event's `last_token_usage.total_tokens`,
 *   which is what Codex's own context meter counts.
 * - Antigravity: the newest `PLANNER_RESPONSE` entry's `input_tokens` +
 *   `cache_read_tokens`.
 *
 * @param {string | undefined} transcriptPath
 * @param {Harness} harness
 * @returns {{ tokens: number, window: number | null } | null}
 */
export function transcriptUsage(transcriptPath, harness) {
  if (!transcriptPath || harness === 'dsh') return null;
  if (harness === 'codex') {
    const entry = findLastLine(
      transcriptPath,
      (e) =>
        e?.type === 'event_msg' &&
        e.payload?.type === 'token_count' &&
        typeof e.payload.info?.last_token_usage?.total_tokens === 'number'
    );
    if (!entry) return null;
    const { info } = entry.payload;
    const window = info.model_context_window;
    return {
      tokens: info.last_token_usage.total_tokens,
      window: typeof window === 'number' && window > 0 ? window : null,
    };
  }
  if (harness === 'agy') {
    const entry = findLastLine(
      transcriptPath,
      (e) =>
        e?.type === 'PLANNER_RESPONSE' &&
        (typeof e.input_tokens === 'number' ||
          typeof e.cache_read_tokens === 'number')
    );
    if (!entry) return null;
    return {
      tokens: (entry.input_tokens || 0) + (entry.cache_read_tokens || 0),
      window: null,
    };
  }
  const entry = findLastLine(
    transcriptPath,
    (e) => e?.type === 'assistant' && e.message?.usage
  );
  if (!entry) return null;
  const usage = entry.message.usage;
  return {
    tokens:
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.input_tokens || 0),
    window: null,
  };
}
