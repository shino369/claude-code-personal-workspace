/**
 * Tests for utils/redact.js — the secret rules shared by the audit logger
 * (redaction), memory writes (refusal), and memory export (scan).
 */
import {
  REDACTED,
  SECRET_RULE_NAMES,
  containsSecret,
  findSecrets,
  isSecretKey,
  redactSecrets,
} from '../redact.js';

// Fake secrets are assembled at runtime so secret scanners don't flag this file.
const FAKE = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  ghp: 'gh' + 'p_' + 'a'.repeat(36),
  ghPat: 'github' + '_pat_' + 'b'.repeat(30),
  sk: 'sk' + '-ant-' + 'c'.repeat(30),
  slack: 'xo' + 'xb-' + '1234567890-abc',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-1',
  pem:
    '-----BEGIN RSA PRIVATE' +
    ' KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE' +
    ' KEY-----',
};

describe('redact', () => {
  describe('redactSecrets', () => {
    test.each([
      ['AWS access key', `key ${FAKE.aws} end`],
      ['GitHub token', `token ${FAKE.ghp}`],
      ['GitHub fine-grained PAT', `pat ${FAKE.ghPat}`],
      ['sk- API key', `curl -H x ${FAKE.sk}`],
      ['Slack token', `slack ${FAKE.slack}`],
      ['JWT', `jwt ${FAKE.jwt}`],
    ])('should redact %s', (_label, text) => {
      const result = redactSecrets(text);

      expect(result).toContain(REDACTED);
      for (const secret of Object.values(FAKE)) {
        expect(result).not.toContain(secret);
      }
    });

    test('should redact a Bearer token but keep the scheme', () => {
      expect(redactSecrets('Authorization: Bearer abc.def-123')).toBe(
        `Authorization: Bearer ${REDACTED}`
      );
    });

    test('should redact a whole PEM private key block', () => {
      expect(redactSecrets(`before\n${FAKE.pem}\nafter`)).toBe(
        'before\n[REDACTED PRIVATE KEY]\nafter'
      );
    });

    test('should redact a PEM block with escaped newlines, as in a JSON key file', () => {
      const json = `{"private_key": "${FAKE.pem.replace(/\n/g, '\\n')}\\n"}`;

      expect(redactSecrets(json)).toBe(
        '{"private_key": "[REDACTED PRIVATE KEY]\\n"}'
      );
    });

    test('should redact an unterminated PEM block to the end', () => {
      const truncated = FAKE.pem.slice(0, 40);

      expect(redactSecrets(`x ${truncated}`)).toBe('x [REDACTED PRIVATE KEY]');
    });

    test.each([
      ['GITHUB_TOKEN=abc123 pnpm x', `GITHUB_TOKEN=${REDACTED} pnpm x`],
      ['export DB_PASSWORD="hunter 2"', `export DB_PASSWORD=${REDACTED}`],
      ["api_key: 'secret value'", `api_key: ${REDACTED}`],
      ['AWS_SECRET_ACCESS_KEY = xyz', `AWS_SECRET_ACCESS_KEY = ${REDACTED}`],
      ['deepseek_apikey=foo', `deepseek_apikey=${REDACTED}`],
      ['PASSWORD=$ecret', `PASSWORD=${REDACTED}`],
      ['API_KEY=$Secret1', `API_KEY=${REDACTED}`],
    ])('should keep the name and redact the value in %s', (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    });

    test.each([
      ['an env reference', 'GH_TOKEN=$GITHUB_TOKEN gh pr list'],
      ['a quoted env reference', 'export API_KEY="$DEEPSEEK_API_KEY"'],
      ['a braced env reference', 'GH_TOKEN=${GITHUB_TOKEN} gh api'],
      [
        'a command substitution',
        'GH_TOKEN=$(gh auth token --user someone) gh repo view',
      ],
      ['a placeholder', 'GITHUB_TOKEN=<your token> pnpm x'],
      ['an already redacted value', `GITHUB_TOKEN=${REDACTED} pnpm x`],
    ])('should keep %s, which is not a secret value', (_label, text) => {
      expect(redactSecrets(text)).toBe(text);
    });

    test('should leave ordinary text unchanged', () => {
      const text = 'git status && pnpm test -- --coverage';

      expect(redactSecrets(text)).toBe(text);
    });

    test('should be idempotent', () => {
      const text = `A=${FAKE.ghp} Bearer tok ${FAKE.pem} TOKEN=x`;

      const once = redactSecrets(text);

      expect(redactSecrets(once)).toBe(once);
    });

    test('should redact every occurrence on repeated calls', () => {
      const text = `${FAKE.aws} and ${FAKE.aws}`;

      expect(redactSecrets(text)).toBe(`${REDACTED} and ${REDACTED}`);
      expect(redactSecrets(text)).toBe(`${REDACTED} and ${REDACTED}`);
    });
  });

  describe('findSecrets', () => {
    test.each([
      ['private-key', FAKE.pem],
      ['bearer-token', 'Authorization: Bearer abc.def-123'],
      ['secret-assignment', 'DB_PASSWORD=hunter2'],
      ['aws-access-key', FAKE.aws],
      ['github-token', FAKE.ghp],
      ['github-pat', FAKE.ghPat],
      ['api-key', FAKE.sk],
      ['slack-token', FAKE.slack],
      ['jwt', FAKE.jwt],
    ])('should report the %s rule', (rule, text) => {
      expect(findSecrets(`note: ${text}`)).toContain(rule);
    });

    test('should list each matching rule once, in rule order', () => {
      const text = `${FAKE.aws} GITHUB_TOKEN=${FAKE.ghp} ${FAKE.aws}`;

      expect(findSecrets(text)).toEqual([
        'secret-assignment',
        'aws-access-key',
        'github-token',
      ]);
    });

    test('should report nothing for a note that only names a secret', () => {
      const note =
        'GITHUB_TOKEN in the environment is the company account; use ' +
        'GH_TOKEN=$(gh auth token --user someone) gh … for personal repos.';

      expect(findSecrets(note)).toEqual([]);
    });

    test('should report nothing for redacted text', () => {
      const text = `A=${FAKE.ghp} Bearer tok ${FAKE.pem} ${FAKE.jwt}`;

      expect(findSecrets(redactSecrets(text))).toEqual([]);
    });

    test('should give the same answer on repeated calls', () => {
      expect(findSecrets(FAKE.ghp)).toEqual(['github-token']);
      expect(findSecrets(FAKE.ghp)).toEqual(['github-token']);
    });
  });

  describe('containsSecret', () => {
    test('should be true when any rule matches', () => {
      expect(containsSecret(`token ${FAKE.slack}`)).toBe(true);
    });

    test('should be false for ordinary text', () => {
      expect(containsSecret('The proxy blocks GitHub GraphQL.')).toBe(false);
    });
  });

  describe('SECRET_RULE_NAMES', () => {
    test('should name every rule findSecrets can report, uniquely', () => {
      expect(new Set(SECRET_RULE_NAMES).size).toBe(SECRET_RULE_NAMES.length);
      expect(SECRET_RULE_NAMES).toEqual([
        'private-key',
        'bearer-token',
        'secret-assignment',
        'aws-access-key',
        'github-token',
        'github-pat',
        'api-key',
        'slack-token',
        'jwt',
      ]);
    });
  });

  describe('isSecretKey', () => {
    test.each([
      'DEEPSEEK_API_KEY',
      'Password',
      'gh_token',
      'apikey',
      'AWS_ACCESS_KEY',
    ])('should treat %s as a secret key', (key) => {
      expect(isSecretKey(key)).toBe(true);
    });

    test.each(['file_path', 'command', 'cwd'])(
      'should not treat %s as a secret key',
      (key) => {
        expect(isSecretKey(key)).toBe(false);
      }
    );
  });
});
