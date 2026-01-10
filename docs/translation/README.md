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

### Multi-Agent Workflow

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

### For File Translations and URL Translations

```
output/tasks/YYYYMMDD_translate_[description]/
├── original/                    # For URL translations only
│   └── fetched_content.md      # Fetched web content
├── translated/
│   └── [filename]_[lang].md    # Final deliverable (e.g., README_ja.md)
└── tmp/
    ├── stage1_initial.md        # Initial translation from Translator A
    ├── stage1_notes.md          # Analysis and notes for proofreader
    ├── stage2_feedback.md       # Proofreading review from Translator B
    ├── stage3_final.md          # Final translation (same as translated/)
    └── stage3_summary.md        # Refinement summary and QA notes
```

**Note**: The `original/` directory is created only for URL translations to store the fetched web content.

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
/translate [--lang <en|ja|cn>] [--tone <casual|formal>] [--url <URL>] <content>
```

### Parameters

- `--lang <en|ja|cn>`: Target language (optional, interactive if omitted)
  - `en`: English
  - `ja`: Japanese (日本語)
  - `cn`: Chinese Traditional (繁體中文)

- `--tone <casual|formal>`: Writing style (optional, agent decides if not provided)
  - `casual`: Conversational tone
  - `formal`: Professional/academic tone

- `--url <URL>`: Fetch content from a URL to translate (optional)
  - Alternative to inline text or file references
  - Uses web-content-fetcher skill with tiered approach
  - Fetched content saved to `original/fetched_content.md`

- `<content>`: Text to translate, file reference using `@`, or omitted when using `--url`

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
/translate "生きろ。 そなたは… ほら… あれだ。"
```

Claude will ask for target language, then proceed with translation.

#### Example 4: Technical Document

```bash
/translate --lang ja @docs/api-specification.md
```

Leverages the **engineering-terminology** skill for accurate technical translation.

#### Example 5: Translate from URL

```bash
/translate --lang en --url https://automaton-media.com/articles/newsjp/20260109-401932/
```

Fetches Japanese article from URL, translates to English.

**Output**:

- Original content: `output/tasks/20260110_translate_article/original/fetched_content.md`
- Final translation: `output/tasks/20260110_translate_article/translated/article_en.md`
- Intermediate: `output/tasks/20260110_translate_article/tmp/`

#### Example 6: URL with tone specification

```bash
/translate --lang ja --tone formal --url https://example.com/blog/post
```

Fetches content from URL, translates to Japanese in formal tone.

#### Example 7: Direct URL without --url flag

```bash
/translate --lang cn https://example.com/article
```

Detects URL automatically, fetches and translates to Traditional Chinese.

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

### URL Translation Support

The system can fetch and translate web content directly from URLs using the integrated `web-content-fetcher` skill:

- **Automatic content extraction**: Removes navigation, ads, sidebars, and extracts clean article content
- **Size handling**: Handles articles of any size using tiered fetching strategy
- **Encoding support**: Handles UTF-8, EUC-JP, and other encodings
- **Structured storage**: Fetched content saved to `original/` directory for reference
- **Transparent workflow**: Seamlessly integrated with three-stage translation process

Use `--url <URL>` parameter to translate web content without manual copying.

## Skills Detail

### translation-expertise

**Files**: `.claude/skills/translation-expertise/` (2,836 lines across 6 files)

A comprehensive translation methodology skill using **language-based organization** for efficient access to all information about each language in one place.

**Structure (Language-Based Organization)**:

- `SKILL.md` (284 lines) - Overview, workflow, best practices, quick reference
- `english.md` (372 lines) - Complete English reference: characteristics, punctuation, formality levels, writing conventions
- `japanese.md` (515 lines) - Complete Japanese reference: all 5 politeness levels (plain, です・ます, である, formal, honorific), punctuation, particles, formality handling
- `chinese-traditional.md` (535 lines) - Complete Traditional Chinese reference: classical influences, regional variations (Taiwan/Hong Kong), punctuation, formality levels
- `translation-challenges.md` (603 lines) - Cross-language challenges with detailed examples: idioms, cultural references, honorifics, wordplay
- `tools-resources.md` (527 lines) - 45+ curated resources: dictionaries, corpus databases, grammar references, terminology tools

**Covers**:

- Translation philosophy and core principles
- Three-stage translation workflow methodology (Initial → Proofread → Refine)
- Language-specific characteristics and writing conventions
- Handling idioms, cultural references, and wordplay
- Formality level management across languages
- Punctuation conventions for each language
- Quality assurance checklist

### engineering-terminology

**Files**: `.claude/skills/engineering-terminology/` (1,810 lines across 7 files)

A comprehensive technical terminology skill with **domain-based organization** providing 1,075+ technical terms across 6 major domains.

**Structure (Domain-Based Organization)**:

- `SKILL.md` (229 lines) - Guidelines, usage patterns, quick reference
- `glossaries/software-engineering.md` (231 lines) - ~170 terms: API, framework, database, algorithms, design patterns
- `glossaries/web-development.md` (289 lines) - ~200 terms: React, Vue, Angular, frontend/backend, HTTP, REST, GraphQL
- `glossaries/devops-cloud.md` (249 lines) - ~160 terms: container, Kubernetes, CI/CD, pipeline, monitoring, load balancer
- `glossaries/data-engineering.md` (257 lines) - ~180 terms: ETL, schema, data warehouse, query optimization, streaming
- `glossaries/ai-ml.md` (265 lines) - ~185 terms: neural networks, LLM, transformers, RAG, embeddings, fine-tuning
- `glossaries/hardware-electronics.md` (290 lines) - ~180 terms: circuit, semiconductor, processor, PCB, FPGA

