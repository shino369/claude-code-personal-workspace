/**
 * Tests for extract_article.js - Integration tests using real JSDOM
 */
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractArticle, htmlToMarkdown, main } from '../extract_article.js';

describe('extract_article', () => {
  const testDir = 'test_html_files';

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

  describe('extractArticle', () => {
    test('should throw error for missing file', () => {
      const nonExistentFile = path.join(testDir, 'nonexistent.html');
      expect(() => extractArticle(nonExistentFile)).toThrow(
        `File not found: ${nonExistentFile}`
      );
    });

    test('should throw error for HTML without readable content', () => {
      const htmlFile = path.join(testDir, 'empty.html');
      fs.writeFileSync(htmlFile, '<html><body></body></html>', 'utf-8');
      expect(() => extractArticle(htmlFile)).toThrow(
        'Failed to extract article content'
      );
    });

    test('should extract article from valid HTML file', () => {
      const htmlFile = path.join(testDir, 'article.html');
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head><title>Test Article</title></head>
          <body>
            <article>
              <h1>Test Article</h1>
              <p>This is the first paragraph with enough content.</p>
              <p>This is the second paragraph with more content.</p>
              <p>This is the third paragraph to ensure readability works.</p>
            </article>
          </body>
        </html>
      `;
      fs.writeFileSync(htmlFile, htmlContent, 'utf-8');
      const result = extractArticle(htmlFile);
      expect(result).toContain('Test Article');
      expect(result).toContain('first paragraph');
    });
  });

  describe('htmlToMarkdown', () => {
    test('should convert h1 to markdown', () => {
      expect(htmlToMarkdown('<h1>Heading 1</h1>')).toContain('# Heading 1');
    });

    test('should convert h2 to markdown', () => {
      expect(htmlToMarkdown('<h2>Heading 2</h2>')).toContain('## Heading 2');
    });

    test('should convert h3 to markdown', () => {
      expect(htmlToMarkdown('<h3>Heading 3</h3>')).toContain('### Heading 3');
    });

    test('should convert h4 to markdown', () => {
      expect(htmlToMarkdown('<h4>Heading 4</h4>')).toContain('#### Heading 4');
    });

    test('should convert h5 to markdown', () => {
      expect(htmlToMarkdown('<h5>Heading 5</h5>')).toContain('##### Heading 5');
    });

    test('should convert h6 to markdown', () => {
      expect(htmlToMarkdown('<h6>Heading 6</h6>')).toContain(
        '###### Heading 6'
      );
    });

    test('should convert paragraphs to markdown', () => {
      expect(htmlToMarkdown('<p>Paragraph text</p>')).toContain(
        'Paragraph text'
      );
    });

    test('should convert br tags to newlines', () => {
      const result = htmlToMarkdown('<div>Line 1<br/>Line 2<br>Line 3</div>');
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
      expect(result).toContain('Line 3');
    });

    test('should convert links with href to markdown', () => {
      expect(
        htmlToMarkdown('<a href="https://example.com">Link Text</a>')
      ).toContain('[Link Text](https://example.com)');
    });

    test('should handle links without href', () => {
      expect(htmlToMarkdown('<a>Text only</a>')).toContain('Text only');
    });

    test('should handle links with empty text', () => {
      expect(htmlToMarkdown('<a href="https://example.com"></a>')).toBe('');
    });

    test('should handle links with whitespace-only text', () => {
      expect(htmlToMarkdown('<a href="https://example.com">  </a>')).toBe('');
    });

    test('should convert strong to markdown', () => {
      expect(htmlToMarkdown('<strong>Bold</strong>')).toContain('**Bold**');
    });

    test('should convert b to markdown', () => {
      expect(htmlToMarkdown('<b>Bold</b>')).toContain('**Bold**');
    });

    test('should convert em to markdown', () => {
      expect(htmlToMarkdown('<em>Italic</em>')).toContain('*Italic*');
    });

    test('should convert i to markdown', () => {
      expect(htmlToMarkdown('<i>Italic</i>')).toContain('*Italic*');
    });

    test('should convert code to markdown', () => {
      expect(htmlToMarkdown('<code>const x = 1;</code>')).toContain(
        '`const x = 1;`'
      );
    });

    test('should convert blockquote to markdown', () => {
      expect(htmlToMarkdown('<blockquote>Quoted text</blockquote>')).toContain(
        '> Quoted text'
      );
    });

    test('should convert ul lists to markdown', () => {
      const result = htmlToMarkdown('<ul><li>Item 1</li><li>Item 2</li></ul>');
      expect(result).toContain('- Item 1');
      expect(result).toContain('- Item 2');
    });

    test('should convert ol lists to markdown', () => {
      const result = htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>');
      expect(result).toContain('- First');
      expect(result).toContain('- Second');
    });

    test('should handle ul with non-li children', () => {
      const result = htmlToMarkdown(
        '<ul><li>Item</li><div>Not an li</div></ul>'
      );
      expect(result).toContain('- Item');
    });

    test('should handle nested elements via default case', () => {
      expect(htmlToMarkdown('<div><span>Nested text</span></div>')).toContain(
        'Nested text'
      );
    });

    test('should handle empty text nodes', () => {
      expect(htmlToMarkdown('<p>  </p>')).toBe('');
    });

    test('should handle non-element non-text nodes', () => {
      // Test with processing instruction, CDATA, and comments
      expect(
        htmlToMarkdown('<div>Text<?xml?><![CDATA[data]]><!-- comment --></div>')
      ).toContain('Text');
    });

    test('should clean up multiple spaces', () => {
      expect(
        htmlToMarkdown('<p>Text   with    many    spaces</p>')
      ).not.toMatch(/  +/);
    });

    test('should clean up multiple newlines', () => {
      expect(
        htmlToMarkdown('<p>Line 1</p><p>Line 2</p><p>Line 3</p>')
      ).not.toMatch(/\n{4,}/);
    });

    test('should trim result', () => {
      const result = htmlToMarkdown('<p>Content</p>');
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
      process.argv = ['node', 'extract_article.js'];
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
      process.argv = ['node', 'extract_article.js', 'nonexistent.html'];
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
              <p>This is enough content for extraction to work.</p>
              <p>Multiple paragraphs help Readability parse correctly.</p>
              <p>Third paragraph for good measure.</p>
            </article>
          </body>
        </html>
      `;
      fs.writeFileSync(htmlFile, htmlContent, 'utf-8');
      process.argv = ['node', 'extract_article.js', htmlFile];
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
