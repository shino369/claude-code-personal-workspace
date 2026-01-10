# Claude Code Trilingual Translation System

A comprehensive trilingual translation system for Claude Code supporting English, Japanese (日本語), and Traditional Chinese (繁體中文) with a true multi-agent workflow.

## Overview

This system provides professional-grade translation capabilities through a multi-agent collaborative approach with expert knowledge in:

- Engineering and technical terminology
- Professional translation methodology
- Language-specific document writing conventions

## Architecture

### Components

```
.claude/
├── agents/
│   └── trilingual-translator.md       # Single translator agent (3 roles)
├── skills/
│   ├── engineering-terminology/
│   │   └── SKILL.md                   # Technical terminology expertise
│   ├── translation-expertise/
│   │   └── SKILL.md                   # Translation methodology
│   └── document-writing/
│       └── SKILL.md                   # Writing conventions
└── commands/
    └── translate.md                   # /translate slash command
```

### True Multi-Agent Workflow

The system uses a **collaborative multi-agent approach** where the same subagent is invoked three times with different roles:

```
/translate command (Coordinator)
    ↓
Stage 1: trilingual-translator as "Initial Translator (Translator A)"
    → Creates first draft
    → Writes to tmp/stage1_initial.md and tmp/stage1_notes.md
    ↓
Stage 2: trilingual-translator as "Proofreader (Translator B)"
    → Reviews Stage 1 output
    → Provides detailed feedback
    → Writes to tmp/stage2_feedback.md
    ↓
Stage 3: trilingual-translator as "Refiner (Translator C)"
    → Reads Stage 1 + Stage 2
    → Produces final polished translation
    → Writes to tmp/stage3_final.md, tmp/stage3_summary.md
    → Writes final deliverable to translated/[filename]_[lang].md
    ↓
Final output to user
```

**Key Features**:

- **Multiple perspectives**: Different agents (A, B, C) review each other's work
- **Sequential improvement**: Each stage builds on previous work
- **File-based handoff**: Agents communicate via structured files
- **Mirrors professional practice**: How human translation teams work

## Output Directory Structure

### For File Translations

```
output/tasks/YYYYMMDD_translate_[description]/
├── translated/
│   └── [filename]_[lang].md    # Final deliverable (e.g., README_ja.md)
└── tmp/
    ├── stage1_initial.md        # Initial translation from Translator A
    ├── stage1_notes.md          # Analysis and notes for proofreader
    ├── stage2_feedback.md       # Proofreading review from Translator B
    ├── stage3_final.md          # Final translation (same as translated/)
    └── stage3_summary.md        # Refinement summary and QA notes
```

**Example**:

```
output/tasks/20260110_translate_readme/
├── translated/
│   └── README_ja.md            # 🎯 Final Japanese translation
└── tmp/
    ├── stage1_initial.md
    ├── stage1_notes.md
    ├── stage2_feedback.md
    ├── stage3_final.md
    └── stage3_summary.md
```

### For Inline Text

Output is displayed directly in the conversation with all three stages visible.

## Usage

### Basic Command

```bash
/translate [--lang <en|ja|cn>] [--tone <casual|formal>] <content>
```

### Parameters

- `--lang <en|ja|cn>`: Target language (optional, interactive if omitted)
  - `en`: English
  - `ja`: Japanese (日本語)
  - `cn`: Chinese Traditional (繁體中文)

- `--tone <casual|formal>`: Writing style (optional, agent decides if not provided)
  - `casual`: Conversational tone
  - `formal`: Professional/academic tone

- `<content>`: Text to translate or file reference using `@`

### Examples

#### Example 1: Simple Inline Translation

```bash
/translate --lang ja --tone formal "Hello, how are you today?"
```

Translates to formal Japanese, displays all 3 stages in conversation.

#### Example 2: File Translation

```bash
/translate --lang en --tone casual @README.md
```

**Output**:

- Final file: `output/tasks/20260110_translate_readme/translated/README_en.md`
- Intermediate: `output/tasks/20260110_translate_readme/tmp/`

#### Example 3: Interactive Mode

```bash
/translate "これは素晴らしい製品です"
```

Claude will ask for target language, then proceed with translation.

#### Example 4: Technical Document

```bash
/translate --lang ja @docs/api-specification.md
```

Leverages the **engineering-terminology** skill for accurate technical translation.

## Features

### Three-Stage Collaborative Process

**Stage 1: Initial Translation (Translator A)**

- Reads and understands entire source text
- Identifies key terminology and creates glossary
- Translates section by section with context awareness
- Marks uncertainties for review
- **Output**: Initial translation + notes for proofreader

