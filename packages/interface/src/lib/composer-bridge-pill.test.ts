/**
 * Pill sentinel codec round-trip. Pure (no DOM). Guards the ⟦pill:…⟧ encoding
 * that carries structured references through the otherwise-plaintext message.
 */
import { describe, it, expect } from 'bun:test';
import { encodePill, decodePill, parseSegments, expandPills, expandPillsForDisplay, buildSlashPill, parseDisplaySegments, type PillPayload } from './composer-bridge';

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

  it('expandPillsForDisplay keeps skill/command pills as sentinels', () => {
    const skill = buildSlashPill({ trigger: '/implement-feature', source: 'skill', displayName: 'Implement' });
    const cmd = buildSlashPill({ trigger: '/compact', source: 'command' });
    const skillTok = encodePill(skill);
    const cmdTok = encodePill(cmd);
    expect(expandPillsForDisplay(`${skillTok} hello`)).toBe(`${skillTok} hello`);
    expect(expandPillsForDisplay(`${cmdTok} args`)).toBe(`${cmdTok} args`);
    expect(expandPills(`${skillTok} hello`)).toBe('/implement-feature hello');
  });

  it('expandPillsForDisplay still expands paste/file pills', () => {
    const token = encodePill(sample);
    expect(expandPillsForDisplay(`see ${token}`)).toBe(`see ${sample.detail}`);
  });

  it('parseDisplaySegments tags a leading slash command in plain text', () => {
    const segs = parseDisplaySegments('/compact do it');
    expect(segs.map((s) => s.kind)).toEqual(['pill', 'text']);
    expect(segs[0].kind === 'pill' && segs[0].payload.display).toBe('/compact');
    expect(segs[1]).toEqual({ kind: 'text', text: ' do it' });
  });
});
