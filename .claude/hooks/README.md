# Claude Code Hooks

This directory contains hook scripts for Claude Code that automatically execute during various events.

## Installed Hooks

### 1. Audit Logger (`audit_logger.js`)

**Event:** PostToolUse (all tools)
**Purpose:** Records Claude Code's working history for audit and review purposes.

**What it does:**
- Logs all tool usage to `/logs/<YYYYMMDD>/logging.json`
- Creates a new log file for each day
- Records timestamps, tool names, inputs, outputs, and session information
- Truncates large content (>500 chars) to keep log files manageable

**Log Structure:**
```
logs/
└── 20260110/
    └── logging.json
```

**Log Entry Format:**
```json
{
  "timestamp": "2026-01-10T10:30:45.123Z",
  "session_id": "abc123...",
  "hook_event": "PostToolUse",
  "tool_name": "Edit",
  "tool_input": { "file_path": "...", "old_string": "..." },
  "tool_response": { "success": true },
  "cwd": "C:\\Users\\...",
  "permission_mode": "default"
}
```

### 2. Auto Formatter (`auto_format.js`)

**Event:** PostToolUse (Edit|Write tools)
**Purpose:** Automatically formats files using prettier after editing or writing.

**What it does:**
- Runs prettier on formattable files after Edit or Write operations
- Supports common file types: .js, .jsx, .ts, .tsx, .json, .css, .scss, .html, .md, .yaml, etc.
- Skips files that aren't formattable or don't exist
- Uses `pnpm` to run prettier (as per workspace configuration)

**Prerequisites:**
Prettier must be installed in the workspace. To install:
```bash
pnpm add -D prettier
```

**Optional:** Create a `.prettierrc` file to customize formatting:
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5"
}
```

## Hook Configuration

Hooks are configured in `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\\.claude\\hooks\\audit_logger.js\"",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR\\.claude\\hooks\\auto_format.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

## Viewing Hooks

To view and manage hooks interactively:
```
/hooks
```

## Debugging Hooks

To see detailed hook execution information:
```bash
claude --debug
```

## Security Notes

- Hooks run with your user permissions
- The audit logger creates files in the `/logs` directory (already in .gitignore)
- Hook scripts exit with code 0 on errors to avoid blocking operations
- Large content is truncated in audit logs to prevent excessive file sizes

## Disabling Hooks

To temporarily disable hooks, you can:
1. Run `/hooks` and remove the hooks from the UI
2. Edit `.claude/settings.json` and remove or comment out the hooks section
3. Restart Claude Code for changes to take effect

## References

- [Claude Code Hooks Documentation](https://code.claude.com/docs/en/hooks)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
