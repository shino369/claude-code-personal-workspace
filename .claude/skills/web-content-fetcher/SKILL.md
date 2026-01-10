---
name: web-content-fetcher
description: Expert guidance for fetching and parsing web content from URLs, handling various content sizes, and working around tool limitations. Use when fetching articles, documentation, or any web content for translation, analysis, or archiving.
allowed-tools: Bash(curl *), Bash(mkdir *), Read, Grep, Task
---

# Web Content Fetcher

Expert knowledge for fetching and parsing web content, handling size limitations, and extracting clean article content from HTML.

## Overview

This skill provides battle-tested strategies for fetching web content in Claude Code, addressing two critical limitations:

1. **WebFetch tool limitation**: Effectively handles ~50KB max content size
2. **Read tool limitation**: 256KB max file size per call

The recommended approach uses a **two-stage workflow**: fetch raw content with curl, then extract clean content using Task agents.

## Tool Limitations Reference

### WebFetch Tool

**Max Content Size**: ~50KB effectively
**Best For**: Small articles, API responses, simple pages
**Limitation**: Prompt parameter length constraints
**Advantage**: AI-powered extraction, returns clean markdown
**When to Use**: First attempt on unknown content, definitely for small pages

### Read Tool

**Max File Size**: 256KB per call
**Best For**: Reading fetched files in manageable chunks
**Limitation**: Large files require pagination with offset/limit
**Advantage**: Direct file access with line numbers
**When to Use**: After fetching, for reading cleaned content

### Bash (curl)

**Max Content Size**: Unlimited
**Best For**: Any size content, raw HTML/file downloads
**Limitation**: No built-in parsing, returns raw content
**Advantage**: Most reliable, no size constraints
**When to Use**: Default choice for medium-to-large content

### Task Agent (general-purpose)

**Capability**: Handles pagination automatically
**Best For**: Extracting content from large HTML files
**Advantage**: AI-powered parsing, manages file size limits internally
**When to Use**: Content extraction from fetched HTML files

## Tiered Fetching Strategy

Choose the appropriate tier based on content size expectations:

### Tier 1: Small Content (< 50KB) - WebFetch Direct

**Use When**: Simple articles, API responses, documentation pages, first attempt

**Workflow**:

1. Try WebFetch tool with extraction prompt
2. If "Prompt too long" error, fall back to Tier 2

**Example**:

```
WebFetch:
- url: https://example.com/article
- prompt: "Extract main article content in markdown format"
```

**Pros**: Fastest, one-step, AI-parsed
**Cons**: Fails on large content

### Tier 2: Medium Content (50KB-500KB) - Curl + Task Agent ⭐ RECOMMENDED DEFAULT

**Use When**: News articles, blog posts, typical web pages, WebFetch fails

**Workflow**:

1. Create task directory: `output/tasks/YYYYMMDD_taskname/original/`
2. Fetch with curl: Save to `original/raw_html.html`
3. Use Task agent (general-purpose) to extract and save clean content to `original/fetched_content.md`

**Example**:

```
1. mkdir -p output/tasks/20260110_taskname/original
2. curl -s URL > output/tasks/20260110_taskname/original/raw_html.html
3. Task agent: "Read HTML from [path], extract article content, save to fetched_content.md"
```

**Pros**: Handles large files, AI-powered extraction, reliable
**Cons**: Two-step process

### Tier 3: Large/Complex Content (> 500KB) - Script-Based

**Use When**: Very large pages, complex DOM structures, multiple pages

**Workflow**:

1. Fetch with curl
2. Use Python/Node.js script with specialized libraries
3. Extract and save clean content

**Pros**: Handles any size, full control
**Cons**: Requires script creation

See [scripts/extract_article.py](scripts/extract_article.py) for reference implementation.

## Standard Workflow (Recommended)

This workflow works for 90% of cases:

### Step 1: Create Task Directory

```bash
mkdir -p output/tasks/YYYYMMDD_descriptive_name/original
```

**Convention**: `YYYYMMDD_` prefix based on current date

### Step 2: Fetch Raw Content

```bash
curl -s "URL" > output/tasks/YYYYMMDD_taskname/original/raw_html.html
```

