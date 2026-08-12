import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { validateGameProject } from '../game-validation.mjs';

const sceneGuid = '11111111-1111-5111-8111-111111111111';
const cubeGuid = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-j5-validation-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'main.ts'), 'export function bootstrap() {}\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ forgeax: { assets: { roots: ['assets'] } } }));
  writeFileSync(join(root, 'forge.json'), JSON.stringify({
    id: 'fixture', name: 'fixture', schemaVersion: '1.0.0', entry: 'main.ts', defaultScene: sceneGuid,
    ...overrides.manifest,
  }));
  writeFileSync(join(root, 'assets', 'scene.pack.json'), JSON.stringify({
    schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [{
      guid: sceneGuid, kind: 'scene', refs: [cubeGuid], payload: {
        entities: [{ localId: 0, components: { Transform: { pos: [0, 0, 0] } } }],
      },
    }],
  }));
  if (overrides.pack) writeFileSync(join(root, 'assets', 'scene.pack.json'), JSON.stringify(overrides.pack));
  if (overrides.sidecar) writeFileSync(join(root, 'assets', 'orphan.glb.meta.json'), JSON.stringify(overrides.sidecar));
  return root;
}

function codes(result) { return result.blocking.map((entry) => entry.code); }

describe('J5 game validation', () => {
  test('accepts a valid project', () => {
    const root = fixture();
    try {
      const result = validateGameProject(root);
      expect(result.ok).toBe(true);
      expect(result.stats.entities).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('locates missing references', () => {
    const root = fixture({ pack: {
      schemaVersion: '2.0.0', kind: 'internal-text-package', assets: [{
        guid: sceneGuid, kind: 'scene', refs: ['22222222-2222-5222-8222-222222222222'],
        payload: { entities: [] },
      }],
    } });
    try { expect(codes(validateGameProject(root))).toContain('missing-reference'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('locates orphan sidecars', () => {
    const root = fixture({ sidecar: { kind: 'external-asset-package', importer: 'gltf', source: 'missing.glb', subAssets: [] } });
    try { expect(codes(validateGameProject(root))).toContain('orphan-sidecar'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('locates unserializable pack shells and missing entries', () => {
    const root = fixture({ manifest: { entry: 'missing.ts' }, pack: { nope: true } });
    try {
      const found = codes(validateGameProject(root));
      expect(found).toContain('missing-entry');
      expect(found).toContain('unserializable-component');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('locates budget overruns', () => {
    const root = fixture();
    try { expect(codes(validateGameProject(root, { maxBytes: 1 }))).toContain('budget-overrun'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
