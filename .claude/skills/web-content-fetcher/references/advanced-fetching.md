# Advanced Fetching Methods

This reference covers advanced fetching methods for edge cases: script-based extraction (Tier 3) and JavaScript-rendered content (Tier 4).

**When to use this guide**: Only when standard Task agent approach (Tier 2) fails or for special requirements.

## Table of Contents

- [Tier 3: Script-Based Extraction](#tier-3-script-based-extraction)
  - [extract_article.js - Standard HTML](#extractarticlejs---standard-html)
  - [extract_eucjp.js - Japanese EUC-JP Encoding](#extracteucjpjs---japanese-euc-jp-encoding)
- [Tier 4: JavaScript-Rendered Content](#tier-4-javascript-rendered-content)
  - [Playwright Setup](#playwright-setup)
  - [fetch_js_content.js Usage](#fetchjscontentjs-usage)
  - [Site-Specific Features](#site-specific-features)

## Tier 3: Script-Based Extraction

**Use only when**: Task agent struggles with complex HTML, need precise control, or have special encoding requirements.

**Note**: Task agent (Tier 2) handles 99% of cases including large files and complex HTML. Use scripts only when Task agent explicitly fails or for special encoding requirements.

### extract_article.js - Standard HTML

**Purpose**: Extract article content using Mozilla's Readability algorithm (same as Firefox Reader View)

**Requirements** (one-time setup):

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

**Complete Workflow Example**:

```bash
# 1. Setup (one-time)
cd .claude/skills/web-content-fetcher
pnpm install @mozilla/readability jsdom

# 2. Create task directory
mkdir -p output/tasks/20260111_article/original

# 3. Fetch HTML
curl -s "https://example.com/article" > output/tasks/20260111_article/original/raw_html.html

# 4. Extract with script
node .claude/skills/web-content-fetcher/scripts/extract_article.js \
  output/tasks/20260111_article/original/raw_html.html \
  > output/tasks/20260111_article/original/fetched_content.md
```

### extract_eucjp.js - Japanese EUC-JP Encoding

**Purpose**: Extract content from EUC-JP encoded Japanese websites (4gamer.net, older Japanese sites)

**Requirements** (one-time setup):

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

**How to Identify EUC-JP Pages**:

1. Extracted content shows garbled Japanese characters
2. HTML meta tag shows: `<meta charset="EUC-JP">` or `charset=euc-jp`
3. Common on older Japanese sites (4gamer.net, academic sites, government sites)

**Complete Workflow Example**:

```bash
# 1. Setup (one-time)
cd .claude/skills/web-content-fetcher
pnpm install @mozilla/readability jsdom iconv-lite

# 2. Create task directory
mkdir -p output/tasks/20260111_4gamer_article/original

# 3. Fetch HTML
curl -s "https://www.4gamer.net/games/999/G999999/..." > output/tasks/20260111_4gamer_article/original/raw_html.html

# 4. Extract with EUC-JP script
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js \
  output/tasks/20260111_4gamer_article/original/raw_html.html \
  > output/tasks/20260111_4gamer_article/original/fetched_content.md
```

**Important**: Always try Task agent (Tier 2) first with encoding detection instructions. Only use this script if Task agent cannot properly handle the encoding.

## Tier 4: JavaScript-Rendered Content

**Use when**: Website requires JavaScript to load content (Twitter/X, React SPAs, dynamic websites), static fetch returns error messages or empty content.

### Playwright Setup

**One-time installation**:

```bash
cd .claude/skills/web-content-fetcher
pnpm add -D playwright --save-catalog-name=dev
pnpm exec playwright install chromium
```

**Requirements**:

- ~200MB disk space for Chromium browser
- Internet connection for initial download

### fetch_js_content.js Usage

**Script**: `scripts/fetch_js_content.js`

**Basic Usage**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js <url> [options]
```

**Options**:

- `--output <file>`: Output file path (default: stdout)
- `--selector <sel>`: CSS selector to wait for (auto-detected for Twitter/X)
- `--timeout <ms>`: Page load timeout (default: 30000)

**Best For**:

- Twitter/X posts (automatic tweet extraction)
- React/Vue/Angular single-page applications
- Content loaded dynamically via AJAX
- Sites that show "JavaScript required" error

### Supported Sites and Examples

#### Twitter/X Posts

Automatic tweet extraction with metadata (author, timestamp, quoted tweets, media descriptions).

```bash
# Twitter/X example
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output output/tasks/20260111_twitter/original/fetched_content.md
```

**Complete Workflow**:

```bash
# 1. Create task directory
mkdir -p output/tasks/20260111_twitter_post/original

# 2. Fetch with Playwright (no raw HTML needed)
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output output/tasks/20260111_twitter_post/original/fetched_content.md

# 3. Use extracted content
```

#### React/Vue/Angular SPAs

```bash
# Generic React SPA
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://example-react-app.com/article" \
  --selector ".main-content" \
  --timeout 60000 \
  --output fetched_content.md
```

#### Dynamic Content Sites

```bash
# Site with AJAX-loaded content
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://dynamic-site.com/page" \
  --selector "#content-loaded" \
  --output fetched_content.md
```

### Site-Specific Features

**Twitter/X**:

- Automatically extracts tweet text, author, timestamp
- Includes quoted tweets if present
- Extracts media descriptions (alt text)
- No need to specify selector

**Generic Sites**:

- Extracts main content area (article, main, [role="main"])
- Waits for page load and JavaScript execution
- Can specify custom selector for precise extraction

### How It Works

1. Launches headless Chromium browser
2. Navigates to URL and waits for JavaScript to execute
3. Auto-detects site type (Twitter/X has custom extraction logic)
4. Waits for content to load (specified selector or default)
5. Extracts clean content to markdown
6. Closes browser and returns result

### Performance Notes

**Comparison with Static Fetch**:

- **Playwright**: 3-10 seconds (browser launch + JS execution)
- **curl**: <1 second (direct HTTP request)

**Resource Usage**:

- ~200MB disk space (Chromium browser)
- More memory (headless browser process)
- CPU usage during JavaScript execution

**When to Use**:

- Only when JavaScript is truly required
- Content doesn't appear with static fetch (curl)
- Site shows "JavaScript required" or similar error

**Pros**:

- Handles JavaScript rendering
- Auto-detects site types
- Extracts structured content

**Cons**:

- Slower than static fetching
- Requires Chromium browser installation
- Higher resource usage

### Advanced Usage

**Custom Selector for Specific Content**:

```bash
# Wait for and extract specific element
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://example.com/page" \
  --selector ".article-body" \
  --output content.md
```

**Longer Timeout for Slow Sites**:

```bash
# Increase timeout to 2 minutes
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://slow-loading-site.com/page" \
  --timeout 120000 \
  --output content.md
```

**Output to Stdout for Piping**:

```bash
# Output to stdout (default)
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123" | grep "keyword"
```

### Limitations

**Authentication**: This script doesn't handle login flows. For authenticated content:

- Use browser extensions to export cookies
- Use official APIs if available
- Manual login + cookie export

**Rate Limiting**: Respect site rate limits and robots.txt. Consider:

- Adding delays between requests
- Using official APIs when available
- Checking terms of service

**Dynamic Content**: Some sites load content asynchronously after initial render. If content is missing:

- Increase `--timeout` value
- Specify exact `--selector` to wait for
- Check if content requires user interaction (scrolling, clicking)
