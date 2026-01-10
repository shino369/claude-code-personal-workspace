#!/usr/bin/env node
/**
 * Extract article from EUC-JP encoded HTML (common for Japanese sites like 4gamer)
 *
 * Usage:
 *   node extract_eucjp.js <html_file>
 *
 * Output:
 *   Clean article content in markdown format to stdout
 *
 * Requirements:
 *   npm install @mozilla/readability jsdom iconv-lite
 */

const fs = require('fs');
const iconv = require('iconv-lite');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');

/**
 * Convert HTML to markdown-like text format
 */
function htmlToMarkdown(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const result = [];

  function processNode(node) {
    if (node.nodeType === 3) {
      // Text node
      const text = node.textContent.trim();
      if (text) {
        result.push(text);
      }
      return;
    }

    if (node.nodeType !== 1) {
      return;
    } // Not an element

    const tagName = node.tagName.toLowerCase();

    switch (tagName) {
      case 'h1':
        result.push(`\n# ${node.textContent.trim()}\n`);
        break;
      case 'h2':
        result.push(`\n## ${node.textContent.trim()}\n`);
        break;
      case 'h3':
        result.push(`\n### ${node.textContent.trim()}\n`);
        break;
      case 'h4':
        result.push(`\n#### ${node.textContent.trim()}\n`);
        break;
      case 'p':
        result.push(`\n${node.textContent.trim()}\n`);
        break;
      case 'br':
        result.push('\n');
        break;
      case 'a':
        const href = node.getAttribute('href');
        const text = node.textContent.trim();
        if (href && text) {
          result.push(`[${text}](${href})`);
        } else {
          result.push(text);
        }
        break;
      case 'strong':
      case 'b':
        result.push(`**${node.textContent.trim()}**`);
        break;
      case 'em':
      case 'i':
        result.push(`*${node.textContent.trim()}*`);
        break;
      default:
        Array.from(node.childNodes).forEach((child) => processNode(child));
    }
  }

  processNode(doc.body);
  return result
    .join(' ')
    .replace(/ +/g, ' ')
    .replace(/\n\n\n+/g, '\n\n')
    .trim();
}

/**
 * Extract article from EUC-JP encoded HTML file
 */
function extractArticle(htmlFilePath) {
  if (!fs.existsSync(htmlFilePath)) {
    throw new Error(`File not found: ${htmlFilePath}`);
  }

  // Read file as buffer and decode from EUC-JP
  const htmlBuffer = fs.readFileSync(htmlFilePath);
  const htmlContent = iconv.decode(htmlBuffer, 'eucjp');

  // Parse with JSDOM
  const dom = new JSDOM(htmlContent);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    // Fallback: try to extract from main content area
    const doc = dom.window.document;
    const mainContent =
      doc.querySelector('article') ||
      doc.querySelector('.articleBody') ||
      doc.querySelector('#main');

    if (mainContent) {
      return `# ${doc.title}\n\n${htmlToMarkdown(mainContent.innerHTML)}`;
    } else {
      throw new Error('Failed to extract article content');
    }
  }

  const markdown = htmlToMarkdown(article.content);
  return `# ${article.title}\n\n${markdown}`;
}

// Main execution
function main() {
  if (process.argv.length !== 3) {
    console.error('Usage: node extract_eucjp.js <html_file>');
    process.exit(1);
  }

  const htmlFile = process.argv[2];

  try {
    const articleContent = extractArticle(htmlFile);
    console.log(articleContent);
  } catch (error) {
    console.error(`Error extracting article: ${error.message}`);
    process.exit(1);
  }
}

main();
