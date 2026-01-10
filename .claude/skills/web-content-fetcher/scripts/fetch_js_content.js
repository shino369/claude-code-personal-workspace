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
import { runIfMain } from '#utils/module-runner.js';

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
      extractFunction: extractTwitterContent
    };
  }

  // Default config for generic sites
  return {
    name: 'Generic',
    waitSelector: customSelector || 'body',
    extractFunction: extractGenericContent
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
      // Extract tweet text
      const tweetTextElement = document.querySelector('[data-testid="tweetText"]');
      const tweetText = tweetTextElement ? tweetTextElement.innerText : 'Tweet text not found';

      // Extract author info
      const userNameElement = document.querySelector('[data-testid="User-Name"]');
      const userName = userNameElement ? userNameElement.innerText : 'Unknown';

      // Extract timestamp
      const timeElement = document.querySelector('time');
      const timestamp = timeElement ? timeElement.getAttribute('datetime') : 'Unknown';

      // Extract quoted tweet if present
      let quotedTweet = null;
      const quotedTweetElement = document.querySelector('[data-testid="tweetText"]');
      if (quotedTweetElement && document.querySelectorAll('[data-testid="tweetText"]').length > 1) {
        const quotedTexts = Array.from(document.querySelectorAll('[data-testid="tweetText"]'));
        if (quotedTexts.length > 1) {
          quotedTweet = quotedTexts[1].innerText;
        }
      }

      // Extract media alt texts if present
      const mediaElements = Array.from(document.querySelectorAll('[data-testid="tweetPhoto"] img'));
      const mediaAlts = mediaElements.map(img => img.alt).filter(alt => alt);

      return {
        userName,
        tweetText,
        timestamp,
        quotedTweet,
        mediaAlts
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

  if (tweetData.mediaAlts && tweetData.mediaAlts.length > 0) {
    markdown += `### Media Descriptions\n\n`;
    tweetData.mediaAlts.forEach((alt, i) => {
      markdown += `${i + 1}. ${alt}\n`;
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
        'body'
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
      const title = document.querySelector('h1')?.innerText || document.title || 'Untitled';

      // Extract text content
      const textContent = mainElement.innerText || mainElement.textContent || 'No content found';

      return {
        title,
        content: textContent
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
 * @param {object} content - Content object with title and content
 * @returns {string} Formatted markdown
 */
export function formatGenericMarkdown(content) {
  let markdown = `# ${content.title}\n\n`;
  markdown += `${content.content}\n`;
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
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ]
    });

    // Create browser context with viewport and user agent
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // Create new page
    const page = await context.newPage();

    // Navigate to URL
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeout
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
      'full-page': { type: 'boolean', default: false }
    },
    allowPositionals: true
  });

  const url = positionals[0];
  const outputFile = values.output;
  const selector = values.selector;
  const timeout = parseInt(values.timeout, 10);

  if (!url) {
    console.error('Error: URL is required');
    console.error('Usage: node fetch_js_content.js <url> [options]');
    process.exit(1);
  }

  try {
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
    if (outputFile) {
      writeFileSync(outputFile, markdown, 'utf-8');
      console.error(`Content saved to: ${outputFile}`);
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
