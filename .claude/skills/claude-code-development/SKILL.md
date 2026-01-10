---
name: claude-code-development
description: Expert knowledge in creating and configuring Claude Code components (subagents, skills, slash commands, hooks, MCP integrations). Use when the user asks to create, modify, or extend .claude/ directory components. Follows official best practices and documentation standards.
---

# Claude Code Development

## Overview

This skill provides comprehensive guidance for creating and configuring Claude Code components following official best practices. Use this when working with `.claude/` directory structure including agents, skills, commands, hooks, and MCP integrations.

## Official Documentation

All official documentation references are maintained in `docs/claude/README.md`. Always consult these references for the latest standards and best practices:

- [Claude Code Settings](https://code.claude.com/docs/en/settings.md)
- [Claude Code Memory Management](https://code.claude.com/docs/en/memory.md)
- [Claude Code Sub-agents Documentation](https://code.claude.com/docs/en/sub-agents.md)
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills.md)
- [Claude Code Slash Commands Documentation](https://code.claude.com/docs/en/slash-commands.md)
- [Claude Code Hooks Documentation](https://code.claude.com/docs/en/hooks.md)
- [Claude Code MCP Support](https://code.claude.com/docs/en/mcp.md)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md)

When creating new components, fetch and review the relevant documentation using the WebFetch tool.

## Component Types

### Subagents (.claude/agents/)

**Purpose**: Specialized AI assistants that handle specific types of tasks in isolated contexts.

**File Format**: Markdown with YAML frontmatter
**Location**: `.claude/agents/[agent-name].md`

**Required Frontmatter Fields**:

- `name`: Unique identifier (lowercase, hyphens only)
- `description`: When Claude should delegate to this subagent

**Optional Frontmatter Fields**:

- `tools`: Tool allowlist (Read, Write, Edit, Bash, Grep, Glob, etc.)
- `disallowedTools`: Tool denylist
- `model`: Model to use (sonnet, opus, haiku, inherit)
- `permissionMode`: Permission handling (default, acceptEdits, dontAsk, bypassPermissions, plan)
- `skills`: Skills to load into subagent context
- `hooks`: Lifecycle hooks (PreToolUse, PostToolUse, Stop)

**Structure**:

```markdown
---
name: agent-name
description: What this agent does and when to use it
tools: Read, Write, Grep, Glob
model: sonnet
skills: skill-name-1, skill-name-2
---

# Agent System Prompt

You are [description of agent's role and capabilities].

## Your Expertise

[Detailed capabilities]

## Workflow

[Step-by-step process the agent should follow]

## Guidelines

[Important rules and best practices]
```

**Best Practices**:

- **Clear descriptions**: Claude uses descriptions to decide when to delegate
- **Minimal tool access**: Only grant necessary tools for security
- **Focused purpose**: Each agent should excel at one specific task
- **Load relevant skills**: Use the skills field to inject expert knowledge
- **Document workflow**: Provide clear step-by-step processes

### Skills (.claude/skills/)

**Purpose**: Reusable knowledge packages that can be loaded into conversations or subagents.

**File Format**: Markdown with YAML frontmatter
**Location**: `.claude/skills/[skill-name]/SKILL.md`

**Required Frontmatter Fields**:

- `name`: Skill identifier (lowercase, hyphens only, max 64 chars)
- `description`: What the skill does and when to use it (max 1024 chars)

**Optional Frontmatter Fields**:

- `allowed-tools`: Tools that can be used without permission when skill is active
- `model`: Model to use when skill is active
- `context`: Set to `fork` to run in isolated context
- `agent`: Agent type to use with `context: fork`
- `hooks`: Lifecycle hooks scoped to skill execution
- `user-invocable`: Whether skill appears in slash command menu (default: true)

**Structure**:

```markdown
---
name: skill-name
description: Clear description of what this skill does and when Claude should use it
---

# Skill Name

## Overview

[Brief overview of the skill's purpose]

## Core Content

[Main knowledge, organized with clear headings]

## Examples

[Concrete examples of using this knowledge]

## Best Practices

[Guidelines for applying this knowledge]
```

**Progressive Disclosure Pattern**:
For large skills (>500 lines), split content into multiple files:

```
skill-name/
├── SKILL.md              # Main overview with links to details
├── reference.md          # Detailed reference information
├── examples.md           # Usage examples
└── scripts/
    └── helper.py         # Utility scripts (executed, not loaded)
```

In SKILL.md:

```markdown
## Quick Start

[Essential info here]

## Detailed Reference

See [reference.md](reference.md) for complete API details.

## Examples

See [examples.md](examples.md) for usage patterns.

## Utility Scripts

Run `python scripts/helper.py` to validate...
```

**Best Practices**:

- **Be concise**: Only include what Claude doesn't already know
- **Use progressive disclosure**: Link to additional files for details
- **One level deep**: Don't nest references (SKILL.md → reference.md, not SKILL.md → advanced.md → details.md)
- **Table of contents**: For files >100 lines, include a TOC at the top
- **Clear descriptions**: Include trigger terms users would naturally say
- **Avoid time-sensitive info**: Don't include dates or versions that will become outdated

### Slash Commands (.claude/commands/)

**Purpose**: User-invocable prompts that provide reusable workflows.

**File Format**: Markdown with YAML frontmatter
**Location**: `.claude/commands/[command-name].md`

**Required Frontmatter**:

- `description`: What the command does (shown in /help)

**Optional Frontmatter**:

- `argument-hint`: Syntax hint for arguments (e.g., `[--lang <en|ja|cn>] <text>`)
- `allowed-tools`: Tools the command can use
- `model`: Model to use for this command
- `disable-model-invocation`: Prevent Skill tool from calling this command
- `hooks`: Command-scoped hooks

**Structure**:

```markdown
---
description: Brief description of what this command does
argument-hint: [--option <value>] <content>
allowed-tools: Task(agent-name), Read, Write
---

# Command Name

## Parse Arguments

Command arguments: `$ARGUMENTS`

Extract:

- `$1` - First argument
- `$2` - Second argument
- `$ARGUMENTS` - All arguments

## Your Task

1. Parse the arguments
2. If required arguments missing, ask user with AskUserQuestion
3. Perform the task or delegate to subagent
4. Return results to user

## Examples

**Example 1**: `/command arg1 arg2`
→ [Description of what happens]

**Example 2**: `/command @file.md`
→ [Description of what happens]
```

**Best Practices**:

- **User-facing**: Commands are for users, not internal automation
- **Clear descriptions**: Appear in `/help` menu
- **Argument handling**: Use `$ARGUMENTS` or `$1`, `$2`, etc.
- **Delegate to subagents**: Complex tasks should use Task tool with subagents
- **File references**: Support `@filename` syntax for file inputs

### Hooks (.claude/hooks/)

**Purpose**: Scripts that run automatically on tool events.

**Configuration**: In `.claude/settings.json` or component frontmatter

**Hook Events**:

- `PreToolUse`: Before a tool is used (matcher: tool name)
- `PostToolUse`: After a tool is used (matcher: tool name)
- `SubagentStart`: When a subagent begins (matcher: agent name)
- `SubagentStop`: When a subagent completes (matcher: agent name)
- `Stop`: When a component finishes (no matcher)

**Hook Types**:

- `command`: Execute a shell command
- `prompt`: Inject text into context

**Structure in settings.json**:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/validate.sh $TOOL_INPUT",
            "once": false
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/lint.sh"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "translator",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/setup-translation-env.sh"
          }
        ]
      }
    ]
  }
}
```

**Structure in Component Frontmatter**:

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
          once: true
  Stop:
    - hooks:
        - type: command
          command: "./scripts/cleanup.sh"
```

