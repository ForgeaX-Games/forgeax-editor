// @forgeax/editor/protocol — VAG_* schema unit tests (M1 w1, TDD red phase)
//
// 16 zod schemas, 1 pass + 1 fail per type (≥ 32 assertions). Each fail
// case asserts `error.issues[0].path` hits a specific field name so the
// downstream consumer can present a structured error (plan-strategy §8).
//
// Anchors:
//   requirements §AC-03 (16 schemas exist)
//   requirements §AC-05 (fail emits issues[].path)
//   plan-strategy §2 D-3 (single physical location: this file's sibling protocol.ts)
//   plan-strategy §8.1 (naming pair Vag<Name>Schema + Vag<Name>Message)
//   research F-6 (16 type literals real-world grep evidence)

import { describe, expect, test } from 'bun:test';

import {
  VagAssetsChangedSchema,
  VagConsoleSchema,
  VagContextMenuSchema,
  VagContextMenuActionSchema,
  VagDeviceLostSchema,
  VagEditorFlushSchema,
  VagEditorOpenSourceSchema,
  VagEditorPopoutSchema,
  VagEditorRedockSchema,
  VagEditorRefSchema,
  VagFpsStatsSchema,
  VagPreviewDisposeSchema,
  VagPreviewPauseSchema,
  VagPreviewPlaySchema,
  VagPreviewReloadSchema,
  VagSpawnEntitySchema,
} from '../protocol';

