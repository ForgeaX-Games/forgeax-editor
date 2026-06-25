// Build VAG_SPAWN_ENTITY payloads from Content Browser drag refs.

export interface DragAssetRef {
  type: 'asset';
  guid: string;
  kind?: string;
  name?: string;
  path?: string;
  payload?: Record<string, unknown>;
}

export interface SpawnRefEntity {
  name: string;
  components: Record<string, unknown>;
}

const TEXTURE_KINDS = new Set(['texture', 'image']);

function stemName(ref: DragAssetRef): string {
  const raw = ref.name?.trim() || ref.guid.slice(0, 8);
  return raw.replace(/[^\w.-]+/g, '_').slice(0, 48) || 'Asset';
}

function textureScale(payload?: Record<string, unknown>): { scaleX: number; scaleY: number; scaleZ: number } {
  const w = typeof payload?.width === 'number' && payload.width > 0 ? payload.width : null;
  const h = typeof payload?.height === 'number' && payload.height > 0 ? payload.height : null;
  const base = 2;
  if (w && h) {
    const aspect = w / h;
    return aspect >= 1
      ? { scaleX: base, scaleY: base / aspect, scaleZ: 0.02 }
      : { scaleX: base * aspect, scaleY: base, scaleZ: 0.02 };
  }
  return { scaleX: base, scaleY: base, scaleZ: 0.02 };
}

/** Map a dragged asset ref to a single reference-mode spawn entity, or null if unsupported. */
export function buildSpawnEntityFromDragRef(ref: DragAssetRef): SpawnRefEntity | null {
  const kind = ref.kind ?? '';
  const name = stemName(ref);

  if (TEXTURE_KINDS.has(kind)) {
    const scale = textureScale(ref.payload);
    return {
      name,
      components: {
        Transform: { x: 0, y: scale.scaleY / 2 + 0.01, z: 0, ...scale },
        Mesh: { kind: 'cube' },
        Material: { shading: 'unlit', albedo: '#ffffff', albedoMap: ref.guid },
      },
    };
  }

  if (kind === 'material') {
    return {
      name,
      components: {
        Transform: { x: 0, y: 0.5, z: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
        Mesh: { kind: 'sphere' },
        Material: { materialAsset: ref.guid },
      },
    };
  }

  if (kind === 'mesh') {
    return {
      name,
      components: {
        Transform: { x: 0, y: 0.5, z: 0 },
        Mesh: { kind: 'cube' },
        Material: { albedo: '#cccccc', roughness: 0.7 },
      },
    };
  }

  return null;
}
