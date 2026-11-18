import path from 'path';
import { relPosix, toPosix } from '../paths.js';

describe('toPosix', () => {
  test('should join native segments with /', () => {
    expect(toPosix(['tasks', 'x', 'NOTES.md'].join(path.sep))).toBe(
      'tasks/x/NOTES.md'
    );
    expect(toPosix('a/b')).toBe('a/b');
  });
});

describe('relPosix', () => {
  test('should give a /-separated relative path', () => {
    const root = path.resolve('/repo');
    expect(relPosix(root, path.join(root, 'tools', 'local.json'))).toBe(
      'tools/local.json'
    );
  });
});
