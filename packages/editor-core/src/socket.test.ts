import { describe, expect, it } from 'bun:test';

import {
  SOCKET_DOC_VERSION,
  defaultSocket,
  emptySocketDoc,
  normalizeScale,
  scaleToTargetLen,
  targetLenToScale,
  uniqueSocketId,
  type SocketDoc,
} from './socket';
import { exportSocketJson, importSocketJson, validateSocketDoc } from './socket-io';

const sampleDoc: SocketDoc = {
  version: SOCKET_DOC_VERSION,
  skeletonId: 'humanoid_v1',
  sockets: [
    {
      id: 'weapon_primary',
      bone: 'hand_r',
      position: [0.165, -0.065, 0.075],
      rotationEulerDegXYZ: [-143, 109, -45],
      scale: 0.6,
      assetHint: 'rifle_default',
      aux: [{ id: 'foregrip', bone: 'hand_l', note: '仅校验，不驱动' }],
    },
  ],
};

describe('socket model', () => {
  it('defaultSocket is identity transform with uniform scale 1', () => {
    const s = defaultSocket('s1', 'hand_r');
    expect(s.position).toEqual([0, 0, 0]);
    expect(s.rotationEulerDegXYZ).toEqual([0, 0, 0]);
    expect(s.scale).toBe(1);
    expect(s.bone).toBe('hand_r');
  });

  it('uniqueSocketId avoids collisions', () => {
    const existing = [defaultSocket('socket'), defaultSocket('socket_2')];
    expect(uniqueSocketId(existing)).toBe('socket_3');
    expect(uniqueSocketId([])).toBe('socket');
  });

  it('normalizeScale expands scalar to vec3 and passes vec3 through', () => {
    expect(normalizeScale(0.6)).toEqual([0.6, 0.6, 0.6]);
    expect(normalizeScale([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('targetLenToScale / scaleToTargetLen round-trip and guard zero', () => {
    const scale = targetLenToScale(0.6, 1.2);
    expect(scale).toBeCloseTo(0.5, 6);
    expect(scaleToTargetLen(scale, 1.2)).toBeCloseTo(0.6, 6);
    expect(targetLenToScale(0.6, 0)).toBe(1);
    expect(targetLenToScale(0.6, NaN)).toBe(1);
  });
});

describe('socket-io', () => {
  it('export → import round-trips to a deeply equal doc', () => {
    const json = exportSocketJson(sampleDoc);
    const result = importSocketJson(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(sampleDoc);
      expect(result.warnings).toHaveLength(0);
    }
  });

  it('rejects malformed JSON', () => {
    const r = importSocketJson('{ not json');
    expect(r.ok).toBe(false);
  });

  it('rejects wrong schema (missing version)', () => {
    const r = importSocketJson(JSON.stringify({ skeletonId: 'x', sockets: [] }));
    expect(r.ok).toBe(false);
  });

  it('warns on skeleton mismatch but still imports', () => {
    const json = exportSocketJson(emptySocketDoc('skelA'));
    const r = importSocketJson(json, { skeletonId: 'skelB' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes('Skeleton mismatch'))).toBe(true);
  });

  it('warns on unknown bone references', () => {
    const warnings = validateSocketDoc(sampleDoc, { boneNames: ['hand_r'] });
    expect(warnings.some((w) => w.includes('unknown bone "hand_l"'))).toBe(true);
  });

  it('warns on duplicate socket ids', () => {
    const dup: SocketDoc = {
      version: SOCKET_DOC_VERSION,
      skeletonId: 's',
      sockets: [defaultSocket('a'), defaultSocket('a')],
    };
    expect(validateSocketDoc(dup).some((w) => w.includes('Duplicate'))).toBe(true);
  });
});
