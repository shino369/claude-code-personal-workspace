import { defaultDeps } from '../deps.js';
import { TEMPLATES_DIR } from '../store.js';
import { ROOT_DIR } from '../../workspace-config.js';

describe('defaultDeps', () => {
  test('should point at the workspace root and templates by default', () => {
    const deps = defaultDeps();

    expect(deps.rootDir).toBe(ROOT_DIR);
    expect(deps.templatesDir).toBe(TEMPLATES_DIR);
    expect(deps.now()).toBeInstanceOf(Date);
  });

  test('should query git for the given directory', () => {
    const info = defaultDeps().git(ROOT_DIR);

    expect(info).toHaveProperty('branch');
    expect(info).toHaveProperty('changed');
  });

  test('should let callers override any dependency', () => {
    const log = () => {};

    expect(defaultDeps({ rootDir: '/tmp/x', log })).toMatchObject({
      rootDir: '/tmp/x',
      log,
    });
  });
});
