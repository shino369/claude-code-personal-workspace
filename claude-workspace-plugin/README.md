# Claude Workspace Plugin

A comprehensive plugin for project workspace management with trilingual translation, context management, code review, testing, and development tools for Claude Code.

## Overview

This plugin provides a complete toolkit for software development, documentation, translation, and AI-assisted workflows. It includes commands, skills, custom agents, and automation hooks to enhance your Claude Code experience.

## Features

### Commands

- **`/claude-workspace:translate`** - Professional English ↔ Japanese ↔ Traditional Chinese translation
  - Three-stage workflow (Initial → Proofread → Refine)
  - File and URL translation support
  - 1,075+ technical terms across 6 engineering domains
  - Automatic encoding detection

### Skills (Progressively Disclosed Knowledge)

The plugin includes 9 specialized skills that extend Claude's capabilities:

1. **translation-expertise** - Translation methodology and best practices
2. **engineering-terminology** - 1,075+ technical terms across 6 engineering domains
3. **document-writing** - Writing conventions for English, Japanese, and Chinese
4. **web-content-fetcher** - Web content extraction and parsing guidance
5. **claude-code-development** - Creating Claude Code components (agents, skills, commands, hooks)
6. **code-review** - Software engineering best practices for code review
7. **javascript-testing** - JavaScript/Node.js testing with Vitest
8. **commit-messages** - Conventional commits standard
9. **context-manager** - Proactive context window management for optimal performance

### Custom Agents

Three specialized subagents for complex tasks:

1. **trilingual-translator** - Multi-stage translation with 3 roles (Initial → Proofread → Refine)
2. **security-reviewer** - Security vulnerability review and analysis
3. **test-runner** - Test execution and reporting in clean format

### Hooks (Automation)

Two event-driven hooks for workflow automation:

1. **audit_logger** - Automatically logs all tool usage to `/logs/<YYYYMMDD>/logging.json`
2. **auto_format** - Automatically formats files using prettier after Edit and Write operations

## Installation

### Local Testing

To test the plugin locally during development:

```bash
claude --plugin-dir ./claude-workspace-plugin
```

### From Marketplace

Once published to a marketplace, users can install with:

```bash
/plugin install claude-workspace
```

### Optional Setup: External Memory Files

The context-manager skill recommends using external memory files (SCRATCHPAD.md, plan.md) for session context. These files are meant for local use and should not be committed to version control.

**Recommended (but optional):**

Add the provided `.gitignore.recommended` patterns to your project's `.gitignore`:

```bash
# Review the recommended patterns
cat .gitignore.recommended

# Add to your project's .gitignore
cat .gitignore.recommended >> .gitignore
```

Or manually add these patterns:

```gitignore
# Claude Code External Memory
SCRATCHPAD.md
plan.md
logs/
```

**Note**: This step is completely optional. The plugin works without any gitignore changes - it's just a best practice for keeping temporary session files out of version control.

## Usage Examples

### Translation

```bash
# Translate text to English
/claude-workspace:translate --lang en "ぬるぽ ガッ"

# Translate a file to Japanese
/claude-workspace:translate --lang ja @README.md

# Translate a URL to Traditional Chinese
/claude-workspace:translate --lang cn --url https://example.com/article
```

### Context Management

The `context-manager` skill is automatically invoked when:
- Context usage approaches 20-40%
- Explanations are being repeated
- Output quality degrades

It provides strategies for:
- Scoping conversations per feature
- Using external memory files (SCRATCHPAD.md, plan.md)
- Delegating to subagents
- Copy-paste reset workflow
- Knowing when to clear context

### Code Review

The `code-review` skill provides best practices for:
- Code organization and structure
- Error handling
- Security concerns
- Test coverage
- Performance considerations

### Custom Agents

Use the custom agents for specialized tasks:

```
# Translation with multi-stage workflow
Request: "Use the trilingual-translator agent to translate this document"

# Security review
Request: "Use the security-reviewer agent to check this code for vulnerabilities"

# Test execution
Request: "Use the test-runner agent to run all tests and report results"
```

## Plugin Structure

```
claude-workspace-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── commands/
│   └── translate.md         # Translation command
├── skills/
│   ├── translation-expertise/
│   ├── engineering-terminology/
│   ├── document-writing/
│   ├── web-content-fetcher/
│   ├── claude-code-development/
│   ├── code-review/
│   ├── javascript-testing/
│   ├── commit-messages/
│   └── context-manager/
├── agents/
│   ├── trilingual-translator.md
│   ├── security-reviewer.md
│   └── test-runner.md
├── hooks/
│   ├── hooks.json           # Hook configuration
│   ├── audit_logger.js      # Audit logging hook
│   └── auto_format.js       # Auto-formatting hook
└── README.md                # This file
```

## Requirements

- Claude Code version 1.0.33 or later
- Node.js (for hooks and scripts)
- Optional: prettier (for auto-formatting hook)

## Configuration

The plugin includes sensible defaults, but you can customize behavior:

### Hook Customization

Edit `hooks/hooks.json` to modify hook behavior:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/audit_logger.js",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node hooks/auto_format.js",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Skill Customization

Each skill can be customized by editing its `SKILL.md` file in the `skills/` directory.

## Development

### Testing Changes

After making changes to the plugin:

1. Stop the current Claude Code session
2. Restart with the plugin directory:

```bash
claude --plugin-dir ./claude-workspace-plugin
```

3. Test your changes

### Adding New Components

#### Add a New Command

Create a new Markdown file in `commands/`:

```markdown
---
description: Brief description of what this command does
---

# Command Instructions

[Instructions for Claude on how to handle this command]
```

#### Add a New Skill

Create a new directory in `skills/` with a `SKILL.md` file:

```markdown
---
name: skill-name
description: When to use this skill
---

# Skill Content

[Knowledge and instructions for this skill]
```

#### Add a New Agent

Create a new Markdown file in `agents/`:

```markdown
---
name: agent-name
description: What this agent specializes in
tools: [Bash, Read, Write]  # Available tools
---

# Agent Instructions

[Instructions for this specialized agent]
```

## Troubleshooting

### Plugin Not Loading

1. Check Claude Code version: `claude --version` (must be 1.0.33+)
2. Verify plugin structure (ensure directories are at plugin root, not inside `.claude-plugin/`)
3. Check manifest file exists at `.claude-plugin/plugin.json`

### Commands Not Appearing

1. Restart Claude Code after changes
2. Run `/help` to see all available commands
3. Check command file has proper frontmatter with `description` field

### Hooks Not Running

1. Verify hooks.json syntax is correct
2. Check hook scripts are executable
3. Ensure Node.js is installed and in PATH
4. Check hook timeout settings

## Contributing

Contributions are welcome! Please:

1. Follow existing patterns for commands, skills, and agents
2. Include clear documentation in README
3. Test changes before submitting
4. Follow the plugin structure guidelines

## License

MIT

## Support

For issues, questions, or feature requests, please open an issue at:
https://github.com/yourusername/claude-workspace-plugin/issues

## Credits

Created for personal workspace management with Claude Code.

## Related Documentation

- [Claude Code Plugins Documentation](https://code.claude.com/docs/en/plugins.md)
- [Slash Commands](https://code.claude.com/docs/en/slash-commands)
- [Agent Skills](https://code.claude.com/docs/en/skills)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Hooks](https://code.claude.com/docs/en/hooks)
