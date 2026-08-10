// gateway-update-material-params.test.ts — regression for the material-editor
// texture-drop write rejection (PACK_SHELL_INVALID at assets.N.refs.0).
//
// ROOT CAUSE PINNED HERE: the engine catalog envelope carries refs as AssetRef
// OBJECTS ({ guid, sourceField?, sceneEntityId? } — prod loadByGuid builds them
// via refs.map(g => ({ guid: g }))), but the pack wire format stores refs as
// GUID STRINGS (zod: refs: z.array(z.string())) and the updateMaterialParams
// applier's encodeTextureRefs/invertTextureGuids operate on strings (indexOf /
// numeric-index lookup). _preFillMaterialOp used to copy the OBJECTS into
// _oldRefs/_oldEntry.refs verbatim, so the merged pack entry failed
// validatePackShell at refs.0 and writePack rejected it — every texture drop
// on a prod-loaded material silently failed to reach disk.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { assetIO, type AssetEntry } from '../io/asset-io-facade';
import { validatePackShell } from '../scene/scene-pack';
import type { EditorOp, EditSession } from '../types';
import { setPathResolver } from '../util/path-resolver';
import '../session/material-ops'; // applier registration side effect

const MATERIAL_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const BOUND_TEXTURE_GUID = 'd1f2a3b4-c5d6-5e70-8901-234567890abc';
const DROPPED_TEXTURE_GUID = 'e2f3a4b5-c6d7-5f80-9012-3456789abcde';

function makeShaderRegistry(): ShaderRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (fallback: unknown) => fallback,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const shaders = new ShaderRegistry({ device, manifestUrl: undefined });
  shaders.installMaterialArtifact('test::dummy', { source: 'fn main() {}', paramSchema: [] });
  return shaders;
}

function setup(): { gateway: EditGateway } {
  const world = new World();
  const registry = new AssetRegistry(makeShaderRegistry());
  const mat: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'test::dummy' } }],
    values: { baseColorTexture: 0 },
  };
  const guid = AssetGuid.parse(MATERIAL_GUID);
  if (!guid.ok) throw new Error('bad material test GUID');
  // Prod-path envelope shape: refs as AssetRef OBJECTS, matching what
  // loadByGuid registers (the shape that reached _preFillMaterialOp in the bug).
  const catalogued = registry.catalog(guid.value, mat, [{ guid: BOUND_TEXTURE_GUID }]);
  if (!catalogued.ok) throw new Error(`material catalog failed: ${String(catalogued.error)}`);

  const session: EditSession = createEditSession();
  session.world = world as unknown as EditSession['world'];
  session.registry = registry;
  return { gateway: new EditGateway(session) };
}

describe('updateMaterialParams — envelope AssetRef[] → wire string[] projection', () => {
  let written: AssetEntry[] = [];
  let writtenPaths: string[] = [];
  const originalWritePackEntry = assetIO.writePackEntry;

  beforeEach(() => {
    written = [];
    writtenPaths = [];
    // Capture the entry the applier writes instead of hitting the network.
    assetIO.writePackEntry = (async (packPath: string, entry: AssetEntry) => {
      writtenPaths.push(packPath);
      written.push(entry);
      return true;
    }) as typeof assetIO.writePackEntry;
  });

  afterEach(() => {
    assetIO.writePackEntry = originalWritePackEntry;
    setPathResolver(null);
  });

  it('canonicalizes a game-relative pack path through the active host resolver', async () => {
    setPathResolver((relativePath) => relativePath ? `sample/${relativePath}` : 'sample');
    const { gateway } = setup();
    const r = gateway.dispatch({
      kind: 'updateMaterialParams',
      packPath: 'assets/base-material.pack.json',
      guid: MATERIAL_GUID,
      paramPatch: { roughness: 0.4 },
    } as unknown as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writtenPaths).toEqual(['sample/assets/base-material.pack.json']);
  });

  it('prefills _oldRefs / _oldEntry.refs as GUID STRINGS, not AssetRef objects', () => {
    const { gateway } = setup();
    const op = {
      kind: 'updateMaterialParams',
      packPath: 'spin-cube/assets/base-material.pack.json',
      guid: MATERIAL_GUID,
      paramPatch: {},
      textureGuids: { baseColorTexture: DROPPED_TEXTURE_GUID },
    } as unknown as EditorOp & { _oldRefs?: unknown; _oldEntry?: { refs?: unknown } };

    const r = gateway.dispatch(op as EditorOp, 'ai');
    expect(r.ok).toBe(true);
    expect(op._oldRefs).toEqual([BOUND_TEXTURE_GUID]);
    expect(op._oldEntry?.refs).toEqual([BOUND_TEXTURE_GUID]);
  });

  it('writes a pack entry whose refs stay string[] and passes shell validation', async () => {
    const { gateway } = setup();
    const op = {
      kind: 'updateMaterialParams',
      packPath: 'spin-cube/assets/base-material.pack.json',
      guid: MATERIAL_GUID,
      paramPatch: {},
      textureGuids: { metallicRoughnessTexture: DROPPED_TEXTURE_GUID },
    } as unknown as EditorOp;

    const r = gateway.dispatch(op, 'human');
    expect(r.ok).toBe(true);

    // The applier's assetIO write is fire-and-forget — let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written.length).toBe(1);

    const entry = written[0] as { refs: unknown; payload: { values: Record<string, unknown> } };
    // Existing bound ref survives as a STRING; the dropped texture GUID is
    // appended as a string; values carries its refs[] INDEX (number).
    expect(entry.refs).toEqual([BOUND_TEXTURE_GUID, DROPPED_TEXTURE_GUID]);
    expect(entry.payload.values.baseColorTexture).toBe(0);
    expect(entry.payload.values.metallicRoughnessTexture).toBe(1);

    const shell = validatePackShell({
      schemaVersion: '1.0',
      kind: 'internal-text-package',
      assets: [entry],
    });
    expect(shell.ok).toBe(true);
  });

  it('builds a correct inverse (undo restores the previously bound texture GUID)', () => {
    const { gateway } = setup();
    const op = {
      kind: 'updateMaterialParams',
      packPath: 'spin-cube/assets/base-material.pack.json',
      guid: MATERIAL_GUID,
      paramPatch: {},
      textureGuids: { baseColorTexture: DROPPED_TEXTURE_GUID },
    } as unknown as EditorOp;

    const r = gateway.dispatch(op, 'human');
    expect(r.ok).toBe(true);
    // dispatch() returns DispatchResult ({ok:true}); the applier's inverse
    // lands on the undo stack.
    const undoStack = (gateway as unknown as { undoStack: { inverse: unknown }[] }).undoStack;
    const inverse = undoStack[undoStack.length - 1]!.inverse as { textureGuids?: Record<string, string | null> };
    // invertTextureGuids resolves oldParamValues.baseColorTexture (=0) through
    // oldRefs[0] — only possible when _oldRefs are strings, not objects.
    expect(inverse.textureGuids).toEqual({ baseColorTexture: BOUND_TEXTURE_GUID });
  });
});
