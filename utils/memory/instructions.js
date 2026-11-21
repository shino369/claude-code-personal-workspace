/**
 * Text that tries to steer an agent. Memory text reaches every later session
 * as context, so the store holds back what reads like an instruction:
 *
 * - INJECTION_PATTERNS: overrides of the agent's own instructions ("ignore
 *   the previous rules", role tags). A persona is checked against these.
 * - INSTRUCTION_PATTERNS: those plus text addressed to an agent ("you
 *   must …"). A note states a fact, so it is checked against these; a
 *   persona is written in the second person, so it is not.
 */

export const INJECTION_PATTERNS = [
  /\bignore\b[^.\n]{0,40}\b(instructions?|previous|prior|above|rules?|system)\b/i,
  /\bdisregard\b/i,
  /\bsystem\s+prompt\b/i,
  /\b(new|updated|hidden)\s+instructions?\b/i,
  /<\/?\s*(system|instructions?|assistant)\b/i,
  /(指示|命令).{0,10}(無視|忘れ)/,
  /システムプロンプト/,
  /忽略.{0,10}(指令|指示|提示)/,
  /(系統|系统)提示/,
];

const ADDRESSED_TO_AGENT =
  /\byou\s+(must|should|shall|need to|have to|are now|will now)\b/i;

export const INSTRUCTION_PATTERNS = [...INJECTION_PATTERNS, ADDRESSED_TO_AGENT];

/** @param {string} text */
export const looksLikeInstruction = (text) =>
  INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));

/**
 * The overrides in `text`, each quoted once, in the order they appear.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function injectionsIn(text) {
  const found = INJECTION_PATTERNS.map((pattern) => pattern.exec(text))
    .filter((match) => match !== null)
    .sort((a, b) => a.index - b.index)
    .map((match) => match[0]);
  return [...new Set(found)];
}
