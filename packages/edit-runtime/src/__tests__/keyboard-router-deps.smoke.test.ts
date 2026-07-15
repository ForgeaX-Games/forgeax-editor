// Shape-completeness guard for the shared keyboard-router deps builder.
//
// buildKeyboardRouterDeps is the SSOT both editor hosts (standalone +
// studio) feed into interface's registerKeyboardRouterDeps. The interface router
// destructures a FIXED set of 17 callbacks; a dropped/renamed field would silently
// disable one keyboard gesture (e.g. the G/Esc display-toggle — the very
// regression this extraction fixes). This test pins the exact field set so a
// future edit that drops one fails here at unit time rather than in the running
// editor.
import { afterEach, describe, it, expect } from 'bun:test';
import { buildKeyboardRouterDeps } from '../keyboard-router-deps';
import { setViewportQuadrant } from '../viewport/viewport-quadrant';

const EXPECTED_KEYS = [
  'dispatch',
  'getEntitySelection',
  'getAssetSelection',
  'getLastSelectionDomain',
  'isPlayMode',
  'getDisplay',
  'getInputTarget',
  'deleteEntities',
  'duplicateEntities',
  'renameEntity',
  'selectAllEntities',
  'deleteAssets',
  'duplicateAsset',
  'renameAsset',
  'selectAllAssets',
  'getFolderSelection',
  'deleteFolders',
] as const;

describe('buildKeyboardRouterDeps — router dep shape (keyboard-router convergence)', () => {
  afterEach(() => setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' }));

  it('returns exactly the 17 interface KeyboardRouterDeps callbacks', () => {
    const deps = buildKeyboardRouterDeps({ confirmDeleteAssets: async () => true });
    const rec = deps as unknown as Record<string, unknown>;
    for (const k of EXPECTED_KEYS) {
      expect(typeof rec[k]).toBe('function');
    }
    // Exact set — no missing, no extra (extra would mean an interface-side field
    // added without updating this guard; missing means a dropped gesture).
    expect(Object.keys(deps).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('derives Play from the viewport quadrant, not the edit gateway mode', () => {
    setViewportQuadrant({ run: 'play', display: 'game', control: 'editor' });
    const deps = buildKeyboardRouterDeps({ confirmDeleteAssets: async () => true });
    expect(deps.isPlayMode()).toBe(true);
    setViewportQuadrant({ run: 'edit', display: 'scene', control: 'editor' });
  });
});
