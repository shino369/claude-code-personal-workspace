/**
 * Codex project trust, shared by pnpm workspace:setup and kyoten doctor.
 */

/**
 * Whether Codex config text marks `root` as a trusted project: a
 * `[projects."<root>"]` table holding `trust_level = "trusted"`. The text is
 * only matched, never printed.
 *
 * @param {string} text
 * @param {string} root
 * @returns {boolean}
 */
export function codexTrustsProject(text, root) {
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header =
      /^\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]/.exec(line);
    if (header) {
      const name = header[2] ?? header[1].replace(/\\(.)/g, '$1');
      inTable = name === root;
    } else if (line.startsWith('[')) {
      inTable = false;
    } else if (inTable && /^trust_level\s*=\s*["']trusted["']/.test(line)) {
      return true;
    }
  }
  return false;
}
