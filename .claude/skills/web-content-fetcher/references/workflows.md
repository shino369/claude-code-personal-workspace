# Standard Workflows and Patterns

This reference provides detailed step-by-step workflows, common patterns, and best practices for organizing fetched web content.

## Table of Contents

- [Standard Workflow (Tier 2 - Recommended)](#standard-workflow-tier-2---recommended)
- [Directory Structure Best Practice](#directory-structure-best-practice)
- [Content Extraction Priorities](#content-extraction-priorities)
- [Common Patterns](#common-patterns)

## Standard Workflow (Tier 2 - Recommended)

This workflow using curl + Task agent works for nearly all cases.

### Step 1: Create Task Directory

```bash
mkdir -p output/tasks/YYYYMMDD_descriptive_name/original
```

**Convention**: `YYYYMMDD_` prefix based on current date

**Example**:
```bash
mkdir -p output/tasks/20260111_article_translation/original
```

### Step 2: Fetch Raw Content

```bash
curl -s "URL" > output/tasks/YYYYMMDD_taskname/original/raw_html.html
```

**Common Options**:

- `-s`: Silent mode (no progress bar)
- `-L`: Follow redirects
- `-A "Mozilla/5.0"`: Set user agent if needed
- `--max-time 30`: Set timeout

**Example**:
```bash
curl -s -L "https://example.com/article" > output/tasks/20260111_article_translation/original/raw_html.html
```

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

**Key principles**:

- **Date prefix**: Use `YYYYMMDD_` for chronological sorting
- **Descriptive names**: Clearly indicate task purpose
- **Preserve raw**: Keep `raw_html.html` for debugging and re-processing (not needed for Tier 4 Playwright)
- **Clean output**: Always save extracted content to `fetched_content.md`
- **Organize by type**: Use subdirectories for final deliverables

## Content Extraction Priorities

When extracting content (via Task agent or scripts), focus on:

### Include

1. **Article title** (h1)
2. **Main body content** (paragraphs)
3. **Subheadings** (h2-h6)
4. **Publication date/metadata** (if relevant to the task)
5. **Inline links** (if important for context)

### Exclude

1. Navigation menus
2. Sidebars
3. Advertisement blocks
4. Comment sections
5. Footer content
6. Scripts and styles
7. Related article suggestions
8. Cookie banners
9. Social media widgets

### Format

1. **Output as clean markdown**
2. **Preserve heading hierarchy** (h1 → #, h2 → ##, etc.)
3. **Convert HTML links** to markdown format: `[text](url)`
4. **Decode HTML entities** (`&amp;` → `&`, `&lt;` → `<`)
5. **Use proper line breaks** between paragraphs (blank line)
6. **Preserve code blocks** if present
7. **Keep list formatting** (ordered and unordered)

## Common Patterns

### Pattern 1: Fetch for Translation

**Use case**: Fetching web content to translate to another language

```bash
# 1. Create task directory
mkdir -p output/tasks/20260111_translate_article/original

# 2. Fetch raw HTML
curl -s "https://example.com/article" > output/tasks/20260111_translate_article/original/raw_html.html

# 3. Extract clean content (via Task agent)
```

Task agent prompt:
```
Read the HTML file at output/tasks/20260111_translate_article/original/raw_html.html
and extract the main article content. Save clean markdown to:
output/tasks/20260111_translate_article/original/fetched_content.md
```

```bash
# 4. Pass to translation workflow
# Use /translate command or translation agent with fetched_content.md
```

### Pattern 2: Fetch for Analysis

**Use case**: Fetching web content to analyze or summarize

```bash
# 1. Create task directory
mkdir -p output/tasks/20260111_analyze_article/original

# 2. Fetch raw HTML
curl -s "https://example.com/research-paper" > output/tasks/20260111_analyze_article/original/raw_html.html

# 3. Extract clean content (via Task agent)
```

Task agent prompt:
```
Read the HTML file at output/tasks/20260111_analyze_article/original/raw_html.html
and extract the main article content. Save clean markdown to:
output/tasks/20260111_analyze_article/original/fetched_content.md
```

```bash
# 4. Read and analyze
```

Then read `fetched_content.md` and perform analysis.

### Pattern 3: Fetch Series of Articles

**Use case**: Fetching multiple related articles or pages

```bash
# 1. Create task directory
mkdir -p output/tasks/20260111_series_analysis/original

# 2. Fetch multiple pages
for i in {1..5}; do
  curl -s "https://example.com/article/part-$i" > output/tasks/20260111_series_analysis/original/page$i.html
done

# 3. Extract each page (via Task agent for each file)
```

Task agent prompt (run for each page):
```
Read the HTML file at output/tasks/20260111_series_analysis/original/page[N].html
and extract the main article content. Save clean markdown to:
output/tasks/20260111_series_analysis/original/page[N].md
```

```bash
# 4. Combine all extracted content
cat output/tasks/20260111_series_analysis/original/page*.md > output/tasks/20260111_series_analysis/combined.md
```

### Pattern 4: Fetch with Authentication

**Use case**: Fetching content behind authentication/login

**Bearer Token**:
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" "https://api.example.com/article" > raw_html.html
```

**Cookie-based Authentication**:
```bash
curl -b "session=YOUR_SESSION_COOKIE" "https://example.com/members/article" > raw_html.html
```

**Basic Authentication**:
```bash
curl -u username:password "https://example.com/protected/article" > raw_html.html
```

Then extract with Task agent as usual.

### Pattern 5: Fetch JavaScript-Rendered Content

**Use case**: Twitter/X, React SPAs, dynamic sites requiring JavaScript

```bash
# 1. Create task directory
mkdir -p output/tasks/20260111_twitter_post/original

# 2. Fetch with Playwright script (no need to save raw HTML)
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output output/tasks/20260111_twitter_post/original/fetched_content.md

# 3. Use fetched content directly
```

Then read `fetched_content.md` for translation/analysis.
