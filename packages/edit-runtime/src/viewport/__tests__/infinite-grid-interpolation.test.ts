import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const shader = readFileSync(new URL('../shaders/infinite-grid.wgsl', import.meta.url), 'utf8');

describe('infinite grid WebGL2 interpolation contract', () => {
  it('does not require the GLSL noperspective qualifier on the WebGL2 fallback', () => {
    // A shader module and pipeline handle can be returned even though the
    // pipeline is invalid; the packaged wgpu backend then fails at queue.submit.
    expect(shader).toMatch(/@location\(1\)\s+@interpolate\(perspective\)\s+ndc\s*:\s*vec2<f32>/);
    expect(shader).not.toMatch(/@interpolate\(\s*linear\b/);
  });

  it('keeps clip w constant so perspective interpolation preserves screen NDC', () => {
    // With w=1 at every vertex, perspective-correct interpolation reduces to
    // the same screen-linear interpolation used by the grid reconstruction.
    expect(shader).toContain('out.clip = vec4<f32>(ndc, 0.0, 1.0);');
    expect(shader.match(/out\.clip\s*=/g)).toHaveLength(1);
    expect(shader).not.toMatch(/out\.clip\.[xyzw]+\s*=/);
    expect(shader).toContain('out.ndc = ndc;');
  });
});
