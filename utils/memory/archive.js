/**
 * Export and import (design §12): one `.tar.gz` with a manifest.json
 * (format, date, source machine, parts, counts, a SHA-256 per file).
 *
 * Parts: `memory` (the note log), `personalization` (the settings and the
 * user's part of AGENTS.local.md), `tasks` (task folders, without hidden
 * ones such as .trash and .sessions), `resources` (the gitignored
 * resources/ folder). Only regular files are exported; links are skipped.
 *
 * Export refuses files that match the secret rules unless allowed. Import
 * validates everything first (format, every path, entry types, checksums),
 * then merges: notes get new ids, with other machines' machine and repo
 * notes unchecked and duplicates skipped; settings fill only empty fields;
 * existing tasks and resources are kept. `--replace` takes over the store
 * and settings. Every import that changes the store takes a snapshot first.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { findSecrets } from '../redact.js';
import { formatLocal } from '../task/markdown.js';
import { TASKS_DIR, readIfExists, writeFileAtomic } from '../task/store.js';
import { refreshAfterWrite } from './context.js';
import {
  normalizePersonalization,
  readPersonalization,
  storedPersona,
  syncPersonaFile,
  writePersonalization,
} from './personalize.js';
import {
  AGENTS_LOCAL_FILE,
  CORE_END,
  CORE_START,
  TEMPLATE_FILE,
} from './render.js';
import { takeSnapshot } from './snapshot.js';
import {
  CACHE_DIR,
  LOG_FILE,
  MEMORY_DIR,
  MemoryError,
  addNote,
  assertNoSecrets,
  findNearDuplicate,
  loadNotes,
  memoryDir,
  normalizeInput,
  parseLog,
  replay,
} from './store.js';
import { TarError, gunzipLimited, packTar, unpackTar } from './tar.js';
import zlib from 'zlib';

export const ARCHIVE_FORMAT = 1;
export const MANIFEST_FILE = 'manifest.json';
export const PARTS = ['memory', 'personalization', 'tasks', 'resources'];
export const DEFAULT_PARTS = ['memory', 'personalization'];
export const RESOURCES_DIR = 'resources';
/** The most an archive may unpack to (a gzip bomb stops here). */
export const MAX_UNPACKED_BYTES = 1024 ** 3;
const LOG_PATH = `memory/${LOG_FILE}`;
const SETTINGS_PATH = 'personalization/personalization.json';
const INSTRUCTIONS_PATH = 'personalization/instructions.md';
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * @typedef {{ path: string, data: Buffer }} ArchiveFile
 * @typedef {{ notes: number, tasks: number, files: number }} Counts
 * @typedef {{ format: number, created: string, machine: string, parts: string[], counts: Counts, files: Record<string, string> }} Manifest
 * @typedef {{ manifest: Manifest, files: Map<string, Buffer> }} Archive
 * @typedef {import('./store.js').NoteInput} NoteInput
 * @typedef {import('./personalize.js').Personalization} Personalization
 *
 * @typedef {object} ImportPlan
 * @property {string[]} parts the parts imported (asked for and in the archive)
 * @property {string[]} warnings
 * @property {{ add: NoteInput[], duplicates: number, refused: number, invalid: string[] } | null} notes
 * @property {{ set: string[], kept: string[], settings: Personalization } | null} personalization
 * @property {'set' | 'kept' | 'same' | null} instructions
 * @property {string | null} instructionsText
 * @property {{ add: string[], skip: string[] } | null} tasks
 * @property {{ add: string[], skip: string[] } | null} resources paths under resources/
 *
 * @typedef {{ added: number, snapshot: string | null, warnings: string[] }} ImportResult
 */

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {Buffer} data */
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The parts named in a comma list, in the standard order; the defaults
 * when no list is given.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseParts(value) {
  if (value === undefined) return [...DEFAULT_PARTS];
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`Name at least one part: ${PARTS.join(', ')}.`);
  }
  for (const name of names) {
    if (!PARTS.includes(name)) {
      throw new Error(`Unknown part "${name}"; parts: ${PARTS.join(', ')}.`);
    }
  }
  return PARTS.filter((part) => names.includes(part));
}

/**
 * The user's part of AGENTS.local.md: everything before the core block.
 *
 * @param {string} text
 */
