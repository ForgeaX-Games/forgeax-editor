/**
 * Pill sentinel codec round-trip. Pure (no DOM). Guards the ⟦pill:…⟧ encoding
 * that carries structured references through the otherwise-plaintext message.
 */
import { describe, it, expect } from 'bun:test';
import { encodePill, decodePill, parseSegments, expandPills, type PillPayload } from './pill';

const sample: PillPayload = {
  kind: 'file',
  display: 'main.ts',
  icon: '📄',
  detail: '[文件引用: `games/x/main.ts`]',
  tooltip: { title: '📄 文件 · main.ts', lines: ['路径: games/x/main.ts'] },
};

describe('pill codec', () => {
  it('encode → decode round-trips (incl. CJK)', () => {
    const token = encodePill(sample);
    expect(token.startsWith('⟦pill:')).toBe(true);
    expect(decodePill(token)).toEqual(sample);
  });

  it('decode rejects malformed tokens', () => {
    expect(decodePill('not a pill')).toBeNull();
    expect(decodePill('⟦pill:@@@invalid@@@⟧')).toBeNull();
  });

  it('parseSegments splits text and pills in order', () => {
    const token = encodePill(sample);
    const segs = parseSegments(`hi ${token} bye`);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'pill', 'text']);
    expect(segs[0]).toEqual({ kind: 'text', text: 'hi ' });
    expect(segs[1].kind === 'pill' && segs[1].payload.display).toBe('main.ts');
  });

  it('expandPills replaces a pill with its detail text (for the AI)', () => {
    const token = encodePill(sample);
    expect(expandPills(`see ${token}`)).toBe(`see ${sample.detail}`);
  });

  it('expandPills leaves a corrupt token untouched', () => {
    expect(expandPills('⟦pill:@@@⟧')).toBe('⟦pill:@@@⟧');
  });
});
