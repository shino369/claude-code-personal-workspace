/**
 * Integration tests for fetch_js_content.js
 *
 * These tests use actual Playwright browser automation to verify the script works end-to-end.
 * They are slower than unit tests but optimized to share test data and minimize browser launches.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetchContent } from '../fetch_js_content.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('fetch_js_content.js - Integration Tests', () => {
  let testHtmlPath;
  let testDir;

  beforeAll(() => {
    // Create a temporary directory for test files
    testDir = join(tmpdir(), `fetch-js-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create a simple test HTML file
    testHtmlPath = join(testDir, 'test.html');
    const testHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Test Page</title>
      </head>
      <body>
        <h1>Test Article Title</h1>
        <article>
          <p>This is the main content of the test article.</p>
          <p>It has multiple paragraphs.</p>
        </article>
      </body>
      </html>
    `;
    writeFileSync(testHtmlPath, testHtml, 'utf-8');
  });

  afterAll(() => {
    // Cleanup test files
    try {
      unlinkSync(testHtmlPath);
    } catch (_error) {
      // Ignore cleanup errors
    }
  });

  describe('fetchContent', () => {
    it('should fetch and extract content with custom options', async () => {
      const fileUrl = `file:///${testHtmlPath.replace(/\\/g, '/')}`;

      // Test basic fetch, custom selector, and formatting in one test
      const result = await fetchContent(fileUrl, {
        selector: 'article',
        timeout: 5000,
      });

      // Verify content extraction
      expect(result).toContain('Test Article Title');
      expect(result).toContain('main content');
      expect(result).toContain('multiple paragraphs');

      // Verify markdown formatting
      expect(result).toMatch(/^# /); // Starts with h1
      expect(result).toContain('\n\n'); // Has paragraph breaks
    }, 10000);
  });

  describe('Error handling', () => {
    it('should handle various error conditions', async () => {
      // Test invalid URL
      await expect(
        fetchContent('not-a-valid-url', { timeout: 5000 })
      ).rejects.toThrow();

      // Test non-existent file
      await expect(
        fetchContent('file:///this/file/does/not/exist.html', { timeout: 5000 })
      ).rejects.toThrow();

      // Test timeout with non-existent selector
      const fileUrl = `file:///${testHtmlPath.replace(/\\/g, '/')}`;
      await expect(
        fetchContent(fileUrl, {
          selector: '.does-not-exist',
          timeout: 100,
        })
      ).rejects.toThrow();
    }, 20000);
  });

  describe('Browser lifecycle', () => {
    it('should properly close browser on error and allow subsequent calls', async () => {
      const fileUrl = `file:///${testHtmlPath.replace(/\\/g, '/')}`;

      // First call fails with timeout
      try {
        await fetchContent(fileUrl, {
          selector: '.does-not-exist',
          timeout: 100,
        });
      } catch (_error) {
        // Expected to fail
      }

      // Browser should be closed properly, next call should work
      const result = await fetchContent(fileUrl, { timeout: 5000 });
      expect(result).toContain('Test Article Title');
    }, 10000);
  });
});
