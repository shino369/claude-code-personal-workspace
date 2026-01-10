import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateUrl,
  validateOutputPath,
  validateTimeout,
  getSiteConfig,
  formatTwitterMarkdown,
  formatGenericMarkdown,
  extractTwitterContent,
  extractGenericContent,
  fetchContent,
  main,
} from '../fetch_js_content.js';

describe('fetch_js_content.js', () => {
  describe('validateUrl', () => {
    it('should accept valid http URLs', () => {
      expect(() => validateUrl('http://example.com')).not.toThrow();
      expect(() => validateUrl('http://example.com/path')).not.toThrow();
      expect(() => validateUrl('http://localhost:8080')).not.toThrow();
    });

    it('should accept valid https URLs', () => {
      expect(() => validateUrl('https://example.com')).not.toThrow();
      expect(() => validateUrl('https://x.com/user/status/123')).not.toThrow();
      expect(() =>
        validateUrl('https://example.com:443/path?query=value')
      ).not.toThrow();
    });

    it('should accept valid file:// URLs', () => {
      expect(() => validateUrl('file:///path/to/file.html')).not.toThrow();
      expect(() =>
        validateUrl('file://localhost/path/to/file.html')
      ).not.toThrow();
    });

    it('should reject invalid URL formats', () => {
      expect(() => validateUrl('not-a-url')).toThrow('Invalid URL format');
      expect(() => validateUrl('just text')).toThrow('Invalid URL format');
      expect(() => validateUrl('')).toThrow('Invalid URL format');
    });

    it('should reject unsafe protocols', () => {
      expect(() => validateUrl('javascript:alert(1)')).toThrow(
        'Invalid protocol: javascript:'
      );
      expect(() =>
        validateUrl('data:text/html,<script>alert(1)</script>')
      ).toThrow('Invalid protocol: data:');
      expect(() => validateUrl('ftp://example.com')).toThrow(
        'Invalid protocol: ftp:'
      );
    });

    it('should reject file:// URLs to sensitive system paths', () => {
      expect(() => validateUrl('file:///etc/passwd')).toThrow(
        'Access to sensitive system directories'
      );
      expect(() => validateUrl('file:///sys/kernel')).toThrow(
        'Access to sensitive system directories'
      );
      expect(() => validateUrl('file:///proc/cpuinfo')).toThrow(
        'Access to sensitive system directories'
      );
      expect(() => validateUrl('file:///C:/Windows/System32/config')).toThrow(
        'Access to sensitive system directories'
      );
    });

    it('should handle case-insensitive path checks for Windows', () => {
      expect(() => validateUrl('file:///C:/WINDOWS/SYSTEM32/file')).toThrow(
        'Access to sensitive system directories'
      );
    });

    it('should allow file:// URLs to non-sensitive paths', () => {
      expect(() =>
        validateUrl('file:///home/user/documents/file.html')
      ).not.toThrow();
      expect(() => validateUrl('file:///tmp/test.html')).not.toThrow();
    });
  });

  describe('validateOutputPath', () => {
    it('should accept paths within current directory', () => {
      const result = validateOutputPath('output.md');
      expect(result).toContain('output.md');
      expect(result.startsWith(process.cwd())).toBe(true);
    });

    it('should accept paths in subdirectories', () => {
      const result = validateOutputPath('subdir/output.md');
      expect(result).toContain('subdir');
      expect(result).toContain('output.md');
      expect(result.startsWith(process.cwd())).toBe(true);
    });

    it('should resolve relative paths', () => {
      const result = validateOutputPath('./test/output.md');
      expect(result.startsWith(process.cwd())).toBe(true);
    });

    it('should reject path traversal attempts', () => {
      expect(() => validateOutputPath('../../../etc/passwd')).toThrow(
        'Output path must be within current directory'
      );
      expect(() => validateOutputPath('../../outside/file.md')).toThrow(
        'Output path must be within current directory'
      );
    });

    it('should reject absolute paths outside current directory', () => {
      expect(() => validateOutputPath('/etc/passwd')).toThrow(
        'Output path must be within current directory'
      );
      expect(() =>
        validateOutputPath('C:\\Windows\\System32\\file.txt')
      ).toThrow('Output path must be within current directory');
    });

    it('should handle complex path traversal with valid segments', () => {
      const result = validateOutputPath('sub/../output.md');
      expect(result.startsWith(process.cwd())).toBe(true);
    });

    it('should reject paths that resolve outside current directory', () => {
      const outsidePath =
        process.cwd().split(/[/\\]/).slice(0, -2).join('/') + '/outside.md';
      expect(() => validateOutputPath(outsidePath)).toThrow(
        'Output path must be within current directory'
      );
    });
  });

  describe('validateTimeout', () => {
    it('should accept valid timeout values', () => {
      expect(validateTimeout(1000)).toBe(1000);
      expect(validateTimeout(30000)).toBe(30000);
      expect(validateTimeout(300000)).toBe(300000);
      expect(validateTimeout(150000)).toBe(150000);
    });

    it('should accept minimum timeout', () => {
      expect(validateTimeout(1000)).toBe(1000);
    });

    it('should accept maximum timeout', () => {
      expect(validateTimeout(300000)).toBe(300000);
    });

    it('should reject timeout below minimum', () => {
      expect(() => validateTimeout(500)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(999)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(0)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(-1000)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
    });

    it('should reject timeout above maximum', () => {
      expect(() => validateTimeout(300001)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(600000)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(999999999)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
    });

    it('should reject non-numeric timeouts', () => {
      expect(() => validateTimeout(NaN)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(Infinity)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
      expect(() => validateTimeout(-Infinity)).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
    });

    it('should handle string inputs that convert to valid numbers', () => {
      // Note: This tests the behavior when parseInt is used before calling validateTimeout
      expect(validateTimeout(parseInt('30000', 10))).toBe(30000);
    });

    it('should reject string inputs that convert to NaN', () => {
      expect(() => validateTimeout(parseInt('invalid', 10))).toThrow(
        'Timeout must be between 1000 and 300000 milliseconds'
      );
    });
  });

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
      const config = getSiteConfig(
        'https://x.com/user/status/123',
        '.custom-selector'
      );

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
        media: [],
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
        media: [],
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
        media: [
          { url: 'https://example.com/img1.jpg', alt: 'Image 1 description' },
          { url: 'https://example.com/img2.jpg', alt: 'Image 2 description' },
        ],
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).toContain('### Media');
      expect(markdown).toContain('1. Image 1 description');
      expect(markdown).toContain('URL: https://example.com/img1.jpg');
      expect(markdown).toContain('2. Image 2 description');
      expect(markdown).toContain('URL: https://example.com/img2.jpg');
    });

    it('should handle tweet with both quoted tweet and media', () => {
      const tweetData = {
        userName: 'User',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'Complex tweet',
        quotedTweet: 'Quoted',
        media: [{ url: 'https://example.com/img.jpg', alt: 'Media' }],
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).toContain('### Quoted Tweet');
      expect(markdown).toContain('### Media');
    });

    it('should handle empty media array', () => {
      const tweetData = {
        userName: 'User',
        timestamp: '2026-01-11T12:00:00.000Z',
        tweetText: 'Tweet',
        quotedTweet: null,
        media: [],
      };

      const markdown = formatTwitterMarkdown(tweetData);

      expect(markdown).not.toContain('### Media');
    });
  });

  describe('formatGenericMarkdown', () => {
    it('should format basic content', () => {
      const content = {
        title: 'Test Article',
        content: 'This is the article content.\nMultiple lines here.',
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Test Article');
      expect(markdown).toContain('This is the article content.');
      expect(markdown).toContain('Multiple lines here.');
    });

    it('should handle content with special characters', () => {
      const content = {
        title: 'Article with "quotes" & symbols',
        content: 'Content with <html> & special chars',
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Article with "quotes" & symbols');
      expect(markdown).toContain('Content with <html> & special chars');
    });

    it('should handle empty content', () => {
      const content = {
        title: 'Empty',
        content: '',
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Empty');
      expect(markdown).toMatch(/# Empty\n\n\n$/);
    });

    it('should format content with media', () => {
      const content = {
        title: 'Article with Images',
        content: 'This article has images.',
        media: [
          { url: 'https://example.com/img1.jpg', alt: 'First image' },
          { url: 'https://example.com/img2.jpg', alt: 'Second image' },
        ],
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Article with Images');
      expect(markdown).toContain('This article has images.');
      expect(markdown).toContain('### Media');
      expect(markdown).toContain('1. First image');
      expect(markdown).toContain('URL: https://example.com/img1.jpg');
      expect(markdown).toContain('2. Second image');
      expect(markdown).toContain('URL: https://example.com/img2.jpg');
    });

    it('should handle content with empty media array', () => {
      const content = {
        title: 'No Images',
        content: 'Content without images',
        media: [],
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# No Images');
      expect(markdown).toContain('Content without images');
      expect(markdown).not.toContain('### Media');
    });

    it('should handle content without media field', () => {
      const content = {
        title: 'Legacy Content',
        content: 'Old format without media field',
      };

      const markdown = formatGenericMarkdown(content);

      expect(markdown).toContain('# Legacy Content');
      expect(markdown).toContain('Old format without media field');
      expect(markdown).not.toContain('### Media');
    });
  });

  describe('extractTwitterContent', () => {
    let mockPage;

    beforeEach(() => {
      mockPage = {
        evaluate: vi.fn(),
      };
    });

    it('should extract complete tweet data', async () => {
      mockPage.evaluate.mockResolvedValue({
        userName: 'Test User\n@testuser',
        tweetText: 'Tweet content',
        timestamp: '2026-01-11T12:00:00.000Z',
        quotedTweet: null,
        media: [],
      });

      const result = await extractTwitterContent(mockPage);

      expect(mockPage.evaluate).toHaveBeenCalledOnce();
      expect(result).toContain('# Twitter/X Post');
      expect(result).toContain('Test User');
      expect(result).toContain('Tweet content');
    });

    it('should handle extraction errors', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      await expect(extractTwitterContent(mockPage)).rejects.toThrow(
        'Failed to extract Twitter content: Evaluation failed'
      );
    });

    it('should extract tweet with all fields', async () => {
      mockPage.evaluate.mockResolvedValue({
        userName: 'User',
        tweetText: 'Main',
        timestamp: '2026-01-11T12:00:00.000Z',
        quotedTweet: 'Quoted',
        media: [
          { url: 'https://example.com/img1.jpg', alt: 'Media 1' },
          { url: 'https://example.com/img2.jpg', alt: 'Media 2' },
        ],
      });

      const result = await extractTwitterContent(mockPage);

      expect(result).toContain('### Quoted Tweet');
      expect(result).toContain('### Media');
      expect(result).toContain('1. Media 1');
      expect(result).toContain('URL: https://example.com/img1.jpg');
      expect(result).toContain('2. Media 2');
      expect(result).toContain('URL: https://example.com/img2.jpg');
    });
  });

  describe('extractGenericContent', () => {
    let mockPage;

    beforeEach(() => {
      mockPage = {
        evaluate: vi.fn(),
      };
    });

    it('should extract generic page content', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: 'Page Title',
        content: 'Page content here',
      });

      const result = await extractGenericContent(mockPage);

      expect(mockPage.evaluate).toHaveBeenCalledOnce();
      expect(result).toContain('# Page Title');
      expect(result).toContain('Page content here');
    });

    it('should handle extraction errors', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      await expect(extractGenericContent(mockPage)).rejects.toThrow(
        'Failed to extract generic content: Evaluation failed'
      );
    });

    it('should handle minimal content', async () => {
      mockPage.evaluate.mockResolvedValue({
        title: 'Untitled',
        content: 'No content found',
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
          media: [],
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
          media: [],
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Quoted Tweet');
      });

      it('should handle undefined media', () => {
        const tweetData = {
          userName: 'User',
          timestamp: '2026-01-11T12:00:00.000Z',
          tweetText: 'Tweet',
          quotedTweet: null,
          media: undefined,
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Media');
      });

      it('should handle null media', () => {
        const tweetData = {
          userName: 'User',
          timestamp: '2026-01-11T12:00:00.000Z',
          tweetText: 'Tweet',
          quotedTweet: null,
          media: null,
        };

        const markdown = formatTwitterMarkdown(tweetData);

        expect(markdown).not.toContain('### Media');
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
          content: 'Content',
        };

        const markdown = formatGenericMarkdown(content);

        expect(markdown).toContain(`# ${longTitle}`);
      });

      it('should handle newlines in title', () => {
        const content = {
          title: 'Title\nWith\nNewlines',
          content: 'Content',
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage:')
      );
    });

    it('should be exported as a function', () => {
      expect(typeof main).toBe('function');
    });
  });
});
