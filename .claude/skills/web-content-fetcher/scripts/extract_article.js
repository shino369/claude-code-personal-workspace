#!/usr/bin/env node
/**
 * Article Content Extractor using Mozilla Readability
 *
 * Usage:
 *   node extract_article.js <html_file>
 *
 * Output:
 *   Clean article content in markdown format to stdout
 *
 * Requirements:
 *   npm install @mozilla/readability jsdom
 */

const fs = require('fs');

let Readability, JSDOM;

try {
  ({ Readability } = require('@mozilla/readability'));
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  console.error('Error: Required libraries not installed.');
  console.error(`Details: ${error.message}`);
  console.error('Install with: npm install @mozilla/readability jsdom');
  process.exit(1);
}

/**
 * Convert HTML to markdown-like text format
 */
function htmlToMarkdown(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const result = [];

  function processNode(node, depth = 0) {
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
      case 'h5':
        result.push(`\n##### ${node.textContent.trim()}\n`);
        break;
      case 'h6':
        result.push(`\n###### ${node.textContent.trim()}\n`);
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
      case 'code':
        result.push(`\`${node.textContent.trim()}\``);
        break;
      case 'blockquote':
        result.push(`\n> ${node.textContent.trim()}\n`);
        break;
      case 'ul':
      case 'ol':
        result.push('\n');
        Array.from(node.children).forEach((li) => {
          if (li.tagName.toLowerCase() === 'li') {
            result.push(`- ${li.textContent.trim()}\n`);
          }
        });
        result.push('\n');
        break;
      default:
        // Process children
        Array.from(node.childNodes).forEach((child) =>
          processNode(child, depth + 1)
        );
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
 * Extract article from HTML file
 */
function extractArticle(htmlFilePath) {
  // Read HTML file
  if (!fs.existsSync(htmlFilePath)) {
    throw new Error(`File not found: ${htmlFilePath}`);
  }

  const htmlContent = fs.readFileSync(htmlFilePath, 'utf-8');

  // Parse with JSDOM
  const dom = new JSDOM(htmlContent);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error('Failed to extract article content');
  }

  // Convert to markdown format
  const markdown = htmlToMarkdown(article.content);

  return `# ${article.title}\n\n${markdown}`;
}

// Main execution
function main() {
  if (process.argv.length !== 3) {
    console.error('Usage: node extract_article.js <html_file>');
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