**Options**:

- `-s`: Silent mode (no progress bar)
- `-L`: Follow redirects
- `-A "Mozilla/5.0"`: Set user agent if needed
- `--max-time 30`: Set timeout

### Step 3: Extract Clean Content

Use Task agent (general-purpose subagent type):

```
Prompt: "Read the HTML file at output/tasks/YYYYMMDD_taskname/original/raw_html.html
and extract the main article content (title, body, headings).
Remove navigation, ads, sidebars, comments, footer.
Save clean markdown to: output/tasks/YYYYMMDD_taskname/original/fetched_content.md"
```

**Why Task agent?**:

- Automatically handles large files (>256KB) with pagination
- AI-powered smart extraction
- Cleans HTML tags and structures content
- No script creation needed

### Step 4: Use Extracted Content

```
Read: output/tasks/YYYYMMDD_taskname/original/fetched_content.md
```

Now proceed with translation, analysis, or other tasks.

## Directory Structure Best Practice

Always organize fetched content in task directories:

```
output/tasks/YYYYMMDD_descriptive_name/
├── original/                    # Raw and cleaned source content
│   ├── raw_html.html           # Original HTML (keep for reference)
│   └── fetched_content.md      # Cleaned article content
├── tmp/                        # Intermediate processing files
│   └── ...
└── [output_type]/              # Final deliverables
    ├── translated/             # For translation tasks
    ├── analyzed/               # For analysis tasks
    └── ...
```

## Content Extraction Priorities

When extracting content, focus on:

1. **Include**:
   - Article title (h1)
   - Main body content (paragraphs)
   - Subheadings (h2-h6)
   - Publication date/metadata (if relevant)
   - Inline links (if important)

2. **Exclude**:
   - Navigation menus
   - Sidebars
   - Advertisement blocks
   - Comment sections
   - Footer content
   - Scripts and styles
   - Related article suggestions

3. **Format**:
   - Output as clean markdown
   - Preserve heading hierarchy
   - Convert HTML links to markdown format
   - Decode HTML entities
   - Use proper line breaks between paragraphs

## Script-Based Parsing (Advanced)

For Tier 3 scenarios, use specialized parsing libraries.

### Node.js with Mozilla Readability

**Best For**: JavaScript-heavy pages, modern web apps

See [scripts/extract_article.js](scripts/extract_article.js) for implementation.

**Usage**:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_article.js raw_html.html > fetched_content.md
```

**Requirements**:

```bash
npm install @mozilla/readability jsdom
```

### Node.js with EUC-JP Support (Japanese Sites)

**Best For**: Japanese websites using EUC-JP encoding (4gamer, etc.)

**Special handling required**: Many Japanese websites (like 4gamer.net) use EUC-JP encoding instead of UTF-8. Standard extraction scripts will produce garbled text without proper decoding.

See [scripts/extract_eucjp.js](scripts/extract_eucjp.js) for implementation.

**Usage**:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js raw_html.html > fetched_content.md
```

**Requirements**:

```bash
pnpm install @mozilla/readability jsdom iconv-lite
```

**When to use**:

- Japanese gaming sites (4gamer, Famitsu, etc.)
- Older Japanese news sites
- Any site where extracted content shows garbled Japanese characters
- If you see `�` or mojibake (文字化け) in extracted content

**How it works**:

1. Reads HTML file as binary buffer
2. Decodes from EUC-JP encoding using iconv-lite
3. Extracts article content using Mozilla Readability
4. Outputs clean markdown

## Decision Tree

Use this flowchart to choose the right approach:

```
Need to fetch web content?
│
├─ Size unknown or first attempt?
│  └─ Try WebFetch (Tier 1)
│     ├─ Success? → Done ✓
│     └─ "Prompt too long" error? → Continue
│
├─ Typical article/blog/documentation?
│  └─ Use curl + Task agent (Tier 2) ⭐ DEFAULT
│
└─ Very large (> 500KB) or complex structure?
   └─ Use curl + Script (Tier 3)
```

## Common Patterns

### Pattern 1: Fetch for Translation

