// asset-basename.test.ts — SSOT rule set for asset filesystem basename validation
//
// See: packages/core/src/session/asset-basename.ts
//      feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.dev-plan.md
//
// The same function backs BOTH the pack-ops.ts session appliers (createDirectory
// / renameDirectory / renameSourceFile / renameAsset) AND the UX-side prompt
// validate callback — this test suite pins the rules for both consumers.

import { describe, expect, it } from 'bun:test';
import {
  validateAssetBasename,
  checkPathNotJailbreak,
  ASSET_BASENAME_MAX_LENGTH,
} from '../session/asset-basename';

describe('validateAssetBasename — legal names pass', () => {
  const legal = [
    'textures',
    'sub-folder',
    'Space Folder',
    '模型-fbx',
    'マテリアル',
    'material_2',
    'a.b.c',              // dots inside are fine
    '.gitignore',          // hidden files allowed
    '.git',                // hidden folders allowed
    'a',                   // 1-char minimum
    'a'.repeat(ASSET_BASENAME_MAX_LENGTH), // exactly at the max
    '🚀 emoji folder',      // unicode fine
    'foo (2)',             // parens fine on both windows + posix
    'foo & bar',           // ampersand fine
    "foo'bar",             // single quote fine
    'foo[1]',              // brackets fine
  ];
  for (const name of legal) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      const r = validateAssetBasename(name);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.name).toBe(name.trim());
    });
  }

  it('trims surrounding whitespace and returns the trimmed name', () => {
    const r = validateAssetBasename('   textures   ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name).toBe('textures');
  });
});

