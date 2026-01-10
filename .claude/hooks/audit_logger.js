#!/usr/bin/env node
/**
 * Audit logging hook for Claude Code.
 * Logs all tool usage to /logs/<YYYYMMDD>/logging.json
 */
const fs = require('fs');
const path = require('path');

function ensureLogDirectory() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const logDir = path.join('logs', today);

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  return path.join(logDir, 'logging.json');
}

function appendLogEntry(logFile, entry) {
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

function sanitizeForLogging(data, maxContentLength = 500) {
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

        // Remove undefined values for cleaner logs
        Object.keys(logEntry).forEach((key) => {
          if (logEntry[key] === undefined || logEntry[key] === null) {
            delete logEntry[key];
          }
        });

        // Append to log file
        appendLogEntry(logFile, logEntry);

        // Exit successfully
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

main();
