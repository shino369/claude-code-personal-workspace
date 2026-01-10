# Troubleshooting Guide

This reference provides solutions to common issues when fetching web content and quick reference commands for various scenarios.

## Table of Contents

- [Common Issues](#common-issues)
- [Quick Reference Commands](#quick-reference-commands)

## Common Issues

### Issue: WebFetch returns "Prompt too long"

**Cause**: Content exceeds WebFetch's ~50KB limit

**Solution**: Switch to Tier 2 (curl + Task agent)

```bash
# Instead of WebFetch, use:
mkdir -p output/tasks/YYYYMMDD_task/original
curl -s "URL" > output/tasks/YYYYMMDD_task/original/raw_html.html
# Then extract with Task agent
```

### Issue: Read tool says file too large (> 256KB)

**Cause**: Fetched HTML file exceeds 256KB limit for single Read operation

**Solution**: Use Task agent which handles pagination automatically

```
Task agent prompt: "Read the HTML file at [path] and extract the main article content.
Save clean markdown to fetched_content.md"
```

**Alternative**: Use Grep to search specific content without reading entire file

```
Grep pattern="article title" path="raw_html.html"
```

### Issue: Extracted content is messy or incomplete

**Symptoms**:

- Navigation menus mixed with content
- Missing paragraphs or sections
- Excessive formatting or HTML remnants

**Solutions**:

1. **Improve Task agent prompt** (be more specific):

```
"Read the HTML file at [path]. Extract ONLY the main article content including:
- Article title (h1)
- Body paragraphs
- Subheadings (h2-h6)
EXCLUDE: navigation, sidebars, ads, comments, footer, related articles.
Save clean markdown to fetched_content.md"
```

2. **Check if page uses JavaScript rendering** (may need Playwright - Tier 4)

3. **Manually inspect raw_html.html** to understand page structure:

```bash
# Check page structure
grep -i "<article" raw_html.html
grep -i "class=\"content" raw_html.html
```

4. **Provide specific HTML structure details** to Task agent:

```
"The main content is in <article class='post-content'>. Extract only from that section."
```

### Issue: Japanese text shows garbled characters (mojibake/文字化け)

**Symptoms**:

- Japanese characters appear as `�`, `�`, or random symbols
- Text is unreadable despite being from a Japanese site

**Cause**: Website uses EUC-JP encoding instead of UTF-8 (common on older Japanese sites like 4gamer.net)

**Solution 1** (Try first): Use Task agent with encoding instructions:

```
Task agent prompt: "Read the HTML file at [path]. This file uses EUC-JP encoding.
Detect the encoding, properly decode the content, then extract the article content.
Save the clean markdown to fetched_content.md"
```

**Solution 2** (If Task agent fails): Use EUC-JP extraction script:

```bash
node .claude/skills/web-content-fetcher/scripts/extract_eucjp.js raw_html.html > fetched_content.md
```

**Common sites requiring special encoding handling**:

- 4gamer.net
- Older Japanese gaming/news sites
- Japanese government and academic sites

**How to identify EUC-JP encoding**:

1. Check HTML meta tag in raw file:

```bash
grep -i "charset" raw_html.html
# Look for: <meta charset="EUC-JP"> or charset=euc-jp
```

2. If extracted content is garbled, encoding is likely the issue

### Issue: Page has anti-bot protection

**Symptoms**:

- HTTP 403 Forbidden error
- Cloudflare challenge page
- "Access denied" message

**Solutions**:

1. **Add user agent**:

```bash
curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "URL" > raw_html.html
```

2. **Add common browser headers**:

```bash
curl -H "Accept-Language: en-US,en;q=0.9" \
     -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
     -H "Accept-Encoding: gzip, deflate, br" \
     -A "Mozilla/5.0" \
     "URL" > raw_html.html
```

3. **Use cookies if you have session**:

```bash
curl -b "session=abc123" "URL" > raw_html.html
```

4. **Use Playwright** (for complex bot detection):

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js "URL" --output content.md
```

### Issue: Content requires authentication

**Symptoms**:

- HTTP 401 Unauthorized
- Login page returned instead of content
- "Members only" message

**Solutions**:

**Bearer Token Authentication**:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" "URL" > raw_html.html
```

**Cookie-based Authentication**:

```bash
# Export cookies from browser, then:
curl -b "session=YOUR_SESSION_COOKIE; auth=YOUR_AUTH_COOKIE" "URL" > raw_html.html
```

**Basic Authentication**:

```bash
curl -u username:password "URL" > raw_html.html
```

**Multiple Headers**:

```bash
curl -H "Authorization: Bearer TOKEN" \
     -H "X-API-Key: KEY" \
     "URL" > raw_html.html
```

### Issue: Page redirects to different domain

**Symptoms**:

- Fetched content is redirect page or error
- Content is from different domain than expected

**Solution**: Use `-L` flag to follow redirects:

```bash
curl -L "URL" > raw_html.html
```

**Check redirect chain**:

```bash
curl -I -L "URL"
# Shows all HTTP headers and redirects
```

### Issue: Timeout or slow connection

**Symptoms**:

- curl hangs or takes very long
- "Operation timed out" error

**Solution**: Increase timeout and show progress:

```bash
# Increase timeout to 60 seconds
curl --max-time 60 "URL" > raw_html.html
```

**With progress bar** (remove `-s` flag):

```bash
curl -L --max-time 60 "URL" > raw_html.html
```

**Check connection first**:

```bash
curl -I --max-time 10 "URL"
# Returns headers quickly to test connectivity
```

### Issue: Page requires JavaScript / Shows "JavaScript not available"

**Symptoms**:

- curl or WebFetch returns error message like "JavaScript is not available"
- Fetched HTML contains empty state objects `<div id="root"></div>` with no content
- Page is a React/Vue/Angular SPA or social media site
- Content appears in browser but not in fetched HTML

**Solution**: Use Playwright script (Tier 4):

```bash
# Twitter/X example
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output fetched_content.md

# Generic SPA with longer timeout
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://react-app.com/page" \
  --selector ".main-content" \
  --timeout 60000 \
  --output fetched_content.md
```

**Common sites requiring JavaScript**:

- Twitter/X (x.com)
- Modern single-page applications (React/Vue/Angular)
- Dynamic dashboards
- Content loaded via AJAX after page load

**Setup required** (one-time):

```bash
cd .claude/skills/web-content-fetcher
pnpm add -D playwright --save-catalog-name=dev
pnpm exec playwright install chromium
```

### Issue: Playwright timeout errors

**Symptoms**:

- "Timeout 30000ms exceeded" error
- Page loads but content not found

**Solutions**:

1. **Increase timeout**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "URL" \
  --timeout 120000 \
  --output content.md
```

2. **Specify exact selector to wait for**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "URL" \
  --selector "#main-content" \
  --output content.md
```

3. **Check if content requires user interaction** (scrolling, clicking):

- Script doesn't handle interaction
- Consider official API instead

### Issue: Downloaded file is HTML when expecting binary

**Symptoms**:

- Expected PDF/image but got HTML
- File shows "404 Not Found" or error page

**Solution**: Check HTTP status before saving:

```bash
# Check status code first
STATUS=$(curl -s -o raw_html.html -w "%{http_code}" "URL")
if [ "$STATUS" -eq 200 ]; then
  echo "Success"
else
  echo "Failed with status: $STATUS"
  cat raw_html.html  # Show error page
fi
```

**Or use fail flag**:

```bash
# Exit on HTTP error
curl -f "URL" > raw_html.html || echo "Download failed"
```

## Quick Reference Commands

### Basic Fetch Operations

**Simple fetch**:

```bash
curl -s "URL" > raw_html.html
```

**Fetch with redirects**:

```bash
curl -s -L "URL" > raw_html.html
```

**Fetch with user agent**:

```bash
curl -s -A "Mozilla/5.0" "URL" > raw_html.html
```

**Fetch with timeout**:

```bash
curl -s --max-time 30 "URL" > raw_html.html
```

### Error Handling

**Fetch with error handling**:

```bash
curl -f -s -L --max-time 30 -A "Mozilla/5.0" "URL" > raw_html.html || echo "Fetch failed"
```

**Check HTTP status**:

```bash
curl -w "%{http_code}" -o raw_html.html "URL"
```

**Get headers only**:

```bash
curl -I "URL"
```

**Silent fetch with status**:

```bash
HTTP_CODE=$(curl -s -w "%{http_code}" -o raw_html.html "URL")
echo "Status: $HTTP_CODE"
```

### Authentication

**Bearer token**:

```bash
curl -H "Authorization: Bearer TOKEN" "URL" > raw_html.html
```

**Cookie authentication**:

```bash
curl -b "session=COOKIE" "URL" > raw_html.html
```

**Basic authentication**:

```bash
curl -u username:password "URL" > raw_html.html
```

### JavaScript-Rendered Content

**Fetch Twitter/X post**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://x.com/user/status/123456789" \
  --output twitter_post.md
```

**Fetch React SPA**:

```bash
node .claude/skills/web-content-fetcher/scripts/fetch_js_content.js \
  "https://react-app.com/page" \
  --selector ".main-content" \
  --timeout 60000 \
  --output content.md
```

### Content Inspection

**Check encoding**:

```bash
grep -i "charset" raw_html.html | head -5
```

**Check for JavaScript requirement**:

```bash
grep -i "javascript" raw_html.html | head -5
```

**Check main content areas**:

```bash
grep -i "<article" raw_html.html
grep -i "class=\"content" raw_html.html
grep -i "<main" raw_html.html
```

**Count HTML size**:

```bash
wc -c raw_html.html  # Size in bytes
```

### Debugging

**Fetch and show headers**:

```bash
curl -v "URL" > raw_html.html 2>&1 | grep "< HTTP"
```

**Test connectivity**:

```bash
curl -I --max-time 10 "URL"
```

**Show redirect chain**:

```bash
curl -I -L "URL"
```

**Check final URL after redirects**:

```bash
curl -Ls -o /dev/null -w "%{url_effective}" "URL"
```