export function userInstructions(text) {
  const start = text.indexOf(CORE_START);
  return `${(start === -1 ? text : text.slice(0, start)).trimEnd()}\n`;
}

/**
 * The regular files under `dir` (relative, `/`-separated, sorted), and the
 * links and special files left out.
 *
 * @param {string} dir
 * @param {string} prefix archive path of `dir`
 * @returns {{ files: { path: string, file: string }[], skipped: string[] }}
 */
function walk(dir, prefix) {
  /** @type {{ path: string, file: string }[]} */
  const files = [];
  /** @type {string[]} */
  const skipped = [];
  const visit = (/** @type {string} */ folder, /** @type {string} */ rel) => {
    const names = fs.readdirSync(folder).sort();
    for (const name of names) {
      const file = path.join(folder, name);
      const entry = `${rel}/${name}`;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, entry);
      else if (stat.isFile()) files.push({ path: entry, file });
      else skipped.push(entry);
    }
  };
  visit(dir, prefix);
  return { files, skipped };
}

/**
 * Everything an export of `parts` holds, read from the checkout.
 *
 * @param {string} rootDir the checkout that holds memory/
 * @param {{ parts: string[], tasks: string[] }} options `tasks`: names, or all
 * @returns {{ files: ArchiveFile[], skipped: string[], counts: Counts }}
 */
export function collectExport(rootDir, { parts, tasks }) {
  const dir = memoryDir(rootDir);
  /** @type {ArchiveFile[]} */
  const files = [];
  /** @type {string[]} */
  const skipped = [];
  const counts = { notes: 0, tasks: 0, files: 0 };
  /** @param {string} file @param {string} entry */
  const take = (file, entry) => {
    const data = readIfExists(file);
    if (data !== null) files.push({ path: entry, data: Buffer.from(data) });
  };
  if (parts.includes('memory')) {
    take(path.join(dir, LOG_FILE), LOG_PATH);
    counts.notes = loadNotes(dir).notes.filter(
      (note) => note.status === 'active'
    ).length;
  }
  if (parts.includes('personalization')) {
    take(path.join(dir, 'personalization.json'), SETTINGS_PATH);
    const agents = readIfExists(path.join(rootDir, AGENTS_LOCAL_FILE));
    if (agents !== null) {
      files.push({
        path: INSTRUCTIONS_PATH,
        data: Buffer.from(userInstructions(agents)),
      });
    }
  }
  /** @param {string} folder @param {string} prefix */
  const takeTree = (folder, prefix) => {
    const tree = walk(folder, prefix);
    for (const item of tree.files) {
      files.push({ path: item.path, data: fs.readFileSync(item.file) });
    }
    skipped.push(...tree.skipped);
  };
  if (parts.includes('tasks')) {
    const root = path.join(rootDir, TASKS_DIR);
    const all = fs.existsSync(root)
      ? fs
          .readdirSync(root)
          .filter(
            (name) =>
              !name.startsWith('.') &&
              fs.lstatSync(path.join(root, name)).isDirectory()
          )
          .sort()
      : [];
    const names = tasks.length > 0 ? tasks : all;
    for (const name of names) {
      if (!all.includes(name)) {
        throw new Error(
          `No task folder ${TASKS_DIR}/${name}. Fix: pnpm task list --all`
        );
      }
      takeTree(path.join(root, name), `${TASKS_DIR}/${name}`);
    }
    counts.tasks = names.length;
  }
  if (parts.includes('resources')) {
    const root = path.join(rootDir, RESOURCES_DIR);
    if (fs.existsSync(root)) takeTree(root, RESOURCES_DIR);
  }
  counts.files = files.length;
  return { files, skipped, counts };
}

/**
 * Write an export. Refuses an existing file, and files that match the
 * secret rules unless `allowSecrets`.
 *
 * @param {string} rootDir
 * @param {{ parts: string[], tasks: string[], out: string, allowSecrets: boolean, now: Date, machine: string }} options
 * @returns {{ file: string, bytes: number, manifest: Manifest, skipped: string[], secrets: { path: string, rules: string[] }[] }}
 */
