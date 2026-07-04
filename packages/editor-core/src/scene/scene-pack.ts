// Scene pack constants + helpers.
//
// M5: sessionToPack deleted — writeback now uses the engine's rootsToSceneAsset
// + serializeSceneAssetToPack pipeline (plan-strategy D-1). isScenePack + stableGuid
// + builtin GUID constants remain for store.ts disk-watch reload + scene seeding.
//
//   { schemaVersion, kind:'internal-text-package', assets: [
//       { guid, kind:'scene',    payload:{kind:'scene', entities}, refs:[guid…] },
//       { guid, kind:'material', payload:{kind:'material', passes, paramValues}, refs:[] },
//       …
//   ] }

// Engine built-in mesh GUIDs (asset-registry.ts BUILTIN_MESH_GUIDS).
export const CUBE_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
export const SPHERE_GUID = '95730fd2-9846-5f84-8658-0b3c971eb263';
// feat-20260701-editor-world-container-doc-ecs-collapse M0 / AC-16:
// CYLINDER_GUID hand-roll deleted — replaced by engine builtin HANDLE_CYLINDER(handle=6)
// (plan-strategy §2 D-6; AGENTS.md #1 anti-pattern target)

interface PackAsset { guid: string; kind: string; payload: unknown; refs: string[] }
export interface ScenePack { schemaVersion: string; kind: 'internal-text-package'; assets: PackAsset[] }

/** Deterministic UUID-shaped string from a key (stable material GUIDs across
 *  saves). FNV-1a over four salted passes → 128 bits → 8-4-4-4-12 hex, with the
 *  version nibble forced to 5 and the variant bits to 0b10xx (RFC-valid shape). */
export function stableGuid(key: string): string {
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  };
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  const a = hex(fnv('a|' + key)), b = hex(fnv('b|' + key)), c = hex(fnv('c|' + key)), d = hex(fnv('d|' + key));
  const all = (a + b + c + d).slice(0, 32).split('');
  all[12] = '5';                                   // version 5
  all[16] = (parseInt(all[16]!, 16) & 0x3 | 0x8).toString(16); // variant 10xx
  const s = all.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** True if a parsed JSON object looks like a native scene pack (vs an EditSession). */
export function isScenePack(obj: unknown): obj is ScenePack {
  return !!obj && typeof obj === 'object' && (obj as { kind?: string }).kind === 'internal-text-package' && Array.isArray((obj as { assets?: unknown }).assets);
}