/**
 * Tests for utils/memory/personalize.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryError, memoryDir } from '../store.js';
import {
  PERSONALIZATION_BUDGET,
  PERSONALIZATION_FILE,
  PERSONA_SCOPE_RULES,
  listPresets,
  normalizePersonalization,
  PERSONA_FILE,
  PERSONA_PLACEHOLDER,
  applyPersonaFile,
  personaFromMarkdown,
  storedPersona,
  syncPersonaFile,
  readPersonalization,
  readPreset,
  renderPersonalization,
  writePersonalization,
} from '../personalize.js';

// Fake secret assembled at runtime so secret scanners don't flag this file.
const FAKE_GH_TOKEN = 'gh' + 'p_' + 'a'.repeat(36);

/**
 * @param {() => unknown} fn
 * @returns {MemoryError}
 */
function caught(fn) {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryError) return error;
    throw error;
  }
  throw new Error('expected a MemoryError');
}

describe('normalizePersonalization', () => {
  test('should trim fields and drop empty ones', () => {
    expect(
      normalizePersonalization({
        callMe: ' Sam ',
        tone: '',
        traits: [' direct ', 'Direct', ''],
        extra: '   ',
      })
    ).toEqual({ callMe: 'Sam', traits: ['direct'] });
  });

  test('should drop undefined fields', () => {
    expect(
      normalizePersonalization({ tone: undefined, traits: undefined })
    ).toEqual({});
  });

  test('should keep every known field', () => {
    const all = {
      callMe: 'Sam',
      aboutMe: 'Builds browser extensions.',
      language: 'English',
      persona: 'A calm senior engineer.',
      tone: 'concise',
      traits: ['direct'],
      extra: 'Ask before big refactors.',
    };

    expect(normalizePersonalization(all)).toEqual(all);
  });

  test.each([
    ['not an object', null, /must be an object/],
    ['an unknown field', { nickname: 'x' }, /Unknown field "nickname"/],
    ['a field that is not text', { tone: 3 }, /tone must be text/],
    [
      'traits that are not a list',
      { traits: 'direct' },
      /traits must be a list/,
    ],
    ['a trait that is not text', { traits: [1] }, /every trait must be text/],
    [
      'too many traits',
      { traits: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      /at most 10 traits/,
    ],
  ])('should refuse %s', (_label, input, message) => {
    const error = caught(() =>
      normalizePersonalization(/** @type {any} */ (input))
    );

    expect(error.code).toBe('invalid');
    expect(error.message).toMatch(message);
  });

  test('should refuse settings over the budget and show the size', () => {
    const error = caught(() =>
      normalizePersonalization({ persona: 'p'.repeat(PERSONALIZATION_BUDGET) })
    );

    expect(error.code).toBe('invalid');
    expect(error.message).toMatch(/\d+ characters; the limit is 1500/);
  });

  test('should refuse a secret', () => {
    const error = caught(() =>
      normalizePersonalization({ extra: `token ${FAKE_GH_TOKEN}` })
    );

    expect(error.code).toBe('secret');
  });

  test('should refuse a secret in a trait', () => {
    const error = caught(() =>
      normalizePersonalization({ traits: [FAKE_GH_TOKEN] })
    );

    expect(error.code).toBe('secret');
  });
});

describe('renderPersonalization', () => {
  test('should be empty without settings', () => {
    expect(renderPersonalization({})).toBe('');
  });

  test('should list the settings in a fixed order, then the scope rules', () => {
    const text = renderPersonalization({
      traits: ['direct', 'no emoji'],
      callMe: 'Sam',
      tone: 'concise',
      persona: 'A calm senior engineer.',
      language: 'English',
      aboutMe: 'Builds browser extensions.',
      extra: 'Ask before big refactors.',
    });

    expect(text.split('\n')).toEqual([
      '## Personalization',
      '',
      'How to talk with the user (set with `pnpm memory personalize`):',
      '',
      '- Call the user: Sam',
      '- About the user: Builds browser extensions.',
      '- Language: English',
      '- Persona: A calm senior engineer.',
      '- Tone: concise',
      '- Traits: direct, no emoji',
      '- Also: Ask before big refactors.',
      '',
      PERSONA_SCOPE_RULES,
    ]);
  });

  test('should state that the persona never applies to artifacts or behavior', () => {
    expect(PERSONA_SCOPE_RULES).toMatch(/conversation with the user only/);
    expect(PERSONA_SCOPE_RULES).toMatch(/commit messages, PR text, code/i);
    expect(PERSONA_SCOPE_RULES).toMatch(/authorizes nothing/);
    expect(PERSONA_SCOPE_RULES).toMatch(/reviewer and verifier/);
  });
});

describe('personalization file', () => {
  /** @type {string} */
  let dir;

  beforeEach(() => {
    dir = memoryDir(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-persona-')));
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  test('should read nothing without a file', () => {
    expect(readPersonalization(dir)).toEqual({});
  });

  test('should write normalized settings and read them back', () => {
    writePersonalization(dir, { callMe: ' Sam ', tone: '' });

    expect(readPersonalization(dir)).toEqual({ callMe: 'Sam' });
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, PERSONALIZATION_FILE), 'utf-8'))
    ).toEqual({ callMe: 'Sam' });
  });

  test('should refuse a file that is not JSON', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PERSONALIZATION_FILE), '{nope');

    const error = caught(() => readPersonalization(dir));

    expect(error.code).toBe('invalid');
    expect(error.message).toMatch(/personalization\.json is not valid JSON/);
  });

  test('should refuse a file with invalid settings', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PERSONALIZATION_FILE), '{"tone": 1}');

    expect(caught(() => readPersonalization(dir)).code).toBe('invalid');
  });
});