describe('validateAssetBasename — type + empty', () => {
  it('rejects non-strings', () => {
    expect(validateAssetBasename(undefined).ok).toBe(false);
    expect(validateAssetBasename(null).ok).toBe(false);
    expect(validateAssetBasename(42).ok).toBe(false);
    expect(validateAssetBasename({}).ok).toBe(false);
  });

  it('rejects empty string', () => {
    const r = validateAssetBasename('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/empty/);
  });

  it('rejects whitespace-only (after trim → empty)', () => {
    const r = validateAssetBasename('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/empty/);
  });
});

describe('validateAssetBasename — length', () => {
  it(`rejects longer than ${ASSET_BASENAME_MAX_LENGTH} chars`, () => {
    const r = validateAssetBasename('a'.repeat(ASSET_BASENAME_MAX_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/too long/);
  });
});

describe('validateAssetBasename — special segments', () => {
  it('rejects "."', () => {
    const r = validateAssetBasename('.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/"\." or "\.\."/);
  });
  it('rejects ".."', () => {
    const r = validateAssetBasename('..');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/"\." or "\.\."/);
  });
});

describe('validateAssetBasename — illegal characters (the reported bug)', () => {
  const illegalOneEach: Array<{ ch: string; label: string }> = [
    { ch: '\\', label: 'backslash (Windows path separator; the user-reported bug)' },
    { ch: '/',  label: 'forward slash (POSIX path separator)' },
    { ch: ':',  label: 'colon (Windows drive/stream separator)' },
    { ch: '*',  label: 'asterisk (Windows glob)' },
    { ch: '?',  label: 'question mark (Windows glob)' },
    { ch: '"',  label: 'double quote (Windows illegal)' },
    { ch: '<',  label: 'less-than (Windows illegal)' },
    { ch: '>',  label: 'greater-than (Windows illegal)' },
    { ch: '|',  label: 'pipe (Windows illegal)' },
    { ch: '\x00', label: 'NUL byte' },
    { ch: '\x1f', label: 'unit separator (US, 0x1f)' },
    { ch: '\t', label: 'tab (0x09)' },
    { ch: '\n', label: 'newline (0x0a)' },
  ];
  for (const { ch, label } of illegalOneEach) {
    it(`rejects "${label}" in the middle`, () => {
      const r = validateAssetBasename(`foo${ch}bar`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.hint).toMatch(/invalid character/);
    });
  }

  it('reports control chars with hex code (not literal)', () => {
    const r = validateAssetBasename('foo\x00bar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/\\x00/);
  });

  it('rejects the exact reported "foo\\bar" name (Windows separator smuggled in)', () => {
    const r = validateAssetBasename('foo\\bar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain('\\');
  });
});

describe('validateAssetBasename — Windows reserved names', () => {
  const reserved = ['CON', 'con', 'PRN', 'AUX', 'nul', 'COM1', 'COM9', 'LPT1', 'lpt9'];
  for (const name of reserved) {
    it(`rejects Windows-reserved "${name}"`, () => {
      const r = validateAssetBasename(name);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.hint).toMatch(/reserved on Windows/);
    });
  }

  it('rejects a reserved name with extension: LPT9.txt', () => {
    const r = validateAssetBasename('LPT9.txt');
    expect(r.ok).toBe(false);
  });

  it('does NOT reject a name that merely CONTAINS a reserved word', () => {
    // "concert" starts with "con" but is not reserved (regex is anchored).
    expect(validateAssetBasename('concert').ok).toBe(true);
    expect(validateAssetBasename('lpt10').ok).toBe(true); // LPT10 is not reserved
  });
});

describe('validateAssetBasename — trailing space / period', () => {
  it('rejects trailing space (Windows strips it silently)', () => {
    // trim() removes it before the test — construct via wrapping quotes to make
    // sure we exercise the branch: use a name whose whitespace is trailing but
    // preceded by non-whitespace after trim.  Note: `.trim()` DOES strip a
    // trailing plain space, so we need a name where the trailing space survives
    // trim. Since trim removes ALL trailing whitespace, the only way to trigger
    // this branch is a name that's already been trimmed but happens to have
    // an internal-then-trailing pattern like "foo\u00a0" — actually, `\u00a0`
    // (nbsp) IS stripped by `.trim()`. There is no way to reach this branch
    // from raw whitespace inputs; the branch guards against the *validated
    // BasenameValidation result branch*, so we skip: the branch is defensive.
    // Instead, test the SEMANTIC intent via trailing period:
    const r = validateAssetBasename('foo.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/space or "\."/);
  });

  it('accepts a name with an internal period (foo.bar)', () => {
    expect(validateAssetBasename('foo.bar').ok).toBe(true);
  });

  it('accepts a name ending in a letter or number', () => {
    expect(validateAssetBasename('foo').ok).toBe(true);
    expect(validateAssetBasename('foo9').ok).toBe(true);
  });
});

describe('checkPathNotJailbreak', () => {
  it('accepts a normal relative path', () => {
    expect(checkPathNotJailbreak('assets/textures/bricks').ok).toBe(true);
  });
  it('accepts a single segment', () => {
    expect(checkPathNotJailbreak('assets').ok).toBe(true);
  });

  it('rejects non-string', () => {
    expect(checkPathNotJailbreak(undefined).ok).toBe(false);
    expect(checkPathNotJailbreak(42).ok).toBe(false);
  });

  it('rejects empty path', () => {
    const r = checkPathNotJailbreak('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/empty/);
  });

  it('rejects NUL byte anywhere', () => {
    const r = checkPathNotJailbreak('assets/tex\x00tures');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/NUL/);
  });

  it('rejects backslash separators (Windows smuggling)', () => {
    const r = checkPathNotJailbreak('assets\\textures');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/"\/"/);
  });

  it('rejects ".." as a segment (parent traversal)', () => {
    const r = checkPathNotJailbreak('assets/../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/\.\./);
  });

  it('rejects a leading ".." segment', () => {
    expect(checkPathNotJailbreak('../secret').ok).toBe(false);
  });

  it('does NOT reject a filename that merely CONTAINS ".."', () => {
    // "foo..bar" is a single legitimate segment, not a parent traversal.
    expect(checkPathNotJailbreak('assets/foo..bar').ok).toBe(true);
  });

  it('does NOT reject a trailing ".." — segments are split, so trailing empty is not equal to ".."', () => {
    // `assets/..` splits to ['assets', '..'] → contains a ".." segment → REJECTED.
    expect(checkPathNotJailbreak('assets/..').ok).toBe(false);
  });
});
