/**
 * Tests for extract_eucjp.js - Integration tests using real JSDOM
 */
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { JSDOM } from 'jsdom';
import {
  extractArticle,
  htmlToMarkdown,
  main,
  extractWithFallback,
} from '../extract_eucjp.js';

describe('extract_eucjp', () => {
  const testDir = 'test_eucjp_files';

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('extractWithFallback', () => {
    test('should extract from #main selector', () => {
      const html =
        '<html><head><title>Main Test</title></head><body><div id="main"><p>Main content</p></div></body></html>';
      const dom = new JSDOM(html);

      const result = extractWithFallback(dom);

      expect(result).toContain('# Main Test');
      expect(result).toContain('Main content');
    });

    test('should extract from article selector', () => {
      const html =
        '<html><head><title>Article Test</title></head><body><article><p>Article content</p></article></body></html>';
      const dom = new JSDOM(html);

      const result = extractWithFallback(dom);

      expect(result).toContain('# Article Test');
      expect(result).toContain('Article content');
    });

    test('should extract from articleBody class selector', () => {
      const html =
        '<html><head><title>ArticleBody Test</title></head><body><div class="articleBody"><p>Body content</p></div></body></html>';
      const dom = new JSDOM(html);

      const result = extractWithFallback(dom);

      expect(result).toContain('# ArticleBody Test');
      expect(result).toContain('Body content');
    });

    test('should throw error when no fallback selectors found', () => {
      const html =
        '<html><head><title>No Content</title></head><body><div>No selectors</div></body></html>';
      const dom = new JSDOM(html);

      expect(() => extractWithFallback(dom)).toThrow(
        'Failed to extract article content'
      );
    });
  });

  describe('extractArticle', () => {
    test('should throw error for missing file', () => {
      const nonExistentFile = path.join(testDir, 'nonexistent.html');

      expect(() => extractArticle(nonExistentFile)).toThrow(
        `File not found: ${nonExistentFile}`
      );
    });

    test('should throw error when no fallback selectors found', () => {
      const htmlFile = path.join(testDir, 'no_fallback.html');
      const htmlContent =
        '<html><head><title>No Content</title></head><body></body></html>';

      const buffer = iconv.encode(htmlContent, 'eucjp');
      fs.writeFileSync(htmlFile, buffer);

      expect(() => extractArticle(htmlFile)).toThrow(
        'Failed to extract article content'
      );
    });

    test('should extract article from EUC-JP encoded HTML file', () => {
      const htmlFile = path.join(testDir, 'article_eucjp.html');
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head><title>テスト記事</title></head>
          <body>
            <article>
              <h1>テスト記事</h1>
              <p>これは記事の内容です。十分な長さのコンテンツが必要です。</p>
              <p>これは別の段落です。Readabilityが動作するために必要です。</p>
              <p>さらに追加の段落を含めます。</p>
            </article>
          </body>
        </html>
      `;

      const buffer = iconv.encode(htmlContent, 'eucjp');
      fs.writeFileSync(htmlFile, buffer);

      const result = extractArticle(htmlFile);

      expect(result).toContain('テスト記事');
      expect(result).toContain('記事の内容');
    });
  });

  describe('htmlToMarkdown', () => {
    test('should convert h1 to markdown', () => {
      const html = '<h1>見出し1</h1>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('# 見出し1');
    });

    test('should convert h2 to markdown', () => {
      const html = '<h2>見出し2</h2>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('## 見出し2');
    });

    test('should convert h3 to markdown', () => {
      const html = '<h3>見出し3</h3>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('### 見出し3');
    });

    test('should convert h4 to markdown', () => {
      const html = '<h4>見出し4</h4>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('#### 見出し4');
    });

    test('should convert paragraphs to markdown', () => {
      const html = '<p>段落テキスト</p>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('段落テキスト');
    });

    test('should convert br tags', () => {
      const html = '<p>行1<br>行2</p>';
      const result = htmlToMarkdown(html);
      expect(result).toBeTruthy();
    });

    test('should convert links with href', () => {
      const html = '<a href="https://example.jp">リンク</a>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('[リンク](https://example.jp)');
    });

    test('should handle links without href', () => {
      const html = '<a>テキストのみ</a>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('テキストのみ');
    });

    test('should convert strong to markdown', () => {
      const html = '<strong>太字</strong>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('**太字**');
    });

    test('should convert b to markdown', () => {
      const html = '<b>太字</b>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('**太字**');
    });

    test('should convert em to markdown', () => {
      const html = '<em>イタリック</em>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('*イタリック*');
    });

    test('should convert i to markdown', () => {
      const html = '<i>イタリック</i>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('*イタリック*');
    });

    test('should handle nested elements', () => {
      const html = '<div><span>ネストされたテキスト</span></div>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('ネストされたテキスト');
    });

    test('should handle empty text nodes', () => {
      const html = '<p>  </p>';
      const result = htmlToMarkdown(html);
      expect(result).toBe('');
    });

    test('should handle non-element non-text nodes', () => {
      const html = '<!-- comment --><p>テキスト</p>';
      const result = htmlToMarkdown(html);
      expect(result).toContain('テキスト');
    });

    test('should clean up multiple spaces', () => {
      const html = '<p>テキスト   が    あります</p>';
      const result = htmlToMarkdown(html);
      expect(result).not.toMatch(/  +/);
    });

    test('should clean up multiple newlines', () => {
      const html = '<p>行1</p><p>行2</p><p>行3</p>';
      const result = htmlToMarkdown(html);
      expect(result).not.toMatch(/\n{4,}/);
    });

    test('should trim result', () => {
      const html = '<p>コンテンツ</p>';
      const result = htmlToMarkdown(html);
      expect(result).toBe(result.trim());
    });
  });

  describe('main', () => {
    let originalArgv;
    let originalExit;

    beforeEach(() => {
      originalArgv = process.argv;
      originalExit = process.exit;
    });

    afterEach(() => {
      process.argv = originalArgv;
      process.exit = originalExit;
    });

    test('should exit with error when no arguments provided', () => {
      process.argv = ['node', 'extract_eucjp.js'];
      let exitCode;
      process.exit = vi.fn((code) => {
        exitCode = code;
      });
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      main();

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage')
      );
      consoleErrorSpy.mockRestore();
    });

    test('should handle file not found error', () => {
      process.argv = ['node', 'extract_eucjp.js', 'nonexistent.html'];
      let exitCode;
      process.exit = vi.fn((code) => {
        exitCode = code;
      });
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      main();

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error extracting')
      );
      consoleErrorSpy.mockRestore();
    });

    test('should output article when successful', () => {
      const htmlFile = path.join(testDir, 'cli_test.html');
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head><title>CLI Test</title></head>
          <body>
            <article>
              <h1>CLI Test</h1>
              <p>これは十分なコンテンツです。</p>
              <p>複数の段落がReadabilityの動作を助けます。</p>
              <p>3番目の段落も追加します。</p>
            </article>
          </body>
        </html>
      `;
      const buffer = iconv.encode(htmlContent, 'eucjp');
      fs.writeFileSync(htmlFile, buffer);
      process.argv = ['node', 'extract_eucjp.js', htmlFile];
      const consoleLogSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});

      main();

      expect(consoleLogSpy).toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('CLI Test');
      consoleLogSpy.mockRestore();
    });
  });
});
