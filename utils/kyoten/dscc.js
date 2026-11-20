/**
 * dscc: Claude Code on the DeepSeek Anthropic-compatible API.
 *
 * The profile (`$DSCC_PROFILE`, else `dscc.env` in kyoten's config dir, so
 * outside every workspace) holds one literal `KEY=value` per line. It is
 * parsed, never executed. The key is never printed: `--show` masks it, and
 * `--set-key` reads it from a hidden prompt (or one line of piped stdin) and
 * writes the file with mode 0600 on POSIX.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readIfExists } from '../task/store.js';
import { configPath, expandHome } from './home.js';

export const TEMPLATE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'dscc.env.example'
);
export const TOKEN_KEY = 'ANTHROPIC_AUTH_TOKEN';
/**
 * Removed from the caller's environment before the profile applies: an
 * inherited key must not pick the account or the endpoint. The profile may
 * set either back on purpose.
 */
export const TOKEN_KEYS = [TOKEN_KEY, 'ANTHROPIC_API_KEY'];
/**
 * What a dscc launch removes from the caller's environment: every
 * ANTHROPIC_* name (endpoint, headers, account) and the switches that send
 * Claude Code to a cloud provider. Entries ending in `*` are name prefixes.
 */
export const DSCC_DROP = [
  'ANTHROPIC_*',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
];
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_URL = `https://${DEEPSEEK_HOST}/anthropic`;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_RE = /^(ANTHROPIC_|CLAUDE_CODE_)|^API_TIMEOUT_MS$/;

/**
 * @typedef {import('./home.js').UserDirs} UserDirs
 * @typedef {{ key: string, value: string, invalid?: true }} ProfileLine
 * @typedef {{ pairs: Map<string, string>, warnings: string[] }} Profile
 */

/** @param {UserDirs} dirs */
export function profilePath(dirs) {
  const custom = dirs.env.DSCC_PROFILE;
  if (custom) return path.resolve(expandHome(custom, dirs.homedir));
  return configPath(dirs, 'dscc.env');
}

/**
 * @param {string} raw
 * @returns {ProfileLine | null}  null for blanks, comments, and non-assignments
 */
export function parseLine(raw) {
  let line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.startsWith('export ')) line = line.slice('export '.length).trim();
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  return NAME_RE.test(key) ? { key, value } : { key, value, invalid: true };
}

/**
 * @param {string} text
 * @param {(name: string) => boolean} [allow]  names outside it are skipped with a warning
 * @returns {Profile}
 */
export function parseProfile(text, allow) {
  /** @type {Map<string, string>} */
  const pairs = new Map();
  /** @type {string[]} */
  const warnings = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const parsed = parseLine(raw);
    if (!parsed) return;
    if (parsed.invalid) {
      warnings.push(
        `line ${index + 1} skipped: not a variable name: ${parsed.key}`
      );
      return;
    }
    if (allow && !allow(parsed.key)) {
      warnings.push(
        `line ${index + 1} skipped: ${parsed.key} is not an ANTHROPIC_*, CLAUDE_CODE_*, or API_TIMEOUT_MS setting`
      );
      return;
    }
    pairs.set(parsed.key, parsed.value);
  });
  return { pairs, warnings };
}

/**
 * Show the ends of a long secret only; a short one could be read whole.
 *
 * @param {string | undefined} value
 */
export function mask(value) {
  if (!value) return '<not set>';
  if (value.length < 16) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** @param {string | undefined} value  empty, or a `<placeholder>` */
export function tokenUnset(value) {
  const v = (value ?? '').trim();
  return !v || /^<.*>$/.test(v);
}

/**
 * @param {string} file
 * @returns {string}
 */
function readProfileText(file) {
  const text = readIfExists(file);
  if (text === null) {
    throw new Error(`no dscc profile at ${file}.\nFix: kyoten dscc --set-key`);
  }
  return text;
}

/**
 * The profile as printable lines, the key masked.
 *
 * @param {string} file
 * @returns {string[]}
 */
export function showProfile(file) {
  const { pairs, warnings } = parseProfile(readProfileText(file));
  const lines = [`profile: ${file}`, ''];
  for (const [key, value] of pairs) {
    lines.push(`${key}=${TOKEN_KEYS.includes(key) ? mask(value) : value}`);
  }
  return [...lines, ...warnings.map((w) => `warning: ${w}`)];
}

/**
 * Write `content` to `file` through a temporary file in the same folder, so
 * a crash never leaves half a profile; 0600 on POSIX (the file holds a key).
 *
 * @param {string} file
 * @param {string} content
 */
function writePrivate(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX modes; %APPDATA% is private to the user.
  }
}

