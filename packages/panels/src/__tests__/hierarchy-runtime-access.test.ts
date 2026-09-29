import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';
import {
  canDispatchPanelDocumentOperations,
  getEditorPanelAuthoritySnapshot,
  usesCarrierHierarchyProjection,
  usesHostGatewayForPanelDispatch,
} from '@forgeax/editor-core';
import { resolveHierarchyRuntimeAccess } from '../hierarchy-state';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Hierarchy.tsx'), 'utf8');

describe('Hierarchy runtime access', () => {
  it('routes the panel through the unified authority hook', () => {
    expect(panel).toContain('useHierarchyPanelAuthority(gateway.mode)');
    expect(panel).not.toContain('viewportRuntimeReady && !hasLocalRuntimeGraph');
    expect(panel).not.toContain('resolveHierarchyRuntimeAccess({');
  });

  it('keeps hierarchy access aligned with editor panel authority', () => {
    const authority = getEditorPanelAuthoritySnapshot();
    const access = resolveHierarchyRuntimeAccess({ gatewayMode: 'edit' });
    expect(access.hierarchyReadsFromCarrier).toBe(usesCarrierHierarchyProjection(authority));
    expect(access.usesRemoteProjection).toBe(access.hierarchyReadsFromCarrier);
  });

  it('pairs host-coworker dispatch with non-carrier hierarchy reads', () => {
    const authority = getEditorPanelAuthoritySnapshot();
    if (authority.mode !== 'host-coworker') return;
    expect(usesHostGatewayForPanelDispatch(authority)).toBe(true);
    expect(usesCarrierHierarchyProjection(authority)).toBe(false);
    expect(resolveHierarchyRuntimeAccess({ gatewayMode: 'edit' })).toMatchObject({
      hierarchyReadsFromCarrier: false,
      readOnly: false,
    });
  });

  it('pairs projection-client carrier reads with runtime dispatch when ready', () => {
    const authority = getEditorPanelAuthoritySnapshot();
    if (authority.mode !== 'projection-client' || !authority.viewportRuntimeReady) return;
    expect(usesHostGatewayForPanelDispatch(authority)).toBe(false);
    expect(usesCarrierHierarchyProjection(authority)).toBe(true);
    expect(canDispatchPanelDocumentOperations(authority)).toBe(true);
    expect(resolveHierarchyRuntimeAccess({ gatewayMode: 'edit' })).toMatchObject({
      hierarchyReadsFromCarrier: true,
      readOnly: false,
    });
  });

  it('keeps Play read-only regardless of authority mode', () => {
    expect(resolveHierarchyRuntimeAccess({ gatewayMode: 'play' }).readOnly).toBe(true);
  });
});