**Stage 2: Proofreading (Translator B)**

- Reviews initial translation against source
- Checks accuracy, naturalness, consistency
- Identifies grammar, terminology, and cultural issues
- Provides detailed, actionable feedback
- **Output**: Proofreading review with specific corrections

**Stage 3: Refinement (Translator C)**

- Incorporates all proofreader feedback
- Resolves uncertainties from Stage 1
- Polishes for naturalness and readability
- Performs final quality assurance
- **Output**: Final polished translation + summary

### Supported Languages

- **English (en)**: Clear, direct communication with deductive approach
- **Japanese (ja, 日本語)**: 起承転結 structure with appropriate politeness levels
- **Traditional Chinese (cn, 繁體中文)**: Classical influence with balanced structures

### Tone Handling

- **Casual**: Conversational, informal language
  - English: Contractions, simple vocabulary, personal pronouns
  - Japanese: Plain form (食べる、行く), casual particles
  - Chinese: Colloquial expressions, simplified structures

- **Formal**: Professional, academic language
  - English: No contractions, complex structures, objective language
  - Japanese: です・ます体 or である体, formal vocabulary (漢語)
  - Chinese: Literary vocabulary, 成語 usage, formal connectors

## Skills Detail

### engineering-terminology

**File**: `.claude/skills/engineering-terminology/SKILL.md` (600+ lines)

Provides expert knowledge in:

- Software engineering (API, framework, database, algorithms)
- Hardware engineering (circuit, semiconductor, processor)
- Mechanical engineering (tolerance, assembly, specification)
- DevOps & Cloud (container, pipeline, monitoring, load balancer)
- Data engineering (ETL, schema, data warehouse, query)

Includes comprehensive translation tables for common technical terms across all three languages.

### translation-expertise

**File**: `.claude/skills/translation-expertise/SKILL.md` (300+ lines)

Covers:

- Translation philosophy and core principles
- Language-specific characteristics and considerations
- Three-stage translation workflow methodology
- Handling idioms, cultural references, and wordplay
- Formality level management across languages
- Punctuation conventions for each language
- Quality assurance checklist

### document-writing

**File**: `.claude/skills/document-writing/SKILL.md` (400+ lines)

Includes:

- Document types (academic, business, technical, creative)
- Language-specific writing conventions and rhetorical structures:
  - English: Deductive approach with clear thesis
  - Japanese: 起承転結 (ki-shou-ten-ketsu) structure
  - Chinese: Classical influence with balanced parallelism
- Tone and register guidelines (casual vs formal)
- Document formatting conventions
- Writing process best practices
- Common writing patterns (compare-contrast, cause-effect)

## Subagent Configuration

### trilingual-translator

**File**: `.claude/agents/trilingual-translator.md`

**Configuration**:

- **Name**: `trilingual-translator`
- **Model**: Sonnet (balanced capability and speed)
- **Tools**: Read, Write, Grep, Glob
- **Skills**: engineering-terminology, translation-expertise, document-writing (auto-loaded)
- **Permission Mode**: Default

**Role-Based Invocation**:
The single subagent takes on three different roles based on instructions:

1. **Initial Translator (Translator A)**: Creates first draft
2. **Proofreader (Translator B)**: Reviews and provides feedback
3. **Refiner (Translator C)**: Produces final polished version

**Capabilities**:

- Native-level proficiency in EN/JA/CN
- Technical document translation expertise
- File-based workflow with structured outputs
- Cultural adaptation and nuance preservation
- Consistent terminology management

## Quality Assurance

Every translation is checked for:

**Accuracy**:

- ✓ Meaning accurately conveyed
- ✓ No omissions or additions
- ✓ Correct numbers, dates, names
- ✓ Accurate technical terms

**Naturalness**:

- ✓ Fluent in target language
- ✓ No awkward phrasings
- ✓ Appropriate word choice
- ✓ Natural sentence flow

**Consistency**:

- ✓ Consistent terminology
- ✓ Maintained tone
- ✓ Preserved formatting
- ✓ Appropriate style

**Cultural Appropriateness**:

- ✓ Culturally sensitive handling
- ✓ Adapted idioms
- ✓ Understandable references
- ✓ Relevant examples

## Best Practices

1. **Always provide context**: Include surrounding context for better translation
2. **Specify tone when important**: Use `--tone` for specific style requirements
3. **Review intermediate stages**: Check tmp/ directory for translation progression
4. **Leverage skills**: System automatically applies domain expertise
5. **Use file references**: For longer documents, use `@filename` syntax

## How It Works