/**
 * Save `key` as the profile's token, creating the profile from the template
 * when it is missing. Other lines are kept as they are.
 *
 * @param {{ file: string, key: string, template?: string }} input
 * @returns {{ created: boolean }}
 */
export function setKey({ file, key, template = TEMPLATE_FILE }) {
  const token = key.trim();
  if (!token) throw new Error('no key entered; nothing changed');
  if (/\s/.test(token)) {
    throw new Error('the key contains spaces or line breaks; nothing changed');
  }
  let text = readIfExists(file);
  const created = text === null;
  if (text === null) {
    text = readIfExists(template);
    if (text === null) {
      throw new Error(
        `the profile template ${template} is missing.\nFix: reinstall kyoten`
      );
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (parseLine(line)?.key !== TOKEN_KEY) return line;
    found = true;
    return `${TOKEN_KEY}=${token}`;
  });
  if (!found) {
    // Keep a final newline final: insert before the empty last element.
    if (updated.at(-1) === '') updated.splice(-1, 0, `${TOKEN_KEY}=${token}`);
    else updated.push(`${TOKEN_KEY}=${token}`);
  }
  writePrivate(file, updated.join(eol));
  return { created };
}

/**
 * The environment changes for a dscc launch.
 *
 * @param {string} file
 * @returns {{ drop: string[], set: Record<string, string>, warnings: string[] }}
 */
export function dsccEnv(file) {
  const { pairs, warnings } = parseProfile(readProfileText(file), (name) =>
    ALLOWED_RE.test(name)
  );
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(pairs.get(BASE_URL_KEY) ?? '');
  } catch {
    // Missing or malformed: refused below.
  }
  if (url?.protocol !== 'https:') {
    throw new Error(
      `${BASE_URL_KEY} in ${file} must be an https URL (DeepSeek: ${DEEPSEEK_URL}).\nFix: set it in the profile, then try again`
    );
  }
  if (tokenUnset(pairs.get(TOKEN_KEY))) {
    throw new Error(
      `${TOKEN_KEY} is not set in ${file}.\nFix: kyoten dscc --set-key`
    );
  }
  if (url.hostname !== DEEPSEEK_HOST) {
    warnings.push(
      `${BASE_URL_KEY} points at ${url.hostname}, not ${DEEPSEEK_HOST}: the key is sent there`
    );
  }
  const set = Object.fromEntries(pairs);
  return { drop: DSCC_DROP, set, warnings };
}

/**
 * @typedef {{ isTTY?: boolean, isRaw?: boolean, setRawMode?: (mode: boolean) => unknown, setEncoding: (encoding: BufferEncoding) => unknown, resume: () => unknown, pause: () => unknown, on: (event: string, handler: (chunk: string) => void) => unknown, off: (event: string, handler: (chunk: string) => void) => unknown }} KeyInput
 * @typedef {{ write: (text: string) => unknown }} KeyOutput
 */

/**
 * Read a secret from a terminal without echo. Enter or Ctrl-D ends it,
 * Backspace deletes, Ctrl-C cancels, and escape sequences (arrow keys) are
 * skipped.
 *
 * @param {{ input: KeyInput, output: KeyOutput, prompt: string }} io
 * @returns {Promise<string>}
 */
export function readHidden({ input, output, prompt }) {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    const wasRaw = Boolean(input.isRaw);
    let value = '';
    let escaping = false;
    /** @param {Error} [error] */
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escaping) {
          escaping = !/[A-Za-z~]/.test(ch);
        } else if (ch === '\u001b') {
          escaping = true;
        } else if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          return finish();
        } else if (ch === '\u0003') {
          return finish(new Error('cancelled; nothing changed'));
        } else if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

/**
 * The first line of a piped stdin.
 *
 * @param {AsyncIterable<string | Buffer>} input
 * @returns {Promise<string>}
 */
export async function readFirstLine(input) {
  let text = '';
  for await (const chunk of input) {
    text += String(chunk);
    if (text.includes('\n')) break;
  }
  return text.split(/\r?\n/)[0];
}
