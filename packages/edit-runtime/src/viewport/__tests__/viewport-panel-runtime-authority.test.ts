import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'ViewportPanel.tsx'), 'utf8');
const runtimeComponent = readFileSync(resolve(import.meta.dir, '..', 'ViewportComponent.tsx'), 'utf8');

describe('Viewport panel Runtime authority', () => {
  it('routes shell toolbar operations through the active Runtime operation seam', () => {
    for (const operation of ['setGizmoMode', 'setGizmoSpace', 'setGizmoPivot', 'setViewportPreferences', 'replayParticleEffect']) {
      expect(panel).toContain(`dispatchActiveEditorOperation({ kind: '${operation}'`);
      expect(panel).not.toContain(`gateway.dispatch({ kind: '${operation}'`);
    }
  });

  it('projects Runtime-owned gizmo state back to shell controls', () => {
    expect(runtimeComponent).toContain('gizmoMode: getGizmoMode()');
    expect(runtimeComponent).toContain('gizmoSpace: getGizmoSpace()');
    expect(runtimeComponent).toContain('gizmoPivot: getGizmoPivot()');
    expect(panel).toContain("'panel.viewport.gizmo': projectedGizmoState.mode");
    expect(panel).toContain('useProjectedGizmoState()');
  });
});
