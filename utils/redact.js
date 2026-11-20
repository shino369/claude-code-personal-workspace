/**
 * Secret rules shared by every path that must not keep a secret:
 *
 * - the audit logger redacts matches before a tool call is logged;
 * - memory writes (add, extraction, consolidation, import) refuse text with a match;
 * - memory export scans every file and stops on a match.
 *
 * Detection and redaction use the same rules, so `findSecrets(text)` is empty
 * exactly when `redactSecrets(text) === text`. Matching is pattern-based and
 * best-effort: it catches the common token shapes, not every secret.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose string values are always secret (e.g. `{ API_KEY: '...' }`). */
const SECRET_KEY_NAME = /(TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_KEY)/i;

/**
 * A value in `NAME=value` that refers to a secret without containing one: an
 * env reference (`$GITHUB_TOKEN`, `${X}`), a command substitution
 * (`$(gh auth token)`), a `<placeholder>`, or an already redacted value.
 * Case-sensitive, so `$ecret` and `$Secret1` still count as values.
 */
const REFERENCE_VALUE =
  /^(?:\$\{|\$\(|\$[A-Z_][A-Z0-9_]*\b|<[^>]*>$|\[REDACTED)/;

/**
 * @param {string} value
 * @returns {boolean}
 */
function isReference(value) {
  const unquoted = /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
  return REFERENCE_VALUE.test(unquoted);
}

/**
 * @typedef {object} SecretRule
 * @property {string} name stable id, reported by findSecrets
 * @property {RegExp} pattern global
 * @property {(match: string, ...groups: string[]) => string} replace
 */

/**
 * Ordered rules. PEM blocks and Bearer tokens run before the generic
 * `NAME=value` rule so multi-part secrets are removed whole.
 *
 * @type {readonly SecretRule[]}
 */
const SECRET_RULES = [
  {
    name: 'private-key',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: () => '[REDACTED PRIVATE KEY]',
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replace: () => `Bearer ${REDACTED}`,
  },
  {
    name: 'secret-assignment',
    pattern:
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|<[^>\n]*>|\S+)/gi,
    replace: (match, name, separator, value) =>
      isReference(value) ? match : `${name}${separator}${REDACTED}`,
  },
  {
    name: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'api-key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => REDACTED,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: () => REDACTED,
  },
];

/** Every rule name findSecrets can report, in rule order. */
export const SECRET_RULE_NAMES = SECRET_RULES.map((rule) => rule.name);

/**
 * @param {SecretRule} rule
 * @param {string} text
 * @returns {string}
 */
function applyRule(rule, text) {
  return text.replace(rule.pattern, rule.replace);
}

/**
 * Replace known secret patterns in a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  return SECRET_RULES.reduce((result, rule) => applyRule(rule, result), text);
}

/**
 * The names of the rules that match `text`, each once, in rule order. Empty
 * when the text holds no known secret.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findSecrets(text) {
  return SECRET_RULES.filter((rule) => applyRule(rule, text) !== text).map(
    (rule) => rule.name
  );
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecret(text) {
  return SECRET_RULES.some((rule) => applyRule(rule, text) !== text);
}

/**
 * Whether a key's string value should be treated as a secret
 * (`API_KEY`, `Password`, `gh_token`, …).
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  return SECRET_KEY_NAME.test(key);
}