**Best Practices**:

- **Use for validation**: PreToolUse hooks can block unsafe operations
- **Scope appropriately**: Component-scoped hooks clean up automatically
- **Performance**: Keep hooks fast; they run on every matching event
- **Error handling**: Hooks that exit with non-zero code block the operation
- `once: true`: For one-time setup operations

## Component Interaction

### Skills in Subagents

Subagents can load skills by listing them in the `skills` frontmatter field:

```yaml
---
name: my-agent
description: Agent description
skills: skill-one, skill-two, skill-three
---
```

**Important**: The full skill content is injected at subagent startup, not just made available for invocation.

### Commands Invoking Subagents

Commands should use the Task tool to delegate to subagents:

```markdown
---
allowed-tools: Task(subagent-name)
---

## Your Task

Invoke the subagent to perform the work:

Use the Task tool with:

- subagent_type: "subagent-name"
- prompt: "Detailed task description with all context"
```

### Tool Restrictions

**Subagents inherit tools by default**. Restrict with:

- `tools: Read, Write, Grep` (allowlist)
- `disallowedTools: Bash, Edit` (denylist)

**Skills can specify allowed tools** for operations within skill scope:

```yaml
allowed-tools: Read, Bash(python:*)
```

## Directory Structure

Standard layout for a well-organized `.claude/` directory:

```
.claude/
├── settings.json              # Project-level configuration
├── agents/
│   ├── agent-name-1.md
│   └── agent-name-2.md
├── skills/
│   ├── skill-name-1/
│   │   ├── SKILL.md
│   │   ├── reference.md       # Progressive disclosure
│   │   └── scripts/
│   │       └── helper.py
│   └── skill-name-2/
│       └── SKILL.md
├── commands/
│   ├── command-1.md
│   └── command-2.md
└── hooks/
    ├── README.md              # Hook documentation
    └── scripts/
        ├── validate.sh
        └── lint.sh
```

## Naming Conventions

**Agents**: `lowercase-with-hyphens`

- Good: `code-reviewer`, `test-runner`, `db-analyzer`
- Avoid: `CodeReviewer`, `test_runner`, `DBAnalyzer`

**Skills**: `lowercase-with-hyphens` (gerund form preferred)

- Good: `processing-pdfs`, `analyzing-data`, `reviewing-code`
- Acceptable: `pdf-processing`, `data-analysis`, `code-review`
- Avoid: `helper`, `utils`, `tools` (too vague)

**Commands**: `lowercase-with-hyphens`

- Good: `translate`, `deploy-staging`, `run-tests`
- Avoid: `doTranslate`, `Deploy_Staging`

**Files**: Always use `.md` extension for agents, skills, and commands

## Common Patterns

### Pattern 1: Read-Only Exploration Agent

```yaml
---
name: explorer
description: Explore codebase to find information. Use proactively when researching code.
tools: Read, Grep, Glob
model: haiku
permissionMode: plan
---
```

### Pattern 2: Validation Hook

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-bash-command.sh $TOOL_INPUT"
```

### Pattern 3: Multi-Stage Workflow Command

```markdown
---
description: Multi-stage workflow with subagent
allowed-tools: Task(workflow-agent)
---

## Workflow

1. Parse user input
2. Validate requirements
3. Invoke subagent with Task tool
4. Present results
```

### Pattern 4: Skill with Progressive Disclosure

```markdown
---
name: large-skill
description: Comprehensive knowledge area
---

# Large Skill

## Quick Start

[Essential info]

## Detailed Topics