export function exportArchive(
  rootDir,
  { parts, tasks, out, allowSecrets, now, machine }
) {
  if (fs.existsSync(out)) {
    throw new Error(`${out} already exists. Fix: --out <another file>`);
  }
  const { files, skipped, counts } = collectExport(rootDir, { parts, tasks });
  const secrets = files
    .map((file) => ({
      path: file.path,
      rules: [...new Set(findSecrets(file.data.toString('utf-8')))],
    }))
    .filter((hit) => hit.rules.length > 0);
  if (secrets.length > 0 && !allowSecrets) {
    const many = secrets.length > 1;
    throw new Error(
      `Refused: ${count(secrets.length, 'file')} ${many ? 'look' : 'looks'} like ${many ? 'they hold secrets' : 'it holds a secret'}: ${secrets.map((hit) => `${hit.path} (${hit.rules.join(', ')})`).join('; ')}. Remove the secrets (or leave the files out with --include / --tasks), or pass --allow-secrets if you are sure.`
    );
  }
  /** @type {Manifest} */
  const manifest = {
    format: ARCHIVE_FORMAT,
    created: now.toISOString(),
    machine,
    parts,
    counts,
    files: Object.fromEntries(
      files.map((file) => [file.path, sha256(file.data)])
    ),
  };
  const tar = packTar(
    [
      {
        path: MANIFEST_FILE,
        type: 'file',
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      },
      ...files.map((file) => ({
        ...file,
        type: /** @type {const} */ ('file'),
      })),
    ],
    { mtime: now }
  );
  const data = zlib.gzipSync(tar);
  fs.writeFileSync(out, data, { flag: 'wx' });
  return { file: out, bytes: data.length, manifest, skipped, secrets };
}

/**
 * @param {number} bytes
 */
const size = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/**
 * @param {ReturnType<typeof exportArchive>} result
 * @param {string} cwd where paths are shown from
 * @returns {string[]}
 */
export function formatExport(result, cwd) {
  const { parts, counts } = result.manifest;
  return [
    `Exported ${parts.join(', ')} to ${path.relative(cwd, result.file)} (${count(counts.notes, 'note')}, ${count(counts.tasks, 'task')}, ${count(counts.files, 'file')}, ${size(result.bytes)}).`,
    ...(result.skipped.length > 0
      ? [
          `Skipped ${count(result.skipped.length, 'link or special file', 'links or special files')}: ${result.skipped.join(', ')}`,
        ]
      : []),
    ...(result.secrets.length > 0
      ? [
          `Warning: it holds possible secrets (--allow-secrets): ${result.secrets.map((hit) => hit.path).join(', ')}`,
        ]
      : []),
    'It holds your personal notes and settings: keep it private.',
  ];
}

/**
 * @param {string} entry
 * @param {string} why
 * @returns {never}
 */
function refuse(entry, why) {
  throw new Error(
    `Refused: the archive entry ${JSON.stringify(entry)} ${why}. Nothing was imported.`
  );
}

/**
 * Throw unless `entry` is a safe archive path inside one of the parts.
 *
 * @param {string} entry
 */
export function checkPath(entry) {
  if (!entry) refuse(entry, 'has no path');
  if (/[\0\\]/.test(entry)) refuse(entry, 'has a backslash or NUL in its path');
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
    refuse(entry, 'is an absolute path');
  }
  const segments = entry.split('/');
  if (segments.includes('..')) refuse(entry, 'climbs out of the archive (..)');
  if (segments.some((segment) => segment === '' || segment === '.')) {
    refuse(entry, 'has an empty or "." segment');
  }
  if (entry === MANIFEST_FILE) return;
  if (!PARTS.includes(segments[0])) {
    refuse(entry, `is outside the parts of an export (${PARTS.join(', ')})`);
  }
  if (segments[0] === TASKS_DIR && segments[1]?.startsWith('.')) {
    refuse(entry, 'is in a hidden tasks/ folder');
  }
}

/**
 * @param {string} why
 * @returns {never}
 */
function refuseArchive(why) {
  throw new Error(`Refused: ${why}. Nothing was imported.`);
}

/**
 * @param {unknown} parsed
 * @returns {Manifest}
 */