```
1. mkdir -p output/tasks/20260110_translate_article/original
2. curl -s URL > output/tasks/20260110_translate_article/original/raw_html.html
3. Task agent: Extract to original/fetched_content.md
4. Pass fetched_content.md to translation workflow
```

### Pattern 2: Fetch for Analysis

```
1. mkdir -p output/tasks/20260110_analyze_article/original
2. curl -s URL > output/tasks/20260110_analyze_article/original/raw_html.html
3. Task agent: Extract to original/fetched_content.md
4. Read and analyze fetched_content.md
```

### Pattern 3: Fetch Series of Articles

```
1. Create task directory
2. Loop: for i in {1..5}; do curl -s "URL$i" > original/page$i.html; done
3. Task agent: Process each page
4. Combine: cat original/page*.md > combined.md
```

### Pattern 4: Fetch with Authentication

```
1. curl -H "Authorization: Bearer TOKEN" URL > raw_html.html
   OR
   curl -b "session=COOKIE" URL > raw_html.html
2. Task agent: Extract content
```

## Troubleshooting

### Issue: WebFetch returns "Prompt too long"

**Solution**: Switch to Tier 2 (curl + Task agent)

### Issue: Read tool says file too large (> 256KB)

**Solution**: Use Task agent which handles pagination automatically, OR use Grep to search specific content

### Issue: Extracted content is messy/incomplete

**Solutions**:

1. Improve Task agent prompt (be more specific about what to include/exclude)
2. Check if page uses JavaScript rendering (may need headless browser)
3. Use Python readability library for better content detection (Tier 3)
4. Manually inspect raw_html.html to understand page structure

### Issue: Japanese text shows garbled characters (mojibake/文字化け)

**Symptoms**:

- Japanese characters appear as `�`, `�`, or random symbols
- Text is unreadable despite being from a Japanese site

**Solution**: Use EUC-JP extraction script:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js raw_html.html > fetched_content.md
```

**Common sites requiring EUC-JP**:

- 4gamer.net
- Many older Japanese gaming/news sites
- Government and academic sites in Japan

**How to identify**:

1. If extracted content is garbled, check the HTML file's encoding
2. Look for `<meta charset="EUC-JP">` or `charset=euc-jp` in raw HTML
3. Common for sites that haven't migrated to UTF-8

### Issue: Page has anti-bot protection

**Solutions**:

1. Add user agent: `curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" URL`
2. Add headers: `curl -H "Accept-Language: en-US" -H "Accept: text/html" URL`
3. Use cookies if you have session: `curl -b "session=abc123" URL`

### Issue: Content requires authentication

**Solution**: Use curl with authentication headers or cookies:

```bash
curl -H "Authorization: Bearer TOKEN" URL > raw_html.html
curl -b "session=COOKIE" URL > raw_html.html
curl -u username:password URL > raw_html.html
```

### Issue: Page redirects to different domain

**Solution**: Use `-L` flag to follow redirects:

```bash
curl -L URL > raw_html.html
```

### Issue: Timeout or slow connection

**Solution**: Increase timeout:

```bash
curl --max-time 60 URL > raw_html.html
```

## Best Practices Summary

1. **Always use task directories**: Organize content in `output/tasks/YYYYMMDD_taskname/`
2. **Keep raw HTML**: Save to `original/raw_html.html` for reference and re-processing
3. **Default to Tier 2**: curl + Task agent works for 90% of cases
4. **Clean content format**: Always save extracted content as markdown in `fetched_content.md`
5. **Descriptive naming**: Use date prefix and descriptive task names
6. **Error handling**: Start with WebFetch, fall back to curl on failure
7. **Task agent for extraction**: Let AI handle pagination and parsing complexity
8. **Scripts for edge cases**: Only use scripts for very large or complex content

## Quick Reference Commands

**Fetch with error handling**:

```bash
curl -f -s -L --max-time 30 -A "Mozilla/5.0" "URL" > raw_html.html || echo "Fetch failed"
```

**Check HTTP status**:

```bash
curl -w "%{http_code}" -o raw_html.html "URL"
```

**Fetch with redirects**:

```bash
curl -L "URL" > raw_html.html
```

**Silent fetch with user agent**:

```bash
curl -s -A "Mozilla/5.0" "URL" > raw_html.html
```