- **Topic 1**: See [topic1.md](topic1.md)
- **Topic 2**: See [topic2.md](topic2.md)
- **Examples**: See [examples.md](examples.md)
```

## Quality Checklist

Before finalizing new components:

**All Components**:

- [ ] Valid YAML frontmatter (no syntax errors)
- [ ] Clear, descriptive name
- [ ] Comprehensive description with trigger terms
- [ ] Follows naming conventions
- [ ] No time-sensitive information

**Subagents**:

- [ ] Focused, single-purpose design
- [ ] Minimal tool access (only what's needed)
- [ ] Clear system prompt with workflow
- [ ] Skills list only includes what's needed
- [ ] Tested with representative tasks

**Skills**:

- [ ] Concise content (assume Claude is smart)
- [ ] SKILL.md under 500 lines (or uses progressive disclosure)
- [ ] References are one level deep
- [ ] Table of contents for files >100 lines
- [ ] Examples are concrete, not abstract

**Commands**:

- [ ] User-facing and intuitive
- [ ] Argument handling is clear
- [ ] Delegates to subagents for complex work
- [ ] Includes usage examples
- [ ] Appears correctly in /help

**Hooks**:

- [ ] Fast execution (avoid slow operations)
- [ ] Clear purpose and scope
- [ ] Proper error handling
- [ ] Scripts have execute permissions
- [ ] Uses `once: true` when appropriate

## Development Workflow

### Creating a New Subagent

1. **Identify the need**: What task needs isolation or specialized behavior?
2. **Design the interface**: What inputs does it need? What outputs should it provide?
3. **Create the file**: `.claude/agents/[name].md`
4. **Write the frontmatter**: name, description, tools, model, skills
5. **Write the system prompt**: Clear role, expertise, workflow, guidelines
6. **Test**: Use `/agents` to verify it appears, then test with real tasks
7. **Iterate**: Refine based on observed behavior

### Creating a New Skill

1. **Identify the knowledge gap**: What does Claude need to know?
2. **Gather information**: Collect terminology, patterns, best practices
3. **Organize content**: Structure with clear sections and headings
4. **Create the file**: `.claude/skills/[name]/SKILL.md`
5. **Write frontmatter**: name, description with trigger terms
6. **Write content**: Be concise, use examples, avoid verbosity
7. **Test**: Load the skill and verify it applies knowledge correctly
8. **Refine**: Adjust based on how Claude uses the skill

### Creating a New Command

1. **Define the use case**: What user task should this simplify?
2. **Design the syntax**: What arguments make sense?
3. **Create the file**: `.claude/commands/[name].md`
4. **Write frontmatter**: description, argument-hint, allowed-tools
5. **Write the prompt**: Argument parsing, validation, task execution
6. **Test**: Run `/help` to see it listed, then test with various inputs
7. **Document**: Add examples for common use cases

## Troubleshooting

### Component Not Loading

**Subagent doesn't appear**:

- Check file is in `.claude/agents/`
- Verify YAML frontmatter is valid
- Restart Claude Code session
- Use `/agents` to list all agents

**Skill not available**:

- Check file is in `.claude/skills/[name]/SKILL.md`
- Verify frontmatter has valid name and description
- For subagent skills, check skills list in agent frontmatter
- Restart session if needed

**Command not in /help**:

- Check file is in `.claude/commands/`
- Verify frontmatter has description field
- Check for YAML syntax errors
- Restart session

### Component Behaving Incorrectly

**Subagent not triggering**:

- Review description - does it include trigger terms?
- Make description more specific
- Try explicit invocation: "Use the [agent-name] subagent to..."

**Skill not being applied**:

- Check description includes when to use it
- Verify skill is in subagent's skills list (if using with subagent)
- Make trigger terms more explicit

**Command failing**:

- Check allowed-tools includes necessary tools
- Verify argument parsing logic
- Test with simple inputs first
- Check for permission issues

## References

Always refer to the official documentation (see top of this file) when:

- Creating new component types
- Using advanced features
- Troubleshooting issues
- Following best practices
- Understanding permission models

The official documentation is the source of truth. This skill provides a practical guide, but defer to official docs for authoritative information.

## Best Practices Summary

1. **Follow official documentation**: Always consult official guides
2. **Be concise**: Assume Claude is smart, avoid over-explaining
3. **Use progressive disclosure**: Split large content into multiple files
4. **Test thoroughly**: Verify components work as expected
5. **Iterate based on behavior**: Watch how Claude uses components and refine
6. **Keep components focused**: Each component should do one thing well
7. **Document clearly**: Good descriptions and examples are essential
8. **Use appropriate tools**: Restrict tool access to minimum needed
9. **Maintain consistency**: Follow naming conventions and patterns
10. **Version control**: Check components into git for team collaboration
