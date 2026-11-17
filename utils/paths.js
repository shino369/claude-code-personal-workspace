/**
 * Path display helpers. Files are opened with native paths (`path.join`), but
 * every path a user or an agent reads — messages, NOTES.md, Markdown briefs,
 * JSON output — uses `/`, so the text is the same on Windows, macOS, and Linux.
 */
import path from 'path';

/**
 * A path with `/` separators (native `\` on Windows becomes `/`).
 *
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * `path.relative(from, to)` with `/` separators, for display.
 *
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function relPosix(from, to) {
  return toPosix(path.relative(from, to));
}
