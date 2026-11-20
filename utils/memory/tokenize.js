/**
 * Tokenizer for memory notes and queries, shared by near-duplicate detection
 * (store.js) and retrieval. Local, dependency-free, multilingual:
 *
 * - NFKC normalization (full-width → ASCII) and lowercasing;
 * - `Intl.Segmenter` word granularity, which segments Japanese and Chinese
 *   with Node's full ICU;
 * - a small English stoplist, and one- or two-character hiragana tokens
 *   (particles and inflections such as を, って, した) dropped;
 * - code tokens kept whole (`gh`, `403`, `github_token`, `test:unit`), plus
 *   their `_`/`.`/`:` parts so `token` finds `GITHUB_TOKEN`;
 * - plain English plurals folded to the singular (`tests` → `test`). Notes
 *   and queries go through the same folding, so an odd stem (`news` → `new`)
 *   still matches itself.
 */

const SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' });

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can do does for from had has have i ' +
    'if in into is it its me my of on or our so than that the their them ' +
    'then there these they this those to was we were what when which who ' +
    'will with you your'
  ).split(' ')
);

const SHORT_HIRAGANA = /^[\u3040-\u309f]{1,2}$/;
const COMPOUND_SEPARATOR = /[_.:]/;
/** Three or more letters plus `s`, but not `-ss`, `-us`, `-is` (access, status, analysis). */
const PLURAL = /^[a-z]{2,}[a-rt-z]s$/;
const NOT_PLURAL = /(?:us|is)$/;

/** @param {string} token */
const fold = (token) =>
  PLURAL.test(token) && !NOT_PLURAL.test(token) ? token.slice(0, -1) : token;

/** @param {string} token */
const isKept = (token) => !STOPWORDS.has(token) && !SHORT_HIRAGANA.test(token);

/**
 * Tokens of `text`, in order, with repeats (for term frequency).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  /** @type {string[]} */
  const tokens = [];
  const normalized = text.normalize('NFKC').toLowerCase();
  for (const { segment, isWordLike } of SEGMENTER.segment(normalized)) {
    if (!isWordLike || !isKept(segment)) continue;
    tokens.push(fold(segment));
    if (COMPOUND_SEPARATOR.test(segment)) {
      for (const part of segment.split(COMPOUND_SEPARATOR)) {
        if (part.length >= 2 && isKept(part)) tokens.push(fold(part));
      }
    }
  }
  return tokens;
}

/**
 * The distinct tokens of `text`.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function termSet(text) {
  return new Set(tokenize(text));
}

/**
 * Jaccard similarity of two token sets: |a ∩ b| / |a ∪ b|, 0 when both are
 * empty.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}