describe('VAG_ASSETS_CHANGED', () => {
  test('pass: { type, payload: { slug } } accepted (slug-bearing form)', () => {
    const r = VagAssetsChangedSchema.safeParse({ type: 'VAG_ASSETS_CHANGED', payload: { slug: 'demo' } });
    expect(r.success).toBe(true);
  });
  test('pass: { type } only accepted (relay-ping form, no payload)', () => {
    // editor-runtime/store.ts emits a payload-less ping when relaying
    // BroadcastChannel asset-changed events. Schema must accept this too.
    const r = VagAssetsChangedSchema.safeParse({ type: 'VAG_ASSETS_CHANGED' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagAssetsChangedSchema.safeParse({ type: 'VAG_ASSETS_REPLACED' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_CONSOLE', () => {
  test('pass: payload { level, text, ts } accepted', () => {
    const r = VagConsoleSchema.safeParse({
      type: 'VAG_CONSOLE',
      payload: { level: 'log', text: 'hello', ts: 1717000000000 },
    });
    expect(r.success).toBe(true);
  });
  test('fail: payload.text wrong type → path includes "text"', () => {
    const r = VagConsoleSchema.safeParse({
      type: 'VAG_CONSOLE',
      payload: { level: 'log', text: 42, ts: 0 },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('text'))).toBe(true);
    }
  });
});

describe('VAG_CONTEXT_MENU', () => {
  test('pass: flat shape { type, menuId, x, y, items } accepted', () => {
    const r = VagContextMenuSchema.safeParse({
      type: 'VAG_CONTEXT_MENU',
      menuId: 'em-1',
      x: 10,
      y: 20,
      items: [{ id: 'i0', label: 'Copy' }, { sep: true }],
    });
    expect(r.success).toBe(true);
  });
  test('fail: missing menuId → path includes "menuId"', () => {
    const r = VagContextMenuSchema.safeParse({
      type: 'VAG_CONTEXT_MENU',
      x: 0,
      y: 0,
      items: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('menuId'))).toBe(true);
    }
  });
});

describe('VAG_CONTEXT_MENU_ACTION', () => {
  test('pass: flat shape { type, menuId, actionId } accepted', () => {
    const r = VagContextMenuActionSchema.safeParse({
      type: 'VAG_CONTEXT_MENU_ACTION',
      menuId: 'em-1',
      actionId: 'i0',
    });
    expect(r.success).toBe(true);
  });
  test('fail: missing actionId → path includes "actionId"', () => {
    const r = VagContextMenuActionSchema.safeParse({
      type: 'VAG_CONTEXT_MENU_ACTION',
      menuId: 'em-1',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('actionId'))).toBe(true);
    }
  });
});

describe('VAG_DEVICE_LOST', () => {
  test('pass: { type } only', () => {
    const r = VagDeviceLostSchema.safeParse({ type: 'VAG_DEVICE_LOST' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagDeviceLostSchema.safeParse({ type: 'VAG_DEVICE_FOUND' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_EDITOR_FLUSH', () => {
  test('pass: { type } only', () => {
    const r = VagEditorFlushSchema.safeParse({ type: 'VAG_EDITOR_FLUSH' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagEditorFlushSchema.safeParse({ type: 'VAG_EDITOR_FLUSHED' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_EDITOR_OPEN_SOURCE', () => {
  test('pass: payload { plugin, docId? } accepted', () => {
    const r = VagEditorOpenSourceSchema.safeParse({
      type: 'VAG_EDITOR_OPEN_SOURCE',
      payload: { plugin: 'wb-narrative', docId: 'd-1' },
    });
    expect(r.success).toBe(true);
  });
  test('fail: payload.plugin wrong type → path includes "plugin"', () => {
    const r = VagEditorOpenSourceSchema.safeParse({
      type: 'VAG_EDITOR_OPEN_SOURCE',
      payload: { plugin: 42 },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('plugin'))).toBe(true);
    }
  });
});

describe('VAG_EDITOR_POPOUT', () => {
  test('pass: payload { panel, scene?, title?, geom? } accepted', () => {
    const r = VagEditorPopoutSchema.safeParse({
      type: 'VAG_EDITOR_POPOUT',
      payload: { panel: 'inspector', scene: 'demo', title: 'Inspector', geom: { x: 0, y: 0, w: 420, h: 640 } },
    });
    expect(r.success).toBe(true);
  });
  test('fail: missing payload.panel → path includes "panel"', () => {
    const r = VagEditorPopoutSchema.safeParse({
      type: 'VAG_EDITOR_POPOUT',
      payload: {},
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('panel'))).toBe(true);
    }
  });
});

describe('VAG_EDITOR_REDOCK', () => {
  test('pass: payload { panel } accepted', () => {
    const r = VagEditorRedockSchema.safeParse({
      type: 'VAG_EDITOR_REDOCK',
      payload: { panel: 'assets' },
    });
    expect(r.success).toBe(true);
  });
  test('fail: missing payload.panel → path includes "panel"', () => {
    const r = VagEditorRedockSchema.safeParse({
      type: 'VAG_EDITOR_REDOCK',
      payload: {},
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('panel'))).toBe(true);
    }
  });
});

describe('VAG_EDITOR_REF', () => {
  test('pass: entity-kind payload accepted', () => {
    const r = VagEditorRefSchema.safeParse({
      type: 'VAG_EDITOR_REF',
      payload: { kind: 'entity', id: 7, name: 'Player', components: ['Transform'] },
    });
    expect(r.success).toBe(true);
  });
  test('fail: payload.kind invalid literal → path includes "kind"', () => {
    const r = VagEditorRefSchema.safeParse({
      type: 'VAG_EDITOR_REF',
      payload: { kind: 'unknown' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('kind'))).toBe(true);
    }
  });
});

describe('VAG_FPS_STATS', () => {
  test('pass: payload { fps } accepted', () => {
    const r = VagFpsStatsSchema.safeParse({ type: 'VAG_FPS_STATS', payload: { fps: 60 } });
    expect(r.success).toBe(true);
  });
  test('fail: payload.fps wrong type → path includes "fps"', () => {
    const r = VagFpsStatsSchema.safeParse({ type: 'VAG_FPS_STATS', payload: { fps: 'sixty' } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('fps'))).toBe(true);
    }
  });
});

describe('VAG_PREVIEW_DISPOSE', () => {
  test('pass: { type } only', () => {
    const r = VagPreviewDisposeSchema.safeParse({ type: 'VAG_PREVIEW_DISPOSE' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagPreviewDisposeSchema.safeParse({ type: 'VAG_PREVIEW_DESTROY' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_PREVIEW_PAUSE', () => {
  test('pass: { type } only', () => {
    const r = VagPreviewPauseSchema.safeParse({ type: 'VAG_PREVIEW_PAUSE' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagPreviewPauseSchema.safeParse({ type: 'VAG_PREVIEW_HALT' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_PREVIEW_PLAY', () => {
  test('pass: { type } only', () => {
    const r = VagPreviewPlaySchema.safeParse({ type: 'VAG_PREVIEW_PLAY' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagPreviewPlaySchema.safeParse({ type: 'VAG_PREVIEW_RESUME' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_PREVIEW_RELOAD', () => {
  test('pass: { type } only', () => {
    const r = VagPreviewReloadSchema.safeParse({ type: 'VAG_PREVIEW_RELOAD' });
    expect(r.success).toBe(true);
  });
  test('fail: wrong type literal → path includes "type"', () => {
    const r = VagPreviewReloadSchema.safeParse({ type: 'VAG_PREVIEW_REFRESH' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('type'))).toBe(true);
    }
  });
});

describe('VAG_SPAWN_ENTITY', () => {
  test('pass: payload { mode, entity?, doc?, name? } accepted', () => {
    const r = VagSpawnEntitySchema.safeParse({
      type: 'VAG_SPAWN_ENTITY',
      payload: { mode: 'reference', entity: { name: 'Cube', components: {} }, name: 'Cube' },
    });
    expect(r.success).toBe(true);
  });
  test('fail: payload.mode invalid literal → path includes "mode"', () => {
    const r = VagSpawnEntitySchema.safeParse({
      type: 'VAG_SPAWN_ENTITY',
      payload: { mode: 'partial' },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('mode'))).toBe(true);
    }
  });
});

describe('schema completeness — all 16 exports present', () => {
  test('Object.keys(...).filter(endsWith("Schema")).length === 16', async () => {
    const mod = await import('../protocol');
    const schemaKeys = Object.keys(mod).filter((k) => k.endsWith('Schema'));
    expect(schemaKeys).toHaveLength(16);
  });
});
