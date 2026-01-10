---
name: web-content-fetcher
description: Expert guidance for fetching and parsing web content from URLs, handling various content sizes, JavaScript-rendered sites, and working around tool limitations. Use when fetching articles, documentation, social media posts, or any web content for translation, analysis, or archiving.
allowed-tools: Bash(curl *), Bash(mkdir *), Bash(node *), Read, Grep, Task
---

# Web Content Fetcher

Expert knowledge for fetching and parsing web content, handling size limitations, JavaScript-rendered sites, and extracting clean article content from HTML.

## Overview

This skill provides battle-tested strategies for fetching web content in Claude Code, addressing critical challenges:

1. **WebFetch tool limitation**: Effectively handles ~50KB max content size
2. **Read tool limitation**: 256KB max file size per call
3. **JavaScript-rendered content**: Twitter/X, React SPAs, and dynamic sites require special handling

**Four-tier approach**:
- **Tier 1**: WebFetch for small content (< 50KB)
- **Tier 2**: curl + Task agent for any size static content ⭐ **DEFAULT**
- **Tier 3**: Specialized scripts for edge cases (EUC-JP encoding, complex HTML)
- **Tier 4**: Playwright for JavaScript-rendered sites (Twitter/X, React SPAs)

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

### Tier 2: Any Size Content - Curl + Task Agent ⭐ RECOMMENDED DEFAULT

**Use When**: News articles, blog posts, typical web pages, WebFetch fails, any content of any size

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

**Pros**: Handles files of any size, AI-powered extraction, reliable, no script creation needed
**Cons**: Two-step process (but this is the standard workflow)

### Tier 3: Script-Based Extraction - For Edge Cases Only

**Use When**: Task agent struggles with complex HTML, need precise control, or have special encoding requirements that Task agent cannot handle

**Workflow**:

1. Create task directory: `output/tasks/YYYYMMDD_taskname/original/`
2. Fetch with curl: Save to `original/raw_html.html`
3. Run extraction script: `node scripts/extract_article.js raw_html.html > fetched_content.md`

**Example**:

```
1. mkdir -p output/tasks/20260110_taskname/original
2. curl -s URL > output/tasks/20260110_taskname/original/raw_html.html
3. node .claude/skills/web-content-fetcher/scripts/extract_article.js raw_html.html > fetched_content.md
```

**Pros**: Precise control, handles specific edge cases
**Cons**: Requires script setup, manual command execution, less flexible than Task agent

**Note**: This tier is rarely needed. Task agent (Tier 2) handles 99% of cases including large files and complex HTML. Only use scripts when Task agent explicitly fails or for special encoding requirements.

### Tier 4: JavaScript-Rendered Content - Playwright

**Use When**: Website requires JavaScript to load content (Twitter/X, React SPAs, dynamic websites), static fetch returns error messages or empty content

**Workflow**:

1. Create task directory: `output/tasks/YYYYMMDD_taskname/original/`
2. Run Playwright script: `node scripts/fetch_js_content.js URL --output original/fetched_content.md`

**Example**:

```bash
1. mkdir -p output/tasks/20260111_twitter_post/original
2. node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
   "https://x.com/user/status/123456789" \
   --output output/tasks/20260111_twitter_post/original/fetched_content.md
```

**Requirements** (one-time setup):

```bash
cd .claude/skills/web-content-fetcher
pnpm add -D playwright --save-catalog-name=dev
pnpm exec playwright install chromium
```

**Supported Sites**:

- Twitter/X (automatic tweet extraction)
- React-based single-page applications
- Any site requiring JavaScript rendering
- Dynamic content loaded via AJAX

**Options**:

- `--output <file>`: Output file path (default: stdout)
- `--selector <sel>`: CSS selector to wait for (auto-detected for Twitter/X)
- `--timeout <ms>`: Page load timeout (default: 30000)

**Best For**:

- Social media posts (Twitter/X, etc.)
- Modern web applications using React/Vue/Angular
- Content that doesn't appear without JavaScript
- Sites with client-side rendering

**Pros**: Handles JavaScript rendering, auto-detects site types, extracts structured content
**Cons**: Slower than static fetching, requires Chromium browser installation

**Note**: This is the only solution for JavaScript-dependent sites. Traditional curl cannot execute JavaScript.

## Standard Workflow (Recommended)

This workflow using Tier 2 (curl + Task agent) works for nearly all cases:

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

## Decision Tree

Use this flowchart to choose the right approach:

```
Need to fetch web content?
│
├─ JavaScript-rendered site (Twitter/X, React SPA, dynamic content)?
│  └─ Use Playwright script (Tier 4)
│     ├─ Success? → Done ✓
│     └─ Still failing? → Check browser/timeout settings
│
├─ Size unknown or small expected content?
│  └─ Try WebFetch (Tier 1)
│     ├─ Success? → Done ✓
│     └─ "Prompt too long" error? → Use Tier 2
│
├─ Any other case (medium/large content, WebFetch failed)?
│  └─ Use curl + Task agent (Tier 2) ⭐ DEFAULT
│     ├─ Success? → Done ✓
│     └─ Task agent struggles with complex HTML/encoding? → Use Tier 3
│
└─ Edge cases (Task agent fails, special encoding)?
   └─ Use curl + script (Tier 3)
      ├─ Standard HTML → scripts/extract_article.js
      └─ EUC-JP encoding → scripts/extract_eucjp.js
```

## Script-Based Parsing (Tier 3)

Use these scripts only when Task agent (Tier 2) fails or for special requirements. Most cases don't need scripts.

### Node.js with Mozilla Readability

**Script**: `scripts/extract_article.js`

**Purpose**: Extract article content using Mozilla's Readability algorithm (same as Firefox Reader View)

**Requirements**:

```bash
cd .claude/skills/web-content-fetcher
pnpm install @mozilla/readability jsdom
```

**Usage**:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_article.js path/to/raw_html.html > output.md
```

**Best For**:

- Standard UTF-8 encoded HTML
- Complex page structures Task agent struggles with
- Consistent extraction using battle-tested algorithm

**Example Workflow**:

```bash
# 1. Setup (one-time)
cd .claude/skills/web-content-fetcher
pnpm install @mozilla/readability jsdom

# 2. Fetch and extract
mkdir -p output/tasks/20260110_article/original
cd output/tasks/20260110_article/original
curl -s "https://example.com/article" > raw_html.html
node .claude/skills/web-content-fetcher/scripts/extract_article.js raw_html.html > fetched_content.md
```

### Node.js with EUC-JP Support

**Script**: `scripts/extract_eucjp.js`

**Purpose**: Extract content from EUC-JP encoded Japanese websites (4gamer.net, older Japanese sites)

**Requirements**:

```bash
cd .claude/skills/web-content-fetcher
pnpm install @mozilla/readability jsdom iconv-lite
```

**Usage**:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js path/to/raw_html.html > output.md
```

**Best For**:

- Japanese websites with EUC-JP encoding (4gamer.net, government sites)
- When you see garbled Japanese characters (mojibake/文字化け)
- Sites that haven't migrated to UTF-8

**Example Workflow**:

```bash
# 1. Setup (one-time)
cd .claude/skills/web-content-fetcher
pnpm install @mozilla/readability jsdom iconv-lite

# 2. Fetch and extract
mkdir -p output/tasks/20260110_4gamer_article/original
cd output/tasks/20260110_4gamer_article/original
curl -s "https://www.4gamer.net/games/999/G999999/..." > raw_html.html
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js raw_html.html > fetched_content.md
```

**How to Identify EUC-JP Pages**:

1. Extracted content shows garbled Japanese characters
2. HTML meta tag shows: `<meta charset="EUC-JP">` or `charset=euc-jp`
3. Common on older Japanese sites (4gamer.net, academic sites, government sites)

**Note**: Always try Task agent (Tier 2) first with encoding detection instructions. Only use this script if Task agent cannot properly handle the encoding.

### Playwright for JavaScript-Rendered Content

**Script**: `scripts/fetch_js_content.js`

**Purpose**: Fetch and extract content from JavaScript-rendered websites using headless browser (Twitter/X, React SPAs, dynamic content)

**Requirements**:

```bash
cd .claude/skills/web-content-fetcher
pnpm add -D playwright --save-catalog-name=dev
pnpm exec playwright install chromium
```

**Usage**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js <url> [options]

Options:
  --output <file>    Output file path (default: stdout)
  --selector <sel>   CSS selector to wait for (default: auto-detect)
  --timeout <ms>     Page load timeout (default: 30000)
```

**Best For**:

- Twitter/X posts (automatic tweet extraction with metadata)
- Facebook, LinkedIn, Instagram (with proper authentication)
- React/Vue/Angular single-page applications
- Content loaded dynamically via JavaScript/AJAX
- Sites that show "JavaScript required" error with static fetch

**Example Workflows**:

**Twitter/X Post**:
```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output output/tasks/20260111_twitter/original/fetched_content.md
```

**React SPA**:
```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://example-react-app.com/article" \
  --selector ".main-content" \
  --timeout 60000 \
  --output fetched_content.md
