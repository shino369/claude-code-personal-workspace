import {
  commandMatch,
  guardDecision,
  pathMatches,
  readPermissions,
} from '../permissions.js';

const PERMS = readPermissions({
  permissions: {
    deny: ['Read(./.env)', 'Read(~/.ssh/**)', 'Edit(./secrets/**)'],
  },
});
const where = { projectDir: '/proj', home: '/home/me' };

describe('commandMatch bypasses and over-blocking', () => {
  const prefixes = [
    ['rm'],
    ['npm'],
    ['sudo'],
    ['git', 'reset', '--hard'],
    ['git', 'push'],
  ];
  /** @param {string} line */
  const match = (line) => commandMatch(line, prefixes)?.join(' ') ?? null;

  test('should not deny words inside quotes', () => {
    expect(match('git commit -m "fix; rm thing"')).toBeNull();
    expect(match('echo "a && npm b"')).toBeNull();
    expect(match("echo 'a | rm x' && ls")).toBeNull();
    expect(match('echo "a \\" ; rm x"')).toBeNull();
    expect(match('echo unclosed "rm x')).toBeNull();
    expect(match("echo 'unclosed rm x")).toBeNull();
  });

  test('should still find a command after quoted arguments', () => {
    expect(match('echo "a b" && rm x')).toBe('rm');
    expect(match('"rm" x')).toBe('rm');
    expect(match('r\\m x')).toBe('rm');
    expect(match('\\rm x')).toBe('rm');
    expect(match('echo a \\\n rm x; rm y')).toBe('rm');
    expect(match('echo a\\')).toBeNull();
  });

  test('should split on &, subshells, braces, and substitutions', () => {
    expect(match('sleep 1 & rm x')).toBe('rm');
    expect(match('echo $(rm x)')).toBe('rm');
    expect(match('echo `rm x`')).toBe('rm');
    expect(match('(rm x)')).toBe('rm');
    expect(match('{ rm x; }')).toBe('rm');
    expect(match('X=$(rm x)')).toBe('rm');
    expect(match('echo "$(rm x)"')).toBe('rm');
    expect(match('echo "`npm i`"')).toBe('npm');
  });

  test('should skip leading shell words and wrappers', () => {
    for (const lead of [
      'if true; then',
      'for i in 1; do',
      'else',
      'elif x; then',
      '!',
      'env',
      'env -i FOO=1',
      'command',
      'exec',
      'nohup',
      'time -p',
      'xargs -n1',
    ]) {
      expect(match(`${lead} rm x`)).toBe('rm');
    }
  });

  test('should match sudo as a command and as a wrapper', () => {
    expect(match('sudo rm x')).toBe('sudo');
    expect(commandMatch('sudo rm x', [['rm']])).toEqual(['rm']);
    expect(commandMatch('sudo -E rm x', [['rm']])).toEqual(['rm']);
    expect(match('sudo')).toBe('sudo');
  });

  test('should match the command word by its basename', () => {
    expect(match('/bin/rm x')).toBe('rm');
    expect(match("'C:\\tools\\rm' x")).toBe('rm');
    expect(match('/')).toBeNull();
  });

  test('should skip git global options', () => {
    expect(match('git -C . reset --hard')).toBe('git reset --hard');
    expect(match('git -c core.x=1 push')).toBe('git push');
    expect(match('git --git-dir=.git --work-tree=. push')).toBe('git push');
    expect(match('git --git-dir .git --work-tree . push')).toBe('git push');
    expect(match('git --no-pager -ccore.x=1 push')).toBe('git push');
    expect(match('git -C')).toBeNull();
    expect(match('git status')).toBeNull();
  });

  test('should not treat command -v as running the command', () => {
    expect(match('command -v rm')).toBeNull();
  });

  test('should look inside sh -c with a quoted script', () => {
    expect(match(`bash -c "echo hi; rm x"`)).toBe('rm');
    expect(match('bash -c')).toBeNull();
  });
});

describe('pathMatches platform', () => {
  test('should compare case-insensitively on macOS and Windows only', () => {
    for (const platform of ['darwin', 'win32']) {
      expect(pathMatches('/proj/.ENV', './.env', { ...where, platform })).toBe(
        true
      );
    }
    expect(
      pathMatches('/proj/.ENV', './.env', { ...where, platform: 'linux' })
    ).toBe(false);
  });
});

describe('guardDecision paths and symlinks', () => {
  /**
   * @param {Record<string, unknown>} input
   * @param {Record<string, unknown>} [extra]
   */
  const decide = (input, extra = {}) =>
    guardDecision({ cwd: '/proj', ...input }, PERMS, {
      harness: 'dsh',
      ...where,
      platform: 'linux',
      ...extra,
    });
  /** @param {string} file_path */
  const read = (file_path) => ({
    tool_name: 'read',
    tool_input: { file_path },
  });
  /** @param {string} command */
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

  test('should ignore case on macOS and Windows', () => {
    expect(decide(read('/proj/.ENV'), { platform: 'darwin' })).not.toBeNull();
    expect(decide(read('/proj/.ENV'), { platform: 'win32' })).not.toBeNull();
    expect(decide(read('/proj/.ENV'))).toBeNull();
  });

  test('should expand a leading ~/ to the home dir', () => {
    expect(decide(read('~/.ssh/id_rsa'))).toMatchObject({ decision: 'deny' });
    expect(decide(read('~/ok'))).toBeNull();
  });

  test('should check the resolved path of a symlink', () => {
    const realpath = (/** @type {string} */ file) =>
      file === '/proj/link' ? '/proj/.env' : file;
    expect(decide(read('link'), { realpath })).toMatchObject({
      decision: 'deny',
    });
    expect(decide(read('other'), { realpath })).toBeNull();
  });

  test('should match against a resolved project dir (macOS /var -> /private/var)', () => {
    const realpath = (/** @type {string} */ file) =>
      file.replace(/^\/proj/, '/private/proj');
    expect(decide(read('/proj/.env'), { realpath })).not.toBeNull();
    expect(decide(read('/private/proj/.env'), { realpath })).not.toBeNull();
  });

  test('should resolve patch paths against the cd directory', () => {
    const codex = { harness: 'codex' };
    expect(
      decide(
        bash("cd secrets && apply_patch <<'EOF'\n*** Update File: x.txt\nEOF"),
        codex
      )
    ).toMatchObject({ decision: 'deny' });
    expect(
      decide(
        bash(
          "cd ../elsewhere && apply_patch <<'EOF'\n*** Update File: secrets/x.txt\nEOF"
        ),
        codex
      )
    ).toBeNull();
    expect(
      decide(
        bash("cd ~ && apply_patch <<'EOF'\n*** Update File: secrets/x\nEOF"),
        codex
      )
    ).toBeNull();
  });
});