function checkManifest(parsed) {
  if (!isObject(parsed)) refuseArchive('the archive has no manifest.json');
  const manifest = /** @type {Record<string, any>} */ (parsed);
  if (manifest.format !== ARCHIVE_FORMAT) {
    refuseArchive(
      `the archive is format ${JSON.stringify(manifest.format)}; this version reads format ${ARCHIVE_FORMAT}`
    );
  }
  if (
    !Array.isArray(manifest.parts) ||
    !manifest.parts.every((/** @type {string} */ part) => PARTS.includes(part))
  ) {
    refuseArchive(`the manifest's parts must be some of ${PARTS.join(', ')}`);
  }
  if (!isObject(manifest.files)) refuseArchive('the manifest has no file list');
  for (const [entry, sum] of Object.entries(manifest.files)) {
    checkPath(entry);
    if (typeof sum !== 'string' || !SHA256_RE.test(sum)) {
      refuseArchive(`the manifest's checksum of ${entry} is not a SHA-256`);
    }
  }
  return /** @type {Manifest} */ (manifest);
}

/**
 * Read and validate an export: the gzip size limit, entry types (files and
 * folders only), every path, duplicates, the manifest, every checksum.
 * Throws before anything is written.
 *
 * @param {string} file
 * @returns {Archive}
 */
export function readArchive(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    throw new Error(`No file ${file}.`);
  }
  /** @type {import('./tar.js').TarEntry[]} */
  let entries;
  try {
    entries = unpackTar(gunzipLimited(raw, MAX_UNPACKED_BYTES));
  } catch (error) {
    /* c8 ignore next - unpackTar and gunzipLimited throw only TarError */
    if (!(error instanceof TarError)) throw error;
    refuseArchive(error.message.replace(/\.$/, ''));
  }
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const entry of entries) {
    checkPath(entry.path);
    if (entry.type !== 'file') continue;
    if (files.has(entry.path)) refuse(entry.path, 'is in the archive twice');
    files.set(entry.path, entry.data);
  }
  const manifestData = files.get(MANIFEST_FILE);
  let parsed = null;
  if (manifestData) {
    try {
      parsed = JSON.parse(manifestData.toString('utf-8'));
    } catch {
      refuseArchive('the manifest.json is not valid JSON');
    }
  }
  const manifest = checkManifest(parsed);
  files.delete(MANIFEST_FILE);
  for (const [entry, data] of files) {
    if (!Object.hasOwn(manifest.files, entry)) {
      refuse(entry, 'is not in the manifest');
    }
    if (sha256(data) !== manifest.files[entry]) {
      refuse(entry, 'does not match its checksum');
    }
  }
  for (const entry of Object.keys(manifest.files)) {
    if (!files.has(entry))
      refuse(entry, 'is listed in the manifest but missing');
  }
  return { manifest, files };
}

/**
 * @param {Archive} archive
 * @param {string} prefix
 * @returns {string[]} archive paths under `prefix/`
 */
const under = (archive, prefix) =>
  [...archive.files.keys()].filter((entry) => entry.startsWith(`${prefix}/`));

/**
 * @param {string} rootDir
 * @param {Archive} archive
 * @param {boolean} replace
 */
function planNotes(rootDir, archive, replace) {
  const data = archive.files.get(LOG_PATH);
  const parsed = parseLog(data ? data.toString('utf-8') : '');
  const replayed = replay(parsed.ops);
  const invalid = [
    ...parsed.problems.map((problem) => `log ${problem}`),
    ...replayed.problems.map((problem) => `log: ${problem}`),
  ];
  const existing = replace ? [] : loadNotes(memoryDir(rootDir)).notes;
  /** @type {import('./store.js').Note[]} */
  const planned = [];
  /** @type {NoteInput[]} */
  const add = [];
  let duplicates = 0;
  let refused = 0;
  for (const note of replayed.notes) {
    if (note.status !== 'active') continue;
    /** @type {NoteInput} */
    const input = {
      text: note.text,
      scope: note.scope,
      repo: note.repo,
      type: note.type,
      tags: note.tags,
      triggers: note.triggers,
      pinned: note.pinned,
      source: {
        via: 'import',
        ...(note.source.task ? { task: note.source.task } : {}),
      },
      // Machine and repo notes describe the machine they came from.
      unchecked: note.scope !== 'user',
    };
    try {
      assertNoSecrets(normalizeInput(input));
    } catch (error) {
      /* c8 ignore next - replayed notes are already valid; only secrets fail */
      if (!(error instanceof MemoryError) || error.code !== 'secret')
        throw error;
      refused += 1;
      continue;
    }
    if (findNearDuplicate([...existing, ...planned], note)) {
      duplicates += 1;
      continue;
    }
    planned.push(note);
    add.push(input);
  }
  return { add, duplicates, refused, invalid };
}

