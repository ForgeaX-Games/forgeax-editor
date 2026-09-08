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

  it('binds an in-process Runtime client for desktop same-window hosts so Play enablement can go true', () => {
    expect(runtimeComponent).toContain('shouldBindInProcessViewportRuntimeClient');
    expect(runtimeComponent).toContain("runtimeIdentity.carrierKind === 'iframe'");
    expect(runtimeComponent).toContain('bindViewportRuntimeClient');
    expect(panel).toContain("enablement: 'panel.viewport.mounted'");
    expect(panel).toContain("testId: 'vp-play'");
    expect(panel).toContain('getActiveRuntimeUiGraph() !== null');
    expect(panel).toContain("status.playPhase === 'starting'");
  });

  it('dispatches same-window Play through the live EditGateway when the Runtime client is disconnected', () => {
    const operation = readFileSync(resolve(import.meta.dir, '../../../../core/src/store/active-operation.ts'), 'utf8');
    expect(operation).toContain('getActiveRuntimeUiGraph() !== null');
    expect(operation).toContain('gateway.dispatch(operation, origin)');
    expect(operation).toContain('[editor] operation blocked: Viewport Runtime is disconnected');
  });

  it('projects Runtime-owned gizmo state back to shell controls', () => {
    expect(runtimeComponent).toContain('gizmoMode: getGizmoMode()');
    expect(runtimeComponent).toContain('gizmoSpace: getGizmoSpace()');
    expect(runtimeComponent).toContain('gizmoPivot: getGizmoPivot()');
    expect(panel).toContain("'panel.viewport.gizmo': projectedGizmoState.mode");
    expect(panel).toContain('useProjectedGizmoState()');
  });
});
