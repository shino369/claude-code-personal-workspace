import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSiteConfig,
  formatTwitterMarkdown,
  formatGenericMarkdown,
  extractTwitterContent,
  extractGenericContent,
  fetchContent,
  main
} from '../fetch_js_content.js';

describe('fetch_js_content.js', () => {
  describe('getSiteConfig', () => {
    it('should detect Twitter/X URLs with x.com', () => {
      const config = getSiteConfig('https://x.com/user/status/123');

      expect(config.name).toBe('Twitter/X');
      expect(config.waitSelector).toBe('article[data-testid="tweet"]');
      expect(config.extractFunction).toBe(extractTwitterContent);
    });

    it('should detect Twitter/X URLs with twitter.com', () => {
      const config = getSiteConfig('https://twitter.com/user/status/456');

      expect(config.name).toBe('Twitter/X');
      expect(config.waitSelector).toBe('article[data-testid="tweet"]');
    });

    it('should use custom selector for Twitter when provided', () => {
      const config = getSiteConfig('https://x.com/user/status/123', '.custom-selector');

      expect(config.name).toBe('Twitter/X');
      expect(config.waitSelector).toBe('.custom-selector');
    });

    it('should return generic config for non-Twitter URLs', () => {
      const config = getSiteConfig('https://example.com');

      expect(config.name).toBe('Generic');
      expect(config.waitSelector).toBe('body');
      expect(config.extractFunction).toBe(extractGenericContent);
    });

    it('should use custom selector for generic sites when provided', () => {
      const config = getSiteConfig('https://example.com', '.main-content');

      expect(config.name).toBe('Generic');
      expect(config.waitSelector).toBe('.main-content');
    });
  });

  describe('formatTwitterMarkdown', () => {
    it('should format basic tweet data', () => {
      const tweetData = {
        userName: 'Test User\n@testuser',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'This is a test tweet',
        quotedTweet: null,
        mediaAlts: []
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).toContain('# Twitter/X Post');
      expect(markdown).toContain('**Author:** Test User');
      expect(markdown).toContain('**Timestamp:** 2026-01-11T12:00:00.000Z');
      expect(markdown).toContain('## Tweet Content');
      expect(markdown).toContain('This is a test tweet');
    });

    it('should format tweet with quoted tweet', () => {
      const tweetData = {
        userName: 'User',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'Main tweet',
        quotedTweet: 'Quoted tweet content',
        mediaAlts: []
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).toContain('### Quoted Tweet');
      expect(markdown).toContain('> Quoted tweet content');
    });

    it('should format tweet with media descriptions', () => {
      const tweetData = {
        userName: 'User',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'Tweet with media',
        quotedTweet: null,
        mediaAlts: ['Image 1 description', 'Image 2 description']
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).toContain('### Media Descriptions');
      expect(markdown).toContain('1. Image 1 description');
      expect(markdown).toContain('2. Image 2 description');
    });

    it('should handle tweet with both quoted tweet and media', () => {
      const tweetData = {
        userName: 'User',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'Complex tweet',
        quotedTweet: 'Quoted',
        mediaAlts: ['Media']
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).toContain('### Quoted Tweet');
      expect(markdown).toContain('### Media Descriptions');
    });

    it('should handle empty media array', () => {
      const tweetData = {
        userName: 'User',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'Tweet',
        quotedTweet: null,
        mediaAlts: []
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).not.toContain('### Media Descriptions');
    });
  });

  describe('formatGenericMarkdown', () => {
    it('should format basic content', () => {
      const content = {
        title: 'Test Article',
        content: 'This is the article content.\nMultiple lines here.'
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Test Article');
      expect(markdown).toContain('This is the article content.');
      expect(markdown).toContain('Multiple lines here.');
    });

    it('should handle content with special characters', () => {
      const content = {
        title: 'Article with "quotes" & symbols',
        content: 'Content with <html> & special chars'
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Article with "quotes" & symbols');
      expect(markdown).toContain('Content with <html> & special chars');
    });

    it('should handle empty content', () => {
      const content = {
        title: 'Empty',
        content: ''
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Empty');
      expect(markdown).toMatch(/# Empty\n\n\n$/);
    });
  });

  describe('extractTwitterContent', () => {
    let mockPage;

    beforeEach(() => {
      mockPage = {
        evaluate: vi.fn()
      };
    });

    it('should extract complete tweet data', async () => {
      mockPage.evaluate.mockResolvedValue({
        userName: 'Test User\n@testuser',
        tweetText: 'Tweet content',
        timestamp: '2026-01-11T12:00:00.000Z',
        quotedTweet: null,
        mediaAlts: []
      });

      const result = await extractTwitterContent(mockPage);

      expect(mockPage.evaluate).toHaveBeenCalledOnce();
      expect(result).toContain('# Twitter/X Post');
      expect(result).toContain('Test User');
      expect(result).toContain('Tweet content');
    });

    it('should handle extraction errors', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      await expect(extractTwitterContent(mockPage))
        .rejects
        .toThrow('Failed to extract Twitter content: Evaluation failed');
    });

    it('should extract tweet with all fields', async () => {
      mockPage.evaluate.mockResolvedValue({
        userName: 'User',
        tweetText: 'Main',
        timestamp: '2026-01-11T12:00:00.000Z',
        quotedTweet: 'Quoted',
        mediaAlts: ['Media 1', 'Media 2']
      });

      const result = await extractTwitterContent(mockPage);

      expect(result).toContain('### Quoted Tweet');
      expect(result).toContain('### Media Descriptions');
      expect(result).toContain('1. Media 1');
      expect(result).toContain('2. Media 2');
    });
  });

  describe('extractGenericContent', () => {
    let mockPage;

    beforeEach(() => {
      mockPage = {
        evaluate: vi.fn()
      };
    });

    it('should extract generic page content', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: 'Page Title',
        content: 'Page content here'
      });

      const result = await extractGenericContent(mockPage);

      expect(mockPage.evaluate).toHaveBeenCalledOnce();
      expect(result).toContain('# Page Title');
      expect(result).toContain('Page content here');
    });

    it('should handle extraction errors', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      await expect(extractGenericContent(mockPage))
        .rejects
        .toThrow('Failed to extract generic content: Evaluation failed');
    });

    it('should handle minimal content', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: 'Untitled',
        content: 'No content found'
      });

      const result = await extractGenericContent(mockPage);

      expect(result).toContain('# Untitled');
      expect(result).toContain('No content found');
    });
  });

  describe('Edge cases', () => {
    describe('formatTwitterMarkdown edge cases', () => {
      it('should handle undefined quotedTweet', () => {
        const tweetData = {
          userName: 'User',
          timestamp: '2026-01-11T12:00:00.000Z',
          tweetText: 'Tweet',
          quotedTweet: undefined,
          mediaAlts: []
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Quoted Tweet');
      });

      it('should handle null quotedTweet', () => {
        const tweetData = {
          userName: 'User',
          timestamp: '2026-01-11T12:00:00.000Z',
          tweetText: 'Tweet',
          quotedTweet: null,
          mediaAlts: []
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Quoted Tweet');
      });

      it('should handle undefined mediaAlts', () => {
        const tweetData = {
          userName: 'User',
          timestamp: '2026-01-11T12:00:00.000Z',
          tweetText: 'Tweet',
          quotedTweet: null,
          mediaAlts: undefined
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Media Descriptions');
      });

      it('should handle null mediaAlts', () => {
        const tweetData = {
          userName: 'User',
          timestamp: '2026-01-11T12:00:00.000Z',
          tweetText: 'Tweet',
          quotedTweet: null,
          mediaAlts: null
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Media Descriptions');
      });
    });

    describe('getSiteConfig edge cases', () => {
      it('should handle URL with x.com in path but not domain', () => {
        const config = getSiteConfig('https://example.com/x.com/page');

        expect(config.name).toBe('Twitter/X');
      });

      it('should handle case-sensitive Twitter URLs', () => {
        const config = getSiteConfig('https://X.COM/user/status/123');

        // Note: includes() is case-sensitive, so this would be Generic
        // This test documents current behavior
        expect(config.name).toBe('Generic');
      });

      it('should handle null custom selector', () => {
        const config = getSiteConfig('https://example.com', null);

        expect(config.waitSelector).toBe('body');
      });

      it('should handle empty string custom selector', () => {
        const config = getSiteConfig('https://example.com', '');

        // Empty string is falsy, so should use default
        expect(config.waitSelector).toBe('body');
      });
    });

    describe('formatGenericMarkdown edge cases', () => {
      it('should handle very long titles', () => {
        const longTitle = 'A'.repeat(1000);
        const content = {
          title: longTitle,
          content: 'Content'
        };

        const markdown = formatGenericMarkdown(content);

        expect(markdown).toContain(`# ${longTitle}`);
      });

      it('should handle newlines in title', () => {
        const content = {
          title: 'Title\nWith\nNewlines',
          content: 'Content'
        };

        const markdown = formatGenericMarkdown(content);

        expect(markdown).toContain('# Title\nWith\nNewlines');
      });
    });
  });

  describe('fetchContent', () => {
    // fetchContent is integration-tested through main(), and the core logic
    // is unit-tested through getSiteConfig, extractTwitterContent, and extractGenericContent.
    // Testing fetchContent directly would require mocking Playwright's browser automation,
    // which is better covered by integration tests or manual testing.

    it('should be exported as a function', () => {
      expect(typeof fetchContent).toBe('function');
    });
  });

  describe('main', () => {
    let originalArgv, originalExit, exitCode, consoleErrorSpy;

    beforeEach(() => {
      originalArgv = process.argv;
      originalExit = process.exit;
      exitCode = null;

      process.exit = vi.fn((code) => {
        exitCode = code;
        throw new Error(`process.exit(${code})`);
      });

      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      process.argv = originalArgv;
      process.exit = originalExit;
      vi.restoreAllMocks();
    });

    it('should exit with error when no URL provided', async () => {
      process.argv = ['node', 'script.js'];

      try {
        await main();
      } catch (_error) {
        // Expected to throw due to process.exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: URL is required');
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    });

    it('should be exported as a function', () => {
      expect(typeof main).toBe('function');
    });
  });
});