/**
 * @param {string} rootDir
 * @param {Archive} archive
 * @param {boolean} replace
 * @param {string[]} warnings
 */
function planPersonalization(rootDir, archive, replace, warnings) {
  const data = archive.files.get(SETTINGS_PATH);
  if (!data) return null;
  /** @type {Personalization} */
  let imported;
  try {
    imported = normalizePersonalization(JSON.parse(data.toString('utf-8')));
  } catch (error) {
    warnings.push(
      `Personalization skipped: ${/** @type {Error} */ (error).message}`
    );
    return null;
  }
  /** @type {Personalization} */
  let local = {};
  try {
    local = readPersonalization(memoryDir(rootDir));
  } catch {
    // A broken local file counts as empty; writing replaces it.
  }
  const fields = /** @type {(keyof Personalization)[]} */ (
    Object.keys(imported)
  );
  const set = replace
    ? fields
    : fields.filter((field) => local[field] === undefined);
  const kept = replace
    ? []
    : fields.filter(
        (field) =>
          local[field] !== undefined &&
          JSON.stringify(local[field]) !== JSON.stringify(imported[field])
      );
  /** @type {Record<string, unknown>} */
  const settings = replace ? { ...imported } : { ...local };
  if (!replace) for (const field of set) settings[field] = imported[field];
  return { set, kept, settings: /** @type {Personalization} */ (settings) };
}

/**
 * @param {string} rootDir
 * @param {Archive} archive
 * @param {boolean} replace
 * @param {string[]} warnings
 * @returns {{ instructions: ImportPlan['instructions'], instructionsText: string | null }}
 */
function planInstructions(rootDir, archive, replace, warnings) {
  const none = { instructions: null, instructionsText: null };
  const data = archive.files.get(INSTRUCTIONS_PATH);
  if (!data) return none;
  const text = data.toString('utf-8');
  if (text.includes(CORE_START) || text.includes(CORE_END)) {
    warnings.push(
      'The imported instructions contain the memory block markers; skipped.'
    );
    return none;
  }
  const rules = findSecrets(text);
  if (rules.length > 0) {
    warnings.push(
      `The imported instructions look like they hold a secret (${[...new Set(rules)].join(', ')}); skipped.`
    );
    return none;
  }
  const template = userInstructions(fs.readFileSync(TEMPLATE_FILE, 'utf-8'));
  const local = userInstructions(
    readIfExists(path.join(rootDir, AGENTS_LOCAL_FILE)) ?? template
  );
  const instructions =
    local.trim() === text.trim()
      ? 'same'
      : replace || local.trim() === template.trim()
        ? 'set'
        : 'kept';
  return { instructions, instructionsText: text };
}

/**
 * @param {string} rootDir
 * @param {Archive} archive
 * @param {string[]} warnings
 */
function planTasks(rootDir, archive, warnings) {
  const names = [
    ...new Set(under(archive, TASKS_DIR).map((entry) => entry.split('/')[1])),
  ];
  const skip = names.filter((name) =>
    fs.existsSync(path.join(rootDir, TASKS_DIR, name))
  );
  const add = names.filter((name) => !skip.includes(name));
  for (const name of add) {
    const state = archive.files.get(`${TASKS_DIR}/${name}/state.json`);
    let repo = null;
    try {
      repo = state ? JSON.parse(state.toString('utf-8')).repo : null;
    } catch {
      // A broken state is pnpm task's to report.
    }
    if (typeof repo === 'string' && !fs.existsSync(repo)) {
      warnings.push(
        `Task ${name} works in ${repo}, which does not exist here.`
      );
    }
  }
  return { add, skip };
}

/**
 * What an import would do; writes nothing (also the --dry-run output).
 *
 * @param {string} rootDir
 * @param {Archive} archive
 * @param {{ include: string[] | null, replace: boolean }} options
 * @returns {ImportPlan}
 */