**Provides expert knowledge in**:

- Software engineering (API, framework, database, algorithms, design patterns)
- Web development (React, Vue, Angular, frontend/backend, REST, GraphQL)
- DevOps & Cloud (container, Kubernetes, CI/CD, pipeline, monitoring)
- Data engineering (ETL, schema, data warehouse, query optimization)
- AI/ML (neural networks, LLM, transformers, RAG, embeddings)
- Hardware engineering (circuit, semiconductor, processor, PCB, FPGA)

Includes comprehensive trilingual translation tables (EN/JA/CN) for all terms with usage context and examples.

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

### web-content-fetcher

**File**: `.claude/skills/web-content-fetcher/SKILL.md` (492 lines)

Expert guidance for fetching and parsing web content from URLs, used by the translation system when `--url` parameter is provided.

**Includes**:

- 3-tier fetching strategy:
  - **Tier 1**: WebFetch tool (< 50KB) - Fast, AI-powered extraction
  - **Tier 2**: curl + Task agent (any size) - Recommended default for 99% of cases
  - **Tier 3**: curl + scripts (edge cases) - extract_article.js, extract_eucjp.js for special encoding
- Tool limitation reference (WebFetch: 50KB, Read: 256KB)
- Directory structure conventions (`original/`, `tmp/`, `translated/`)
- Troubleshooting guide (encoding issues, anti-bot protection, authentication)
- Scripts for edge cases (Japanese EUC-JP encoding handling)

**Use when**: Translating web articles, blog posts, or online documentation via URL

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
- Comprehensive terminology (1,075+ terms across 6 domains)
- Language-based reference access (all info about each language in one place)
- File-based workflow with structured outputs
- Cultural adaptation and nuance preservation
- Consistent terminology management
- URL content fetching with web-content-fetcher skill integration
- Automatic encoding detection (UTF-8, EUC-JP, etc.)

## Skills Architecture

The translation system's skills use progressive disclosure patterns to manage large amounts of information effectively while keeping individual files focused and navigable.

### Progressive Disclosure

Large skills are split into manageable, focused files rather than monolithic documents:

- **Main SKILL.md**: Overview, essential guidance, workflow, and links to detailed references
- **Reference files**: Detailed information organized by logical groupings (language or domain)
- **Benefits**:
  - Faster loading and parsing
  - Easier navigation to relevant information
  - Focused content without overwhelming context
  - Better maintainability and updates

### Organization Strategies

Different skills use different organizational strategies based on their usage patterns:

**translation-expertise: Language-Based Organization**

Each language (English, Japanese, Traditional Chinese) has its own comprehensive reference file containing all information about that language:

- `english.md` - Everything about English in one place
- `japanese.md` - Everything about Japanese in one place
- `chinese-traditional.md` - Everything about Traditional Chinese in one place
- `translation-challenges.md` - Cross-language issues and solutions
- `tools-resources.md` - External references and resources

**Rationale**: When translating EN→JA, you need all English information together and all Japanese information together. Language-based organization matches the natural translation workflow where you reference the source language characteristics, then the target language characteristics, without jumping between multiple topic files.

**engineering-terminology: Domain-Based Organization**

Technical terms are grouped by domain (software, web, DevOps, data, AI/ML, hardware) with each domain in its own glossary file:

- `glossaries/software-engineering.md` - Core software development terms
- `glossaries/web-development.md` - Frontend/backend web technologies
- `glossaries/devops-cloud.md` - Infrastructure and deployment
- `glossaries/data-engineering.md` - Data processing and analytics
- `glossaries/ai-ml.md` - Machine learning and AI concepts
- `glossaries/hardware-electronics.md` - Hardware and electronics terms

**Rationale**: Technical translation typically focuses on one domain at a time. When translating React documentation, you work primarily with web-development terms. When translating a machine learning paper, you work with AI/ML terms. Domain-based organization reduces cognitive load by presenting only the relevant terminology for the task.

### Automatic Skill Loading

All three skills (engineering-terminology, translation-expertise, document-writing) are automatically loaded into the trilingual-translator subagent's context at startup through the `skills:` field in the subagent's frontmatter. No user action or manual loading is required.

The main SKILL.md of each skill is loaded first, providing immediate access to essential guidance. Reference files are linked from the main SKILL.md and can be accessed as needed.

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

### URL Translation

1. User runs `/translate --lang en --url https://example.com/article`
2. Main agent uses web-content-fetcher skill to fetch content:
   - Try WebFetch first (fast for small articles)
   - Fall back to curl + Task agent for larger content
   - Handle encoding issues (EUC-JP for Japanese sites)
3. Main agent creates directory structure:
   ```
   output/tasks/20260110_translate_article/
   ├── original/          (stores fetched content)
   ├── translated/        (final output)
   └── tmp/               (intermediate files)
   ```
4. Fetched content saved to `original/fetched_content.md`
5. Main agent invokes trilingual-translator three times (same as file translation):
   - Stage 1: Reads fetched_content.md, creates initial translation
   - Stage 2: Reviews initial translation
   - Stage 3: Produces final polished translation
6. Reports all file locations to user

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
