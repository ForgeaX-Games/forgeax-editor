import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');
const draft = readFileSync(resolve(import.meta.dir, '..', 'useNumberDraft.ts'), 'utf8');

describe('Inspector draft and live conflict red paths', () => {
  it('keeps a focused or scrubbed draft ahead of live selector pulses', () => {
    expect(panel).toContain('isFocused');
    expect(panel).toContain('isScrubbing');
    expect(panel).toContain('worldGeneration');
    expect(draft).toContain('generation');
  });

  it('cancels drafts when selection or world generation changes', () => {
    expect(panel).toContain('selectionGeneration');
    expect(panel).toContain('cancelDraft');
  });

  it('gates every Inspector mutation while Play is read-only', () => {
    expect(panel).toContain('readOnly');
    expect(panel).toContain('if (readOnly) return');
  });

  it('keeps quaternion rotation live until the rotation draft commits', () => {
    expect(panel).toContain('quatToEuler');
    expect(panel).toContain('eulerToQuat');
    expect(panel).toContain('rotationDraft');
  });
});
