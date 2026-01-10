#!/usr/bin/env node
/**
 * Audit logging hook for Claude Code.
 * Logs all tool usage to /logs/<YYYYMMDD>/logging.json
 */
import fs from 'fs';
import path from 'path';
import { runIfMain } from '#utils/module-runner.js';

export function ensureLogDirectory() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const logDir = path.join('logs', today);

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  return path.join(logDir, 'logging.json');
}

export function appendLogEntry(logFile, entry) {
  let logs = [];

  // Read existing logs
  if (fs.existsSync(logFile)) {
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      logs = JSON.parse(content);
      if (!Array.isArray(logs)) {
        logs = [logs];
      }
    } catch (_err) {
      // If file is corrupted, start fresh
      logs = [];
    }
  }

  // Append new entry
  logs.push(entry);

  // Write back
  fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf-8');
}

export function sanitizeForLogging(data, maxContentLength = 500) {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      if (
        ['content', 'new_source'].includes(key) &&
        typeof value === 'string' &&
        value.length > maxContentLength
      ) {
        sanitized[key] =
          value.slice(0, maxContentLength) +
          `... (truncated, total length: ${value.length})`;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeForLogging(value, maxContentLength);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  } else if (Array.isArray(data)) {
    return data.map((item) => sanitizeForLogging(item, maxContentLength));
  } else {
    return data;
  }
}

export function processHookInput(input) {
  // Get log file path
  const logFile = ensureLogDirectory();

  // Create log entry
  const logEntry = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    hook_event: input.hook_event_name,
    tool_name: input.tool_name,
    tool_input: sanitizeForLogging(input.tool_input || {}),
    tool_response: sanitizeForLogging(input.tool_response || {}),
    cwd: input.cwd,
    permission_mode: input.permission_mode,
  };

  // Remove undefined, null, and empty object values for cleaner logs
  Object.keys(logEntry).forEach((key) => {
    const value = logEntry[key];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    ) {
      delete logEntry[key];
    }
  });

  // Append to log file
  appendLogEntry(logFile, logEntry);
}

/* istanbul ignore next - stdin handling is tested via integration */
function main() {
  try {
    // Read hook input from stdin
    let inputData = '';
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk) => {
      inputData += chunk;
    });

    process.stdin.on('end', () => {
      try {
        const input = JSON.parse(inputData);
        processHookInput(input);
        process.exit(0);
      } catch (err) {
        console.error(`Audit logging error: ${err.message}`);
        process.exit(0); // Exit 0 to not block the operation
      }
    });
  } catch (err) {
    console.error(`Audit logging error: ${err.message}`);
    process.exit(0); // Exit 0 to not block the operation
  }
}

// Run main function only if executed directly (not imported)
runIfMain(import.meta.url, main);