```

**How It Works**:

1. Launches headless Chromium browser
2. Navigates to URL and waits for JavaScript to execute
3. Auto-detects site type (Twitter/X has custom extraction logic)
4. Waits for content to load (specified selector or default)
5. Extracts clean content to markdown
6. Closes browser and returns result

**Site-Specific Features**:

- **Twitter/X**: Automatically extracts tweet text, author, timestamp, quoted tweets, and media descriptions
- **Generic Sites**: Extracts main content area (article, main, [role="main"])
- **Custom Selectors**: Specify exact element to wait for and extract

**Troubleshooting**:

- **Timeout errors**: Increase `--timeout` value (default 30000ms)
- **Content not found**: Specify `--selector` for the main content element
- **Authentication required**: This script doesn't handle login flows (use browser extensions or API instead)

**Performance Notes**:

- Slower than static fetch (3-10 seconds vs <1 second)
- Requires ~200MB Chromium browser installation
- Uses more memory (headless browser process)
- Only use when JavaScript is truly required

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

### Pattern 5: Fetch JavaScript-Rendered Content (Twitter/X, SPAs)

```
1. mkdir -p output/tasks/20260111_twitter_post/original
2. node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
   "https://x.com/user/status/123456789" \
   --output output/tasks/20260111_twitter_post/original/fetched_content.md
3. Use fetched_content.md for translation/analysis
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
3. Manually inspect raw_html.html to understand page structure
4. Refine extraction by providing Task agent with specific HTML structure details

### Issue: Japanese text shows garbled characters (mojibake/文字化け)

**Symptoms**:

- Japanese characters appear as `�`, `�`, or random symbols
- Text is unreadable despite being from a Japanese site

**Cause**: Many Japanese websites (like 4gamer.net) use EUC-JP encoding instead of UTF-8.

**Solution 1 (Try first)**: Use Task agent with specific encoding instructions:

```
Task agent prompt: "Read the HTML file at [path]. This file uses EUC-JP encoding.
Detect the encoding, properly decode the content, then extract the article content.
Save the clean markdown to fetched_content.md"
```

**Solution 2 (If Task agent fails)**: Use the EUC-JP extraction script:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js raw_html.html > fetched_content.md
```

**Common sites requiring special encoding handling**:

- 4gamer.net
- Many older Japanese gaming/news sites
- Government and academic sites in Japan

**How to identify**:

1. If extracted content is garbled, check the HTML file's encoding
2. Look for `<meta charset="EUC-JP">` or `charset=euc-jp` in raw HTML
3. Common for sites that haven't migrated to UTF-8
4. Task agent can usually detect and handle different encodings when instructed, but the extract_eucjp.js script is available if needed

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

### Issue: Page requires JavaScript / Shows "JavaScript not available"

**Symptoms**:

- curl or WebFetch returns error message like "JavaScript is not available"
- Fetched HTML contains empty state objects or no content
- Page is a React/Vue/Angular SPA or social media site

**Solution**: Use Playwright script (Tier 4):

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "URL" \
  --output fetched_content.md \
  --timeout 60000
```

**Common sites requiring JavaScript**:

- Twitter/X (x.com)
- Modern single-page applications
- Dynamic dashboards
- Content-heavy React/Vue apps

**Setup required** (one-time):

```bash
cd .claude/skills/web-content-fetcher
pnpm add -D playwright --save-catalog-name=dev
pnpm exec playwright install chromium
```

## Best Practices Summary

1. **Always use task directories**: Organize content in `output/tasks/YYYYMMDD_taskname/`
2. **Keep raw HTML**: Save to `original/raw_html.html` for reference and re-processing (not needed for Tier 4 Playwright)
3. **Default to Tier 2**: curl + Task agent works for nearly all cases and handles any content size
4. **Use Playwright for JavaScript sites**: Twitter/X, React SPAs, and dynamic content require Tier 4
5. **Clean content format**: Always save extracted content as markdown in `fetched_content.md`
6. **Descriptive naming**: Use date prefix and descriptive task names
7. **Error handling**: Try WebFetch for small content, fall back to curl + Task agent if needed
8. **Task agent for extraction**: Let AI handle pagination, encoding detection, and parsing complexity
9. **Scripts for edge cases**: Tier 3 scripts (extract_article.js, extract_eucjp.js) available when Task agent fails or for special encoding requirements
10. **Progressive approach**: Check if JavaScript required first (Tier 4), try WebFetch (Tier 1), default to Task agent (Tier 2), scripts only if needed (Tier 3)

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

**Fetch JavaScript-rendered content**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js "URL" --output content.md
```

**Fetch Twitter/X post**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output twitter_post.md
```
