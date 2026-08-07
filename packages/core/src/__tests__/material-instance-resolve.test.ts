import { describe, expect, it } from 'bun:test';
import {
  createDefaultMaterialInstancePayload,
  encodeMaterialInstancePackRefs,
  MATERIAL_INSTANCE_KIND,
} from '../assets/material-instance-schema';
import {
  getInheritedValue,
  resolveOverrides,
  wouldCreateParentCycle,
  type MaterialCatalogLookup,
} from '../assets/material-instance-resolve';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const GRAND = '33333333-3333-4333-8333-333333333333';

function lookupFrom(
  entries: Array<{ guid: string; kind: string; payload: Record<string, unknown> }>,
): MaterialCatalogLookup {
  const map = new Map(entries.map((e) => [e.guid.toLowerCase(), e]));
  return (guid) => map.get(guid.toLowerCase());
}

describe('material-instance-schema', () => {
  it('createDefaultMaterialInstancePayload builds kind + default lightmass', () => {
    const payload = createDefaultMaterialInstancePayload(PARENT, {
      overrides: { metallic: { enabled: true, value: 0.8 } },
    });
    expect(payload.kind).toBe(MATERIAL_INSTANCE_KIND);
    expect(payload.parent).toBe(PARENT);
    expect(payload.lightmass.emissiveBoost).toBe(1);
    expect(payload.overrides.metallic?.enabled).toBe(true);
  });

  it('encodeMaterialInstancePackRefs puts parent (and physMaterial) into refs[]', () => {
    const phys = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const payload = createDefaultMaterialInstancePayload(PARENT, { physMaterial: phys });
    const encoded = encodeMaterialInstancePackRefs(payload);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.refs).toContain(PARENT);
    expect(encoded.refs).toContain(phys);
    expect(encoded.payload.parent).toBe(PARENT);
  });
});

describe('wouldCreateParentCycle', () => {
  it('rejects self as parent', () => {
    expect(wouldCreateParentCycle(CHILD, CHILD, () => undefined)).toBe(true);
  });

  it('rejects ancestor as parent (A→B→C, C cannot parent to A)', () => {
    const lookup = lookupFrom([
      {
        guid: PARENT,
        kind: 'material',
        payload: { kind: 'material', values: { metallic: 0 } },
      },
      {
        guid: CHILD,
        kind: MATERIAL_INSTANCE_KIND,
        payload: createDefaultMaterialInstancePayload(PARENT) as unknown as Record<string, unknown>,
      },
      {
        guid: GRAND,
        kind: MATERIAL_INSTANCE_KIND,
        payload: createDefaultMaterialInstancePayload(CHILD) as unknown as Record<string, unknown>,
      },
    ]);
    // Making PARENT's parent = GRAND would cycle: PARENT ← CHILD ← GRAND ← PARENT
    expect(wouldCreateParentCycle(PARENT, GRAND, lookup)).toBe(true);
    expect(wouldCreateParentCycle(GRAND, PARENT, lookup)).toBe(false);
  });
});

describe('resolveOverrides', () => {
  it('merges parent material values with enabled MI overrides', () => {
    const lookup = lookupFrom([
      {
        guid: PARENT,
        kind: 'material',
        payload: {
          kind: 'material',
          values: { baseColor: [1, 0, 0, 1], metallic: 0, roughness: 0.5 },
        },
      },
    ]);
    const mi = createDefaultMaterialInstancePayload(PARENT, {
      overrides: {
        metallic: { enabled: true, value: 0.9 },
        roughness: { enabled: false, value: 0.1 },
      },
    });
    const resolved = resolveOverrides(mi, lookup);
    expect(resolved.baseColor).toEqual([1, 0, 0, 1]);
    expect(resolved.metallic).toBe(0.9);
    expect(resolved.roughness).toBe(0.5); // disabled override ignored
  });

  it('getInheritedValue returns parent value before local override', () => {
    const lookup = lookupFrom([
      {
        guid: PARENT,
        kind: 'material',
        payload: { kind: 'material', values: { metallic: 0.25 } },
      },
    ]);
    const mi = createDefaultMaterialInstancePayload(PARENT, {
      overrides: { metallic: { enabled: true, value: 1 } },
    });
    expect(getInheritedValue(mi, 'metallic', lookup)).toBe(0.25);
  });

  it('walks MI → MI → material chain', () => {
    const lookup = lookupFrom([
      {
        guid: PARENT,
        kind: 'material',
        payload: { kind: 'material', values: { baseColor: [0, 1, 0, 1], metallic: 0 } },
      },
      {
        guid: CHILD,
        kind: MATERIAL_INSTANCE_KIND,
        payload: createDefaultMaterialInstancePayload(PARENT, {
          overrides: { metallic: { enabled: true, value: 0.4 } },
        }) as unknown as Record<string, unknown>,
      },
    ]);
    const grand = createDefaultMaterialInstancePayload(CHILD, {
      overrides: { baseColor: { enabled: true, value: [0, 0, 1, 1] } },
    });
    const resolved = resolveOverrides(grand, lookup);
    expect(resolved.baseColor).toEqual([0, 0, 1, 1]);
    expect(resolved.metallic).toBe(0.4);
  });
});