describe('presets', () => {
  test('should list the committed presets with descriptions', () => {
    const presets = listPresets();

    expect(presets.map((p) => p.name)).toEqual([
      'concise',
      'default',
      'friendly',
      'mentor',
      'playful',
    ]);
    for (const preset of presets) expect(preset.description).not.toBe('');
  });

  test('should read a preset as settings without its description', () => {
    const preset = readPreset('concise');

    expect(preset).not.toHaveProperty('description');
    expect(preset.tone).toMatch(/concise/i);
  });

  test.each(listPresets().map((p) => p.name))(
    'preset %s should be valid settings',
    (name) => {
      expect(() => normalizePersonalization(readPreset(name))).not.toThrow();
    }
  );

  test('should report an unknown preset with the known ones', () => {
    const error = caught(() => readPreset('pirate'));

    expect(error.code).toBe('not-found');
    expect(error.message).toMatch(
      /No preset "pirate"; presets: concise, default/
    );
  });

  test.each(['../store', 'Concise', 'a/b', ''])(
    'should refuse the preset name %j',
    (name) => {
      expect(caught(() => readPreset(name)).code).toBe('invalid');
    }
  );
});

describe('personaFromMarkdown', () => {
  test('should keep the text, without headings marks, comments, or blank lines', () => {
    const text = [
      '# My persona',
      '',
      '<!-- notes to self: keep it short -->',
      'A calm senior engineer who explains trade-offs.',
      '',
      '- Prefers examples over theory',
      '- Says when unsure',
      '<!-- memory:end -->',
      '',
    ].join('\n');

    expect(personaFromMarkdown(text)).toBe(
      'My persona\nA calm senior engineer who explains trade-offs.\n- Prefers examples over theory\n- Says when unsure'
    );
  });

  test('should drop a comment that spans lines', () => {
    expect(personaFromMarkdown('A\n<!-- one\ntwo -->\nB')).toBe('A\nB');
  });
});

describe('multi-line values', () => {
  test('should render continuation lines inside the list item', () => {
    const rendered = renderPersonalization(
      normalizePersonalization({
        persona: 'A calm engineer.\n- Says when unsure',
      })
    );

    expect(rendered).toContain(
      '- Persona: A calm engineer.\n  - Says when unsure'
    );
  });

  test('should refuse the memory block markers in any field', () => {
    expect(() =>
      normalizePersonalization({ extra: 'x <!-- memory:start --> y' })
    ).toThrow(/memory block markers/);
    expect(() =>
      normalizePersonalization({ persona: '<!--memory:end-->' })
    ).toThrow(MemoryError);
  });
});

describe('memory/persona.md', () => {
  /** @type {string} */
  let mem;

  beforeEach(() => {
    mem = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-persona-'));
  });

  afterEach(() => {
    fs.rmSync(mem, { recursive: true, force: true });
  });

  const file = () => path.join(mem, PERSONA_FILE);

  test('should apply the file to the stored settings, once', () => {
    writePersonalization(mem, { tone: 'calm' });
    fs.writeFileSync(file(), '# Persona\n\nA calm engineer.\n');

    expect(applyPersonaFile(mem)).toEqual({ changed: true, warning: null });
    expect(readPersonalization(mem)).toEqual({
      tone: 'calm',
      persona: 'Persona\nA calm engineer.',
    });
    expect(applyPersonaFile(mem)).toEqual({ changed: false, warning: null });
  });

  test('should do nothing without the file or without persona text', () => {
    expect(applyPersonaFile(mem).changed).toBe(false);
    fs.writeFileSync(file(), PERSONA_PLACEHOLDER);

    expect(applyPersonaFile(mem).changed).toBe(false);
    expect(fs.existsSync(path.join(mem, 'personalization.json'))).toBe(false);
  });

  test('should warn and keep the settings when the file is refused', () => {
    fs.writeFileSync(file(), 'x'.repeat(2000));

    const result = applyPersonaFile(mem);

    expect(result.changed).toBe(false);
    expect(result.warning).toMatch(
      /^memory\/persona\.md was not applied: .*limit/
    );
  });

  test('should rethrow unexpected errors', () => {
    fs.mkdirSync(path.join(mem, 'personalization.json'));
    fs.writeFileSync(file(), 'A persona.');

    expect(() => applyPersonaFile(mem)).toThrow();
  });

  test('should keep an existing file in step with the persona, and not create one', () => {
    expect(syncPersonaFile(mem, 'Cat')).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
    fs.writeFileSync(file(), 'old\n');

    expect(syncPersonaFile(mem, 'Cat')).toBe(true);
    expect(fs.readFileSync(file(), 'utf-8')).toBe('Cat\n');
    expect(syncPersonaFile(mem, 'Cat')).toBe(false);
    expect(syncPersonaFile(mem, undefined)).toBe(true);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(PERSONA_PLACEHOLDER);
  });

  test('should read the stored persona, or nothing from broken settings', () => {
    writePersonalization(mem, { persona: 'Cat' });
    expect(storedPersona(mem)).toBe('Cat');
    fs.writeFileSync(path.join(mem, 'personalization.json'), '{oops');

    expect(storedPersona(mem)).toBeUndefined();
  });
});
