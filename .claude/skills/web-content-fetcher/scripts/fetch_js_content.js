#!/usr/bin/env node

/**
 * Fetch JavaScript-rendered content using Playwright
 *
 * This script uses a headless browser to render JavaScript and extract content
 * from dynamic websites like Twitter/X, React apps, and SPAs.
 *
 * Usage:
 *   node fetch_js_content.js <url> [options]
 *
 * Options:
 *   --output <file>    Output file path (default: stdout)
 *   --selector <sel>   CSS selector to wait for (default: auto-detect)
 *   --timeout <ms>     Page load timeout in milliseconds (default: 30000)
 *   --full-page        Extract full page content instead of article only
 *
 * Examples:
 *   node fetch_js_content.js https://x.com/user/status/123456789
 *   node fetch_js_content.js https://example.com --output content.md
 *   node fetch_js_content.js https://example.com --selector ".main-content" --timeout 60000
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { resolve, isAbsolute, sep } from 'path';
import { runIfMain } from '#utils/module-runner.js';

/**
 * Validate URL to prevent SSRF attacks
 * @param {string} url - The URL to validate
 * @throws {Error} If URL is invalid or uses unsafe protocol
 */
export function validateUrl(url) {
  try {
    const urlObj = new URL(url);
    const allowedProtocols = ['http:', 'https:', 'file:'];

    if (!allowedProtocols.includes(urlObj.protocol)) {
      throw new Error(
        `Invalid protocol: ${urlObj.protocol}. Only http:, https:, and file: are allowed.`
      );
    }

    // Additional check for file:// URLs - prevent access to sensitive locations
    if (urlObj.protocol === 'file:') {
      const path = urlObj.pathname.toLowerCase();
      // Block common sensitive paths (basic protection)
      // Note: Windows paths in URLs look like /C:/Windows/System32
      const blockedPaths = [
        '/etc/',
        '/sys/',
        '/proc/',
        '/windows/system32/',
        ':/windows/system32/',
      ];
      if (blockedPaths.some((blocked) => path.includes(blocked))) {
        throw new Error(
          'Access to sensitive system directories is not allowed.'
        );
      }
    }
  } catch (error) {
    if (error.message.includes('Invalid URL')) {
      throw new Error(`Invalid URL format: ${url}`);
    }
    throw error;
  }
}

/**
 * Validate and sanitize output file path to prevent path traversal
 * @param {string} filePath - The file path to validate
 * @returns {string} Resolved safe file path
 * @throws {Error} If path is unsafe
 */
export function validateOutputPath(filePath) {
  const currentDir = process.cwd();

  // Detect Windows-style absolute paths (C:\... or C:/...) even on non-Windows systems
  // This is important for cross-platform security validation
  const windowsAbsolutePathPattern = /^[A-Za-z]:[/\\]/;
  if (windowsAbsolutePathPattern.test(filePath)) {
    const resolvedPath = resolve(filePath);

    // If after resolution, the path no longer matches the Windows pattern,
    // it means we're on a non-Windows system where it was treated as a relative path.
    // This is suspicious behavior and should be rejected.
    if (!windowsAbsolutePathPattern.test(resolvedPath)) {
      throw new Error(
        `Output path must be within current directory. Attempted: ${filePath}`
      );
    }

    // We're on Windows, validate that the absolute path is within current directory
    const normalizedResolved = resolvedPath.split(sep).join('/').toLowerCase();
    const normalizedCwd = currentDir.split(sep).join('/').toLowerCase();

    if (!normalizedResolved.startsWith(normalizedCwd + '/')) {
      throw new Error(
        `Output path must be within current directory. Attempted: ${resolvedPath}`
      );
    }
    return resolvedPath;
  }

  // Check if the input path is absolute (Unix-style: /etc/passwd)
  if (isAbsolute(filePath)) {
    const resolvedPath = resolve(filePath);
    // Normalize both paths to ensure proper comparison across platforms
    const normalizedResolved = resolvedPath.split(sep).join('/').toLowerCase();
    const normalizedCwd = currentDir.split(sep).join('/').toLowerCase();

    if (!normalizedResolved.startsWith(normalizedCwd + '/')) {
      throw new Error(
        `Output path must be within current directory. Attempted: ${resolvedPath}`
      );
    }
    return resolvedPath;
  }

  // For relative paths, resolve and check
  const resolvedPath = resolve(filePath);
  if (!resolvedPath.startsWith(currentDir)) {
    throw new Error(
      `Output path must be within current directory. Attempted: ${resolvedPath}`
    );
  }

  return resolvedPath;
}

