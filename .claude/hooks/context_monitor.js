#!/usr/bin/env node
/**
 * Context window monitor hook.
 *
 * Fires on UserPromptSubmit. Reads the session transcript to calculate actual
 * token usage from the API response metadata, then injects an additionalContext
 * warning so Claude can proactively manage context.
 *
 * Thresholds (fraction of the configured context window):
 *   <20%   — silent
 *   20-40% — informational note
 *   40-60% — save-progress warning
 *   60%+   — urgent, context likely degraded
 *
 * The window defaults to 1M tokens; set CLAUDE_CONTEXT_WINDOW to override.
 */
import fs from 'fs';
import { runIfMain } from '#utils/module-runner.js';

export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const THRESHOLDS = {
  note: 0.2,
  warn: 0.4,
  urgent: 0.6,
};

/**
 * Read the context window from the environment, falling back to the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function getContextWindow(env = process.env) {
  const raw = env.CLAUDE_CONTEXT_WINDOW;
  if (!raw) return DEFAULT_CONTEXT_WINDOW;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Format a token count for the warning message (1M, 200K, ...).
 *
 * @param {number} contextWindow
 * @returns {string}
 */
export function formatWindow(contextWindow) {
  if (contextWindow >= 1_000_000) {
    return `${contextWindow / 1_000_000}M`;
  }
  if (contextWindow >= 1_000) {
    return `${Math.round(contextWindow / 1_000)}K`;
  }
  return String(contextWindow);
}

/**
 * Extract cumulative input-token usage from the newest assistant entry in a
 * transcript. Returns null when the transcript is missing or has no usage data.
 *
 * Approximation: accurate when prompt caching is active. cache_read_input_tokens
 * reflects the full prior context served from cache; input_tokens is only the
 * new non-cached tokens for the turn. In low-cache sessions this undercounts.
 *
 * @param {string | undefined} transcriptPath
 * @returns {{ inputTokens: number } | null}
 */
export function getUsageFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const lines = fs
      .readFileSync(transcriptPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    // Find the last assistant message with usage data — it reflects cumulative context.
    let lastUsage = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.usage) {
          lastUsage = entry.message.usage;
          break;
        }
      } catch {
        // The last line may be partially written; skip and continue scanning upward.
      }
    }

    if (!lastUsage) return null;

    const inputTokens =
      (lastUsage.cache_read_input_tokens || 0) +
      (lastUsage.cache_creation_input_tokens || 0) +
      (lastUsage.input_tokens || 0);

    return { inputTokens };
  } catch {
    return null;
  }
}

/**
 * Build the warning text for a usage fraction, or null when below the note level.
 *
 * @param {number} usagePct
 * @param {number} [contextWindow]
 * @returns {string | null}
 */
export function buildMessage(usagePct, contextWindow = DEFAULT_CONTEXT_WINDOW) {
  if (usagePct < THRESHOLDS.note) return null;

  const pctStr = (usagePct * 100).toFixed(1);
  const windowLabel = formatWindow(contextWindow);

  if (usagePct < THRESHOLDS.warn) {
    return `[Context Monitor] Usage at ${pctStr}% of ${windowLabel} context window. Monitor progress — consider saving notes if this conversation continues to grow.`;
  }

  if (usagePct < THRESHOLDS.urgent) {
    return `[Context Monitor][WARNING] Usage at ${pctStr}% of ${windowLabel} context window. Save progress to output/tasks/<YYYYMMDD_task_name>/NOTES.md now. Prepare to urge the user to run /compact and start fresh if quality degrades. Delegate subtasks to subagents when possible.`;
  }

  return `[Context Monitor][URGENT] Usage at ${pctStr}% of ${windowLabel} context window — context likely degraded. IMMEDIATE ACTION: write current progress to output/tasks/<YYYYMMDD_task_name>/NOTES.md, urge the user to run /compact, then /clear to restore quality. Do NOT continue in this session for complex tasks.`;
}

/**
 * Convert hook input into hook output, or null when no warning is needed.
 *
 * @param {{ transcript_path?: string }} input
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object | null}
 */
export function processHookInput(input, env = process.env) {
  const usage = getUsageFromTranscript(input?.transcript_path);
  if (!usage) return null;

  const contextWindow = getContextWindow(env);
  const usagePct = usage.inputTokens / contextWindow;
  const message = buildMessage(usagePct, contextWindow);
  if (!message) return null;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message,
    },
  };

  // Show a visible status line in the UI for WARNING and URGENT levels only.
  if (usagePct >= THRESHOLDS.warn) {
    output.systemMessage = message;
  }

  return output;
}

/* istanbul ignore next - stdin handling is tested through processHookInput */
function main() {
  let inputData = '';

  if (process.stdin.isTTY) {
    process.exit(0);
  }

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    inputData += chunk;
  });

  process.stdin.on('end', () => {
    try {
      const hookInput = JSON.parse(inputData);
      const output = processHookInput(hookInput);

      if (output) {
        // Wait for stdout to flush before exiting; process.exit() during a
        // pending pipe write can truncate the hook output on Windows.
        process.stdout.write(JSON.stringify(output), () => process.exit(0));
        return;
      }

      process.exit(0);
    } catch {
      process.exit(0);
    }
  });

  process.stdin.on('error', () => process.exit(0));
}

runIfMain(import.meta.url, main);
