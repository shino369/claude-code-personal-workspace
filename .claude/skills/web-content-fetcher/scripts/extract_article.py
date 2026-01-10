#!/usr/bin/env python3
"""
Article Content Extractor using BeautifulSoup and Readability

Usage:
    python extract_article.py <html_file>

Output:
    Clean article content in markdown format to stdout

Requirements:
    pip install beautifulsoup4 lxml readability-lxml
"""

import sys
from pathlib import Path

try:
    from bs4 import BeautifulSoup
    from readability import Document
except ImportError:
    print("Error: Required libraries not installed.", file=sys.stderr)
    print("Install with: pip install beautifulsoup4 lxml readability-lxml", file=sys.stderr)
    sys.exit(1)


def extract_article(html_file_path):
    """
    Extract main article content from HTML file.

    Args:
        html_file_path: Path to HTML file

    Returns:
        Cleaned article content in markdown format
    """
    # Read HTML file
    html_path = Path(html_file_path)
    if not html_path.exists():
        raise FileNotFoundError(f"File not found: {html_file_path}")

    with open(html_path, 'r', encoding='utf-8') as f:
        html_content = f.read()

    # Use readability to extract main content
    doc = Document(html_content)
    title = doc.title()
    summary_html = doc.summary()

    # Parse with BeautifulSoup for cleaning
    soup = BeautifulSoup(summary_html, 'lxml')

    # Remove script and style tags
    for tag in soup(['script', 'style', 'nav', 'footer', 'aside']):
        tag.decompose()

    # Extract text with structure preservation
    result = [f"# {title}\n"]

    for element in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote']):
        tag_name = element.name
        text = element.get_text(strip=True)

        if not text:
            continue

        if tag_name == 'h1':
            result.append(f"\n# {text}\n")
        elif tag_name == 'h2':
            result.append(f"\n## {text}\n")
        elif tag_name == 'h3':
            result.append(f"\n### {text}\n")
        elif tag_name == 'h4':
            result.append(f"\n#### {text}\n")
        elif tag_name == 'h5':
            result.append(f"\n##### {text}\n")
        elif tag_name == 'h6':
            result.append(f"\n###### {text}\n")
        elif tag_name == 'p':
            result.append(f"{text}\n")
        elif tag_name in ['ul', 'ol']:
            for li in element.find_all('li', recursive=False):
                li_text = li.get_text(strip=True)
                result.append(f"- {li_text}\n")
            result.append("\n")
        elif tag_name == 'blockquote':
            result.append(f"> {text}\n")

    return '\n'.join(result)


def main():
    if len(sys.argv) != 2:
        print("Usage: python extract_article.py <html_file>", file=sys.stderr)
        sys.exit(1)

    html_file = sys.argv[1]

    try:
        article_content = extract_article(html_file)
        print(article_content)
    except Exception as e:
        print(f"Error extracting article: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
