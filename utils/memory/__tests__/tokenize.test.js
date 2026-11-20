/**
 * Tests for utils/memory/tokenize.js
 */
import { jaccard, termSet, tokenize } from '../tokenize.js';

describe('tokenize', () => {
  test('should lowercase and split English words', () => {
    expect(tokenize('Proxy BLOCKS GraphQL')).toEqual([
      'proxy',
      'blocks',
      'graphql',
    ]);
  });

  test('should drop English stopwords and punctuation', () => {
    expect(tokenize('The proxy blocks it, and the API is down.')).toEqual([
      'proxy',
      'blocks',
      'api',
      'down',
    ]);
  });

  test('should keep short code tokens and numbers', () => {
    expect(tokenize('gh pr create fails with 403')).toEqual([
      'gh',
      'pr',
      'create',
      'fails',
      '403',
    ]);
  });

  test('should keep a compound token and add its parts', () => {
    expect(tokenize('GITHUB_TOKEN file.js')).toEqual([
      'github_token',
      'github',
      'token',
      'file.js',
      'file',
      'js',
    ]);
  });

  test('should not add one-character parts of a compound', () => {
    expect(tokenize('v1.2')).toEqual(['v1.2', 'v1']);
  });

  test('should normalize full-width characters with NFKC', () => {
    expect(tokenize('ｇｈ　ＰＲ')).toEqual(['gh', 'pr']);
  });

  test('should segment Japanese and drop short hiragana particles', () => {
    expect(tokenize('PRを作って')).toEqual(['pr', '作']);
  });

  test('should keep katakana words in Japanese', () => {
    expect(tokenize('プルリクをマージしたい')).toEqual(['プルリク', 'マージ']);
  });

  test('should keep hiragana words longer than two characters', () => {
    expect(tokenize('まとめる')).toEqual(['まとめる']);
  });

  test('should segment Chinese', () => {
    expect(tokenize('請建立拉取請求')).toEqual([
      '請',
      '建立',
      '拉',
      '取',
      '請求',
    ]);
  });

  test('should keep repeated tokens for term frequency', () => {
    expect(tokenize('merge merge')).toEqual(['merge', 'merge']);
  });

  test('should return nothing for empty or punctuation-only text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' --- */ ')).toEqual([]);
  });
});

describe('termSet', () => {
  test('should hold each token once', () => {
    expect([...termSet('merge the merge PR')].sort()).toEqual(['merge', 'pr']);
  });
});

describe('jaccard', () => {
  test('should be 1 for equal sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1);
  });

  test('should be the overlap over the union', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(
      0.5
    );
  });

  test('should be 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  test('should be 0 when both sets are empty', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});