export function planImport(rootDir, archive, { include, replace }) {
  /** @type {string[]} */
  const warnings = [];
  const available = archive.manifest.parts;
  for (const part of include ?? []) {
    if (!available.includes(part)) {
      warnings.push(`The archive has no ${part} part.`);
    }
  }
  const parts = available.filter((part) => !include || include.includes(part));
  const has = (/** @type {string} */ part) => parts.includes(part);
  const personal = has('personalization')
    ? planInstructions(rootDir, archive, replace, warnings)
    : { instructions: null, instructionsText: null };
  /** @type {{ add: string[], skip: string[] } | null} */
  let resources = null;
  if (has('resources')) {
    const files = under(archive, RESOURCES_DIR).map((entry) =>
      entry.slice(RESOURCES_DIR.length + 1)
    );
    const skip = files.filter((file) =>
      fs.existsSync(path.join(rootDir, RESOURCES_DIR, file))
    );
    resources = { add: files.filter((file) => !skip.includes(file)), skip };
  }
  return {
    parts,
    notes: has('memory') ? planNotes(rootDir, archive, replace) : null,
    personalization: has('personalization')
      ? planPersonalization(rootDir, archive, replace, warnings)
      : null,
    ...personal,
    tasks: has('tasks') ? planTasks(rootDir, archive, warnings) : null,
    resources,
    warnings,
  };
}

/**
 * Write a new file at `rootDir/entry`, unless a folder on the way is a link
 * here (it could point outside the checkout).
 *
 * @param {string} rootDir
 * @param {string} entry a checked archive path
 * @param {Buffer} data
 * @returns {string | null} why it was skipped
 */
function writeNew(rootDir, entry, data) {
  const segments = entry.split('/');
  for (let i = 1; i < segments.length; i++) {
    const folder = segments.slice(0, i).join('/');
    const stat = fs.lstatSync(path.join(rootDir, folder), {
      throwIfNoEntry: false,
    });
    if (stat?.isSymbolicLink()) {
      return `Skipped ${entry}: ${folder} is a link here.`;
    }
  }
  const file = path.join(rootDir, entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { flag: 'wx' });
  return null;
}

/**
 * Carry out a plan. Takes a snapshot first when the store or the settings
 * change, so `pnpm memory undo` can revert the import.
 *
 * @param {string} rootDir
 * @param {Archive} archive
 * @param {ImportPlan} plan
 * @param {{ now: Date, detail: string, replace?: boolean }} options
 * @returns {ImportResult}
 */
export function applyImport(
  rootDir,
  archive,
  plan,
  { now, detail, replace = false }
) {
  const dir = memoryDir(rootDir);
  const notes = plan.notes?.add ?? [];
  const settings = plan.personalization?.set.length
    ? plan.personalization
    : null;
  const instructions =
    plan.instructions === 'set' ? plan.instructionsText : null;
  const storeChanges =
    notes.length > 0 ||
    settings !== null ||
    instructions !== null ||
    (replace && plan.notes !== null);
  const snapshot = storeChanges
    ? takeSnapshot(rootDir, { reason: 'import', now, detail }).id
    : null;
  /** @type {string[]} */
  const warnings = [];

  if (replace && plan.notes !== null) {
    // The snapshot holds the old log; the caches belong to its ids.
    fs.rmSync(path.join(dir, LOG_FILE), { force: true });
    fs.rmSync(path.join(dir, CACHE_DIR), { recursive: true, force: true });
  }
  for (const input of notes) addNote(dir, input, { now, merge: false });
  if (settings) {
    const before = storedPersona(dir);
    const written = writePersonalization(dir, settings.settings);
    // memory/persona.md follows the imported persona, so init keeps it.
    if (written.persona !== before) syncPersonaFile(dir, written.persona);
  }
  if (instructions !== null) {
    const file = path.join(rootDir, AGENTS_LOCAL_FILE);
    const current = readIfExists(file);
    const start = current?.indexOf(CORE_START) ?? -1;
    const block =
      current !== null && start !== -1
        ? current.slice(start)
        : `${CORE_START}\n${CORE_END}\n`;
    writeFileAtomic(file, `${instructions.trimEnd()}\n\n${block}`);
  }
  for (const name of plan.tasks?.add ?? []) {
    for (const entry of under(archive, `${TASKS_DIR}/${name}`)) {
      const skipped = writeNew(
        rootDir,
        entry,
        /** @type {Buffer} */ (archive.files.get(entry))
      );
      if (skipped) warnings.push(skipped);
    }
  }
  for (const file of plan.resources?.add ?? []) {
    const entry = `${RESOURCES_DIR}/${file}`;
    const skipped = writeNew(
      rootDir,
      entry,
      /** @type {Buffer} */ (archive.files.get(entry))
    );
    if (skipped) warnings.push(skipped);
  }
  if (storeChanges) warnings.push(...refreshAfterWrite(rootDir));
  return { added: notes.length, snapshot, warnings };
}

