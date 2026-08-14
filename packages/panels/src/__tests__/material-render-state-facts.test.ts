import { describe, expect, it } from 'bun:test';
import { materialRenderStateFacts } from '../asset-inspector/material-render-state-facts';

describe('materialRenderStateFacts', () => {
  it('treats cullMode none as two-sided and a blend object as Blend', () => {
    const facts = materialRenderStateFacts({
      passes: [{ renderState: { cullMode: 'none', blend: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
    });
    expect(facts.twoSided).toBe(true);
    expect(facts.cullMode).toBe('none');
    expect(facts.blendLabel).toBe('Blend');
  });

  it('defaults to back-face cull and Opaque when renderState is omitted', () => {
    const facts = materialRenderStateFacts({ passes: [{ name: 'Forward' }] });
    expect(facts.twoSided).toBe(false);
    expect(facts.cullMode).toBe('back');
    expect(facts.blendLabel).toBe('Opaque');
  });
});
