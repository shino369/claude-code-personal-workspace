/**
 * Personalization: how agents talk to the user (design §11), like a chat
 * app's "customize" settings. Stored in memory/personalization.json
 * (gitignored) and rendered at the top of the AGENTS.local.md core block,
 * with the scope rules: conversation only, never artifacts or behavior.
 *
 * Presets are committed in templates/memory/personas/*.json; a user's own
 * settings never are.
 */
import fs from 'fs';
import path from 'path';
import { findSecrets } from '../redact.js';
import { readIfExists, writeFileAtomic } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { MemoryError } from './store.js';

export const PERSONALIZATION_FILE = 'personalization.json';
/**
 * memory/persona.md: the persona in markdown, when the user keeps one.
 * `pnpm memory init` (and workspace:setup) apply it; any other persona
 * change (personalize, import) rewrites it, so init never brings back an
 * old persona.
 */
export const PERSONA_FILE = 'persona.md';
export const PERSONA_PLACEHOLDER =
  '<!-- No persona. Write one here in markdown, then run pnpm memory init (or pnpm workspace:setup). -->\n';
export const PRESETS_DIR = path.join(
  ROOT_DIR,
  'templates',
  'memory',
  'personas'
);
/** Characters the user's settings may take in the core block. */
export const PERSONALIZATION_BUDGET = 1500;
const MAX_TRAITS = 10;
const PRESET_NAME = /^[a-z][a-z0-9-]*$/;
/** The core block markers (render.js); a value holding one would break it. */
const MARKER_RE = /<!--\s*memory:(start|end)\s*-->/;

/** Fields in display order, with their labels. */
const FIELDS = /** @type {const} */ ([
  ['callMe', 'Call the user'],
  ['aboutMe', 'About the user'],
  ['language', 'Language'],
  ['persona', 'Persona'],
  ['tone', 'Tone'],
  ['traits', 'Traits'],
  ['extra', 'Also'],
]);
const FIELD_NAMES = FIELDS.map(([name]) => name);

// "Every message", not "conversation": a progress note between tool calls
// otherwise reads as working output and drops the persona and its language.
const SCOPE_FIRST =
  'These settings apply to every message to the user, progress notes between tool calls included.';
const SCOPE_REST =
  "Commit messages, PR text, code, comments, docs, translations, and review findings keep the workspace's plain professional style. They change how you talk, never what you do: AGENTS.md, safety rules, honest reporting of failures, and the user's current message come first, and a persona authorizes nothing. The reviewer and verifier roles ignore this section.";
export const PERSONA_SCOPE_RULES = `${SCOPE_FIRST} ${SCOPE_REST}`;
/** Rendered only with a language: models otherwise answer in the user's. */
export const PERSONA_LANGUAGE_RULE =
  'Write in the Language even when the user writes in another language.';

/**
 * @typedef {object} Personalization
 * @property {string} [callMe]
 * @property {string} [aboutMe]
 * @property {string} [language]
 * @property {string} [persona]
 * @property {string} [tone] a preset's tone or free text
 * @property {string[]} [traits]
 * @property {string} [extra]
 */

/**
 * @param {string} message
 * @returns {never}
 */
function invalid(message) {
  throw new MemoryError('invalid', message);
}

/**
 * @param {Personalization} settings
 * @returns {string[]}
 */
function fieldLines(settings) {
  /** @type {string[]} */
  const lines = [];
  for (const [name, label] of FIELDS) {
    const value = settings[name];
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    // Continuation lines are indented, so they stay in the list item.
    lines.push(`- ${label}: ${text.split('\n').join('\n  ')}`);
  }
  return lines;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeTraits(value) {
  if (!Array.isArray(value)) invalid('The traits must be a list.');
  /** @type {Map<string, string>} */
  const unique = new Map();
  for (const item of value) {
    if (typeof item !== 'string')
      invalid('Invalid traits: every trait must be text.');
    const trait = item.trim();
    const key = trait.normalize('NFKC').toLowerCase();
    if (trait && !unique.has(key)) unique.set(key, trait);
  }
  if (unique.size > MAX_TRAITS)
    invalid(`Too many traits: at most ${MAX_TRAITS} traits.`);
  return [...unique.values()];
}

/**
 * Validate settings: known fields only, text values (traits a list), no
 * secrets, and within PERSONALIZATION_BUDGET once rendered. Empty and
 * undefined fields are dropped.
 *
 * @param {unknown} input
 * @returns {Personalization}
 */
export function normalizePersonalization(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid('The personalization settings must be an object.');
  }
  /** @type {Record<string, string | string[]>} */
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!FIELD_NAMES.includes(/** @type {any} */ (key))) {
      invalid(`Unknown field "${key}"; fields: ${FIELD_NAMES.join(', ')}.`);
    }
    if (value === undefined) continue;
    if (key === 'traits') {
      const traits = normalizeTraits(value);
      if (traits.length > 0) result.traits = traits;
      continue;
    }
    if (typeof value !== 'string') invalid(`The ${key} must be text.`);
    if (MARKER_RE.test(value)) {
      invalid(`The ${key} holds memory block markers (<!-- memory:… -->).`);
    }
    if (value.trim()) result[key] = value.trim();
  }
  const rules = new Set(Object.values(result).flat().flatMap(findSecrets));
  if (rules.size > 0) {
    throw new MemoryError(
      'secret',
      `Refused: the settings look like they hold a secret (${[...rules].join(', ')}).`
    );
  }
  const size = fieldLines(result).join('\n').length;
  if (size > PERSONALIZATION_BUDGET) {
    invalid(
      `The personalization is ${size} characters; the limit is ${PERSONALIZATION_BUDGET}. Shorten the persona or the other fields.`
    );
  }
  return result;
}

