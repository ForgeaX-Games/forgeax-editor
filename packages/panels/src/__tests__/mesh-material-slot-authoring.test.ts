import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MeshAuthoringError, patchMeshMaterialSlotDefault } from '../mesh-material-slot-authoring';

const SOURCE_GUID = '019f0000-0000-7000-8000-000000000001';
const AUTHORED_GUID = '019f0000-0000-7000-8000-000000000002';

describe('Mesh material slot default authoring', () => {
  it('uses the Project ToolPlugin projection instead of the retired Gateway source owner', () => {
    const source = readFileSync(resolve(import.meta.dir, '../mesh-material-slot-authoring.ts'), 'utf8');
    expect(source).toContain('createProjectAuthoringGatewayProjection');
    expect(source).not.toContain('asset.preflight');
    expect(source).not.toContain('saveAssetSourceOverride');
    expect(source).not.toContain('waitViewportRuntimeOperationRun');
  });

  it('adds an authored default by stable sourceKey without replacing producer facts', () => {
    const original = {
      importScale: 2,
      materialSlots: [
        {
          slotName: 'Body',
          sourceKey: 'material/body',
          defaultMaterialGuid: SOURCE_GUID,
          producerNote: 'keep-me',
        },
        { slotName: 'Accent', sourceKey: 'material/accent' },
      ],
    };

    expect(
      patchMeshMaterialSlotDefault(
        original,
        { slotName: 'renamed-display-label', sourceKey: 'material/body' },
        AUTHORED_GUID,
      ),
    ).toEqual({
      importScale: 2,
      materialSlots: [
        {
          slotName: 'Body',
          sourceKey: 'material/body',
          defaultMaterialGuid: SOURCE_GUID,
          producerNote: 'keep-me',
        },
        { slotName: 'Accent', sourceKey: 'material/accent' },
      ],
      materialSlotDefaultOverrides: { 'material/body': AUTHORED_GUID },
    });
    expect(original).not.toHaveProperty('materialSlotDefaultOverrides');
  });

  it('removes only the authored override when following the imported source again', () => {
    const patched = patchMeshMaterialSlotDefault(
      {
        materialSlots: [
          {
            slotName: 'Body',
            sourceKey: 'material/body',
            defaultMaterialGuid: SOURCE_GUID,
          },
        ],
        materialSlotDefaultOverrides: { 'material/body': AUTHORED_GUID },
      },
      { slotName: 'Body', sourceKey: 'material/body' },
      undefined,
    );

    expect(patched).toEqual({
      materialSlots: [
        { slotName: 'Body', sourceKey: 'material/body', defaultMaterialGuid: SOURCE_GUID },
      ],
    });
  });

  it('stores null as an explicit Engine-default choice distinct from Follow Source', () => {
    expect(patchMeshMaterialSlotDefault(
      {
        materialSlots: [{ slotName: 'Body', sourceKey: 'material/body', defaultMaterialGuid: SOURCE_GUID }],
      },
      { slotName: 'Body', sourceKey: 'material/body' },
      null,
    )).toMatchObject({ materialSlotDefaultOverrides: { 'material/body': null } });
  });

  it('preserves structured recovery fields when producer topology cannot identify a slot', () => {
    try {
      patchMeshMaterialSlotDefault(
        { materialSlots: [{ slotName: 'Body', sourceKey: 'material/body' }] },
        { slotName: 'Missing', sourceKey: 'material/missing' },
        AUTHORED_GUID,
      );
      throw new Error('expected mesh slot authoring to fail');
    } catch (cause) {
      expect(cause).toBeInstanceOf(MeshAuthoringError);
      expect(cause).toMatchObject({
        code: 'mesh-slot-not-found',
        expected: 'the imported Mesh source override to contain slot Missing',
        hint: 'Material slot "Missing" is absent from the source override.',
        detail: { slotName: 'Missing', sourceKey: 'material/missing' },
        retryable: false,
        recoveryActions: ['authoring.snapshot.read'],
      });
      expect((cause as Error).message).toBe('Material slot "Missing" is absent from the source override.');
    }
  });
});