/**
 * Validate timeout value
 * @param {number} timeout - Timeout in milliseconds
 * @returns {number} Validated timeout
 * @throws {Error} If timeout is invalid
 */
export function validateTimeout(timeout) {
  const MIN_TIMEOUT = 1000; // 1 second
  const MAX_TIMEOUT = 300000; // 5 minutes

  if (isNaN(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
    throw new Error(
      `Timeout must be between ${MIN_TIMEOUT} and ${MAX_TIMEOUT} milliseconds.`
    );
  }

  return timeout;
}

/**
 * Detect site type and return appropriate selectors
 * @param {string} url - The URL to fetch
 * @param {string} [customSelector] - Custom CSS selector to wait for
 * @returns {object} Site configuration
 */
export function getSiteConfig(url, customSelector = null) {
  if (url.includes('x.com') || url.includes('twitter.com')) {
    return {
      name: 'Twitter/X',
      waitSelector: customSelector || 'article[data-testid="tweet"]',
      extractFunction: extractTwitterContent,
    };
  }

  // Default config for generic sites
  return {
    name: 'Generic',
    waitSelector: customSelector || 'body',
    extractFunction: extractGenericContent,
  };
}

/**
 * Extract Twitter/X tweet content
 * @param {import('playwright').Page} page - Playwright page object
 * @returns {Promise<string>} Formatted markdown content
 */
export async function extractTwitterContent(page) {
  try {
    /* eslint-disable no-undef -- Code runs in browser context where document is defined */
    /* c8 ignore start -- Browser context code */
    const tweetData = await page.evaluate(() => {
      // Extract all tweet text elements at once
      const tweetTextElements = Array.from(
        document.querySelectorAll('[data-testid="tweetText"]')
      );
      const tweetText = tweetTextElements[0]
        ? tweetTextElements[0].innerText
        : 'Tweet text not found';

      // Extract author info
      const userNameElement = document.querySelector(
        '[data-testid="User-Name"]'
      );
      const userName = userNameElement ? userNameElement.innerText : 'Unknown';

      // Extract timestamp
      const timeElement = document.querySelector('time');
      const timestamp = timeElement
        ? timeElement.getAttribute('datetime')
        : 'Unknown';

      // Extract quoted tweet if present (will be the second tweet text element)
      const quotedTweet =
        tweetTextElements.length > 1 ? tweetTextElements[1].innerText : null;

      // Extract media alt texts and URLs if present
      const mediaElements = Array.from(
        document.querySelectorAll('[data-testid="tweetPhoto"] img')
      );
      const media = mediaElements.map((img) => ({
        url: img.src,
        alt: img.alt || 'Image',
      }));

      return {
        userName,
        tweetText,
        timestamp,
        quotedTweet,
        media,
      };
    });
    /* c8 ignore stop */
    /* eslint-enable no-undef */

    return formatTwitterMarkdown(tweetData);
  } catch (error) {
    throw new Error(`Failed to extract Twitter content: ${error.message}`);
  }
}

/**
 * Format Twitter data as markdown
 * @param {object} tweetData - Tweet data object
 * @returns {string} Formatted markdown
 */
export function formatTwitterMarkdown(tweetData) {
  let markdown = `# Twitter/X Post\n\n`;
  markdown += `**Author:** ${tweetData.userName}\n`;
  markdown += `**Timestamp:** ${tweetData.timestamp}\n\n`;
  markdown += `## Tweet Content\n\n`;
  markdown += `${tweetData.tweetText}\n\n`;

  if (tweetData.quotedTweet) {
    markdown += `### Quoted Tweet\n\n`;
    markdown += `> ${tweetData.quotedTweet}\n\n`;
  }

  if (tweetData.media && tweetData.media.length > 0) {
    markdown += `### Media\n\n`;
    tweetData.media.forEach((item, i) => {
      markdown += `${i + 1}. ${item.alt}\n`;
      markdown += `   - URL: ${item.url}\n`;
    });
    markdown += `\n`;
  }

  return markdown;
}

/**
 * Extract generic page content
 * @param {import('playwright').Page} page - Playwright page object
 * @returns {Promise<string>} Formatted markdown content
 */
export async function extractGenericContent(page) {
  try {
    /* eslint-disable no-undef -- Code runs in browser context where document is defined */
    /* c8 ignore start -- Browser context code */
    const content = await page.evaluate(() => {
      // Try to find main content area
      const mainSelectors = [
        'main',
        'article',
        '[role="main"]',
        '.content',
        '#content',
        '.main-content',
        'body',
      ];

      let mainElement = null;
      for (const selector of mainSelectors) {
        mainElement = document.querySelector(selector);
        if (mainElement) break;
      }

      if (!mainElement) {
        mainElement = document.body;
      }

      // Extract title
      const title =
        document.querySelector('h1')?.innerText || document.title || 'Untitled';

      // Extract text content
      const textContent =
        mainElement.innerText || mainElement.textContent || 'No content found';

      // Extract images from main content area
      const imageElements = Array.from(mainElement.querySelectorAll('img'));
      const media = imageElements
        .filter((img) => {
          // Filter out tiny images (likely icons/logos)
          const width = img.width || img.naturalWidth || 0;
          const height = img.height || img.naturalHeight || 0;
          return width > 100 && height > 100;
        })
        .map((img) => ({
          url: img.src,
          alt: img.alt || 'Image',
        }));

      return {
        title,
        content: textContent,
        media,
      };
    });
    /* c8 ignore stop */
    /* eslint-enable no-undef */

    return formatGenericMarkdown(content);
  } catch (error) {
    throw new Error(`Failed to extract generic content: ${error.message}`);
  }
}

/**
 * Format generic content as markdown
 * @param {object} content - Content object with title, content, and optional media
 * @returns {string} Formatted markdown
 */
export function formatGenericMarkdown(content) {
  let markdown = `# ${content.title}\n\n`;
  markdown += `${content.content}\n`;

  if (content.media && content.media.length > 0) {
    markdown += `\n### Media\n\n`;
    content.media.forEach((item, i) => {
      markdown += `${i + 1}. ${item.alt}\n`;
      markdown += `   - URL: ${item.url}\n`;
    });
    markdown += `\n`;
  }

  return markdown;
}

/**
 * Fetch and extract content from a URL
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {string} [options.selector] - CSS selector to wait for
 * @param {number} [options.timeout=30000] - Page load timeout in ms
 * @param {number} [options.waitDelay=2000] - Additional delay after content loads in ms
 * @returns {Promise<string>} Extracted markdown content
 */
/* c8 ignore start -- Browser automation code, tested through integration tests */
export async function fetchContent(url, options = {}) {
  const { selector = null, timeout = 30000, waitDelay = null } = options;

  // Auto-detect delay: file:// URLs need less wait time
  const defaultDelay = url.startsWith('file://') ? 500 : 2000;
  const actualDelay = waitDelay !== null ? waitDelay : defaultDelay;

  let browser = null;

  try {
    // Get site-specific configuration
    const siteConfig = getSiteConfig(url, selector);

    // Launch browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    // Create browser context with viewport and user agent
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    // Create new page
    const page = await context.newPage();

    // Navigate to URL
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeout,
    });

    // Wait for content to load
    await page.waitForSelector(siteConfig.waitSelector, { timeout: timeout });

    // Small additional delay to ensure content is fully rendered
    // Shorter delay for local files, longer for remote sites
    await page.waitForTimeout(actualDelay);

    // Extract content using site-specific function
    const markdown = await siteConfig.extractFunction(page);

    return markdown;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
/* c8 ignore stop */

/**
 * Main function
 */
/* c8 ignore start -- CLI entry point, tested through integration tests */
export async function main() {
  // Parse command line arguments
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      output: { type: 'string', short: 'o' },
      selector: { type: 'string', short: 's' },
      timeout: { type: 'string', short: 't', default: '30000' },
      'full-page': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const url = positionals[0];
  const outputFile = values.output;
  const selector = values.selector;

  if (!url) {
    console.error('Error: URL is required');
    console.error('Usage: node fetch_js_content.js <url> [options]');
    process.exit(1);
  }

  try {
    // Validate URL to prevent SSRF
    validateUrl(url);

    // Validate timeout
    const timeout = validateTimeout(parseInt(values.timeout, 10));

    // Validate output path if provided
    let validatedOutputFile = null;
    if (outputFile) {
      validatedOutputFile = validateOutputPath(outputFile);
    }

    console.error(`Fetching content from: ${url}`);

    // Get site-specific configuration for logging
    const siteConfig = getSiteConfig(url, selector);
    console.error(`Detected site type: ${siteConfig.name}`);
    console.error('Launching headless browser...');
    console.error(`Navigating to URL...`);
    console.error(`Waiting for content selector: ${siteConfig.waitSelector}`);
    console.error('Extracting content...');

    // Fetch content
    const markdown = await fetchContent(url, { selector, timeout });

    // Output result
    if (validatedOutputFile) {
      writeFileSync(validatedOutputFile, markdown, 'utf-8');
      console.error(`Content saved to: ${validatedOutputFile}`);
    } else {
      console.log(markdown);
    }

    console.error('Fetch completed successfully!');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */

// Run main function only when called directly
runIfMain(import.meta.url, main);