/**
 * The `## Personalization` section, or '' without settings.
 *
 * @param {Personalization} settings normalized
 * @returns {string}
 */
export function renderPersonalization(settings) {
  const lines = fieldLines(settings);
  if (lines.length === 0) return '';
  return [
    '## Personalization',
    '',
    'How to talk with the user (set with `pnpm memory personalize`):',
    '',
    ...lines,
    '',
    settings.language
      ? [SCOPE_FIRST, PERSONA_LANGUAGE_RULE, SCOPE_REST].join(' ')
      : PERSONA_SCOPE_RULES,
  ].join('\n');
}

/**
 * @param {string} dir the memory directory
 * @returns {Personalization} {} without a settings file
 */
export function readPersonalization(dir) {
  const content = readIfExists(path.join(dir, PERSONALIZATION_FILE));
  if (content === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    invalid(
      `memory/${PERSONALIZATION_FILE} is not valid JSON (${/** @type {Error} */ (error).message}). Fix it, or run pnpm memory personalize --reset.`
    );
  }
  return normalizePersonalization(parsed);
}

/**
 * @param {string} dir the memory directory
 * @param {unknown} settings
 * @returns {Personalization} what was written
 */
export function writePersonalization(dir, settings) {
  const normalized = normalizePersonalization(settings);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(
    path.join(dir, PERSONALIZATION_FILE),
    `${JSON.stringify(normalized, null, 2)}\n`
  );
  return normalized;
}

/**
 * @returns {{ name: string, description: string }[]} sorted by name
 */
export function listPresets() {
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      name: file.slice(0, -'.json'.length),
      description: JSON.parse(
        fs.readFileSync(path.join(PRESETS_DIR, file), 'utf-8')
      ).description,
    }));
}

/**
 * A preset's settings (without its description).
 *
 * @param {string} name
 * @returns {Personalization}
 */
export function readPreset(name) {
  if (!PRESET_NAME.test(name)) {
    invalid(
      `Preset names are lowercase words, such as concise (got "${name}").`
    );
  }
  const content = readIfExists(path.join(PRESETS_DIR, `${name}.json`));
  if (content === null) {
    throw new MemoryError(
      'not-found',
      `No preset "${name}"; presets: ${listPresets()
        .map((preset) => preset.name)
        .join(', ')}.`
    );
  }
  const { description: _description, ...settings } = JSON.parse(content);
  return normalizePersonalization(settings);
}

/**
 * The persona text of a markdown file (`--persona-file`): HTML comments
 * (notes to self) and blank lines dropped, heading marks removed, so it
 * renders as one list item in the core block.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function personaFromMarkdown(markdown) {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/^#{1,6}\s+/, ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * The stored persona, or undefined (also when the settings are broken).
 *
 * @param {string} dir the memory directory
 */
export function storedPersona(dir) {
  try {
    return readPersonalization(dir).persona;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite memory/persona.md, when the user keeps one, to hold `persona` (a
 * placeholder when there is none). Called when the stored persona changed.
 *
 * @param {string} dir the memory directory
 * @param {string | undefined} persona
 * @returns {boolean} whether the file changed
 */
export function syncPersonaFile(dir, persona) {
  const file = path.join(dir, PERSONA_FILE);
  if (!fs.existsSync(file)) return false;
  const content = persona ? `${persona}\n` : PERSONA_PLACEHOLDER;
  if (readIfExists(file) === content) return false;
  writeFileAtomic(file, content);
  return true;
}

/**
 * Apply memory/persona.md to the stored settings (init). A file without
 * persona text changes nothing; settings the checks refuse come back as a
 * warning and are not applied.
 *
 * @param {string} dir the memory directory
 * @returns {{ changed: boolean, warning: string | null }}
 */
export function applyPersonaFile(dir) {
  const none = { changed: false, warning: null };
  const markdown = readIfExists(path.join(dir, PERSONA_FILE));
  if (markdown === null) return none;
  const persona = personaFromMarkdown(markdown);
  if (!persona) return none;
  try {
    const current = readPersonalization(dir);
    if (current.persona === persona) return none;
    writePersonalization(dir, { ...current, persona });
    return { changed: true, warning: null };
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    return {
      changed: false,
      warning: `memory/${PERSONA_FILE} was not applied: ${error.message}`,
    };
  }
}