/**
 * @param {string} iso
 */
function localTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : formatLocal(date, { withTime: true });
}

/**
 * What an import did, or would do (`result` null: a dry run).
 *
 * @param {{ file: string, manifest: Manifest, plan: ImportPlan, result: ImportResult | null }} input
 * @returns {string[]}
 */
export function formatImport({ file, manifest, plan, result }) {
  const dry = result === null;
  const machine =
    typeof manifest.machine === 'string'
      ? manifest.machine
      : 'an unknown machine';
  const from = `from ${machine}, ${localTime(String(manifest.created))}`;
  /** @type {string[]} */
  const lines = [
    dry
      ? `Dry run: import of ${file} (${from}); nothing was changed.`
      : `Imported ${file} (${from}).`,
  ];
  const { notes, personalization, tasks, resources } = plan;
  if (notes) {
    const added = result ? result.added : notes.add.length;
    const verb = dry ? 'would be added' : 'added';
    lines.push(
      `  Notes: ${[
        added > 0
          ? `${added} ${verb} (machine and repo notes start unchecked)`
          : `none ${verb}`,
        ...(notes.duplicates > 0 ? [`${notes.duplicates} already here`] : []),
        ...(notes.refused > 0
          ? [
              `${notes.refused} refused (${notes.refused === 1 ? 'it' : 'they'} held a secret)`,
            ]
          : []),
        ...notes.invalid.map((problem) => `skipped ${problem}`),
      ].join('; ')}`
    );
  }
  if (personalization) {
    const parts = [
      ...(personalization.set.length > 0
        ? [`${dry ? 'would set' : 'set'} ${personalization.set.join(', ')}`]
        : []),
      ...(personalization.kept.length > 0
        ? [
            `kept ${personalization.kept.join(', ')} (yours; --replace overwrites)`,
          ]
        : []),
    ];
    lines.push(
      `  Personalization: ${parts.length > 0 ? parts.join('; ') : 'nothing to set'}`
    );
  }
  if (plan.instructions) {
    /** @type {Record<string, string>} */
    const said = {
      set: `${dry ? 'would set' : 'set'} from the archive`,
      kept: 'kept yours (--replace overwrites)',
      same: 'already the same',
    };
    lines.push(`  Instructions: ${said[plan.instructions]}`);
  }
  if (tasks) {
    const parts = [
      ...(tasks.add.length > 0
        ? [`${dry ? 'would add' : 'added'} ${tasks.add.join(', ')}`]
        : []),
      ...(tasks.skip.length > 0
        ? [`skipped ${tasks.skip.join(', ')} (already here)`]
        : []),
    ];
    lines.push(`  Tasks: ${parts.length > 0 ? parts.join('; ') : 'none'}`);
  }
  if (resources) {
    const parts = [
      ...(resources.add.length > 0
        ? [
            `${count(resources.add.length, 'file')} ${dry ? 'would be added' : 'added'}`,
          ]
        : []),
      ...(resources.skip.length > 0
        ? [`${resources.skip.length} skipped (already here)`]
        : []),
    ];
    lines.push(`  Resources: ${parts.length > 0 ? parts.join('; ') : 'none'}`);
  }
  for (const warning of [...plan.warnings, ...(result?.warnings ?? [])]) {
    lines.push(`  Warning: ${warning}`);
  }
  if (result?.snapshot) {
    lines.push(
      `  Snapshot: ${MEMORY_DIR}/snapshots/${result.snapshot} (pnpm memory undo restores it)`
    );
  }
  return lines;
}
