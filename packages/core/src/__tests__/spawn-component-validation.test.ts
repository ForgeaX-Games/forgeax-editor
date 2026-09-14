import { describe, expect, it } from 'bun:test';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { worldRootHandles } from '../store/entity-state';
import { createCoreTestWorld } from './fixtures/world';

function gateway() {
  const session = createEditSession();
  session.world = createCoreTestWorld([MeshFilter, MeshRenderer]);
  return new EditGateway(session);
}

describe('spawn component validation', () => {
  it('rejects unknown component fields before creating an entity', () => {
    const gw = gateway();
    const result = gw.dispatch({ kind: 'spawnEntity', name: 'invalid', components: { Transform: { position: [1, 2, 3] } } });
    expect(result.ok).toBe(false);
    expect(worldRootHandles(gw.activeWorld)).toHaveLength(0);
    expect(gw.undo()).toBe(false);
  });
  it('rejects a mesh handle used as a material before creating an entity', () => {
    const gw = gateway();
    const result = gw.dispatch({ kind: 'spawnEntity', name: 'invalid', components: { MeshFilter: { assetHandle: HANDLE_CUBE }, MeshRenderer: { materials: [HANDLE_CUBE] } } });
    expect(result.ok).toBe(false);
    expect(worldRootHandles(gw.activeWorld)).toHaveLength(0);
    expect(gw.undo()).toBe(false);
  });
  it('rejects an unresolved GUID before creating an entity', () => {
    const gw = gateway();
    const result = gw.dispatch({ kind: 'spawnEntity', name: 'invalid', components: { MeshFilter: { assetHandle: '11111111-1111-4111-8111-111111111111' } } });
    expect(result.ok).toBe(false);
    expect(worldRootHandles(gw.activeWorld)).toHaveLength(0);
  });
  it('rejects invalid material replacement without changing the live component', () => {
    const gw = gateway();
    const created = gw.dispatch({ kind: 'spawnEntity', name: 'cube', components: { MeshFilter: { assetHandle: HANDLE_CUBE } } });
    if (!created.ok) throw new Error(created.error.hint);
    const entity = worldRootHandles(gw.activeWorld)[0]!;
    const result = gw.dispatch({ kind: 'setComponent', entity, component: 'MeshRenderer', patch: { materials: [HANDLE_CUBE] } });
    expect(result.ok).toBe(false);
    expect(gw.activeWorld.get(entity, MeshRenderer).unwrap().materials.length).toBe(0);
  });
  it('preserves a builtin mesh with its default material and undo', () => {
    const gw = gateway();
    const result = gw.dispatch({ kind: 'spawnEntity', name: 'cube', components: { MeshFilter: { assetHandle: HANDLE_CUBE } } });
    expect(result.ok).toBe(true);
    expect(gw.undo()).toBe(true);
  });
});