### Inline Text Translation

1. User runs `/translate --lang ja "Hello, world"`
2. Main agent parses arguments and detects source language
3. Main agent invokes trilingual-translator three times sequentially:
   - **Stage 1**: Initial translation output in conversation
   - **Stage 2**: Proofreading feedback output in conversation
   - **Stage 3**: Final refined translation output in conversation
4. All outputs displayed to user

### File Translation

1. User runs `/translate --lang ja @README.md`
2. Main agent creates directory structure:
   ```
   output/tasks/20260110_translate_readme/
   ├── translated/    (created for final output)
   └── tmp/           (created for intermediate files)
   ```
3. Main agent invokes trilingual-translator (Stage 1):
   - Reads `README.md`
   - Writes `tmp/stage1_initial.md` (translation)
   - Writes `tmp/stage1_notes.md` (analysis)
4. Main agent invokes trilingual-translator (Stage 2):
   - Reads `README.md`, `tmp/stage1_initial.md`, `tmp/stage1_notes.md`
   - Writes `tmp/stage2_feedback.md` (review)
5. Main agent invokes trilingual-translator (Stage 3):
   - Reads all previous files
   - Writes `tmp/stage3_final.md` (final translation)
   - Writes `tmp/stage3_summary.md` (summary)
   - Writes `translated/README_ja.md` (deliverable)
6. Reports file locations to user

## Technical Details

### Skill Loading

Skills are automatically loaded into the subagent's context at startup. The full content of each skill is injected, providing comprehensive knowledge without requiring additional tool calls.

### Tool Restrictions

The trilingual-translator subagent has access to:

- **Read**: For reading source files and previous stage outputs
- **Write**: For saving translations and intermediate files
- **Grep**: For searching content
- **Glob**: For finding files

It does NOT have access to:

- Bash commands (focused operation)
- Edit tools (uses Write for new files)
- External network tools (secure, isolated)

### Permission Model

Uses default permission mode:

- Standard permission checking with prompts
- User approval required for file modifications
- Transparent operation

## Extending the System

### Adding New Language Pairs

To add support for additional languages:

1. Update skills to include terminology and conventions for new language
2. Modify subagent system prompt to include new language expertise
3. Update `/translate` command to accept new language codes
4. Test thoroughly with various content types

### Adding Domain-Specific Skills

To add specialized domain knowledge:

1. Create new skill in `.claude/skills/[domain-name]/SKILL.md`
2. Add skill to subagent's `skills:` list in frontmatter
3. Document the skill's purpose and when it's used
4. Follow progressive disclosure patterns for large skill files

### Customizing Translation Workflow

The three-stage workflow can be customized by modifying:

- Subagent system prompt for role-specific behavior
- Command instructions for workflow orchestration
- Output directory structure in both subagent and command

## Troubleshooting

### Subagent Not Found

If the subagent doesn't appear in `/agents`:

- Check file location: `.claude/agents/trilingual-translator.md`
- Verify YAML frontmatter is valid
- Restart Claude Code session

### Skills Not Loading

If skills aren't available to the subagent:

- Verify skill files exist in `.claude/skills/[skill-name]/SKILL.md`
- Check that skill names in subagent frontmatter match directory names
- Ensure YAML frontmatter in skills is valid

### Command Not Working

If `/translate` command isn't available:

- Check file location: `.claude/commands/translate.md`
- Verify YAML frontmatter includes `description` field
- Run `/help` to confirm command is listed
- Restart session if needed

### File Output Issues

If translated files aren't created:

- Check that output directory structure is created
- Verify Write tool permissions
- Check for path errors in subagent logs
- Ensure directory names follow YYYYMMDD format

## Version History

- **v1.0.0** (2026-01-10): Initial release
  - Multi-agent trilingual translation system (EN/JA/CN)
  - Three-stage collaborative workflow
  - File-based handoff between stages
  - Engineering terminology skill
  - Translation expertise skill
  - Document writing skill
  - `/translate` slash command with inline and file modes
  - Output directory structure: `translated/` and `tmp/`

## License

This system is part of your personal Claude Code workspace. Modify and extend as needed for your use cases.

## Support

For issues or questions:

1. Check this documentation
2. Review skill and subagent configuration files
3. Use `/agents` to inspect subagent configuration
4. Test with simple examples first
5. Check `tmp/` directory for intermediate translation stages

## References

- [Claude Code Sub-agents Documentation](https://code.claude.com/docs/en/sub-agents.md)
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills.md)
- [Claude Code Slash Commands Documentation](https://code.claude.com/docs/en/slash-commands.md)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md)
