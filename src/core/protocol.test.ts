// @forgeax/editor/protocol — VAG_* schema unit tests (M1 w1, TDD red phase)
//
// 8 cross-realm zod schemas, 1 pass + 1 fail per type. Each fail case asserts
// `error.issues[0].path` hits a specific field name so the downstream consumer
// can present a structured error (plan-strategy §8).
//
// Anchors:
//   requirements §AC-03 (single-realm editor projection schemas retired in
//     favor of typed PanelBridge callbacks)
//   requirements §AC-05 (fail emits issues[].path)
//   plan-strategy §2 D-3 (single physical location: this file's sibling protocol.ts)
//   plan-strategy §8.1 (naming pair Vag<Name>Schema + Vag<Name>Message)
//   research F-6 (type literals real-world grep evidence)

import { describe, expect, test } from 'bun:test';

import {
  VagConsoleSchema,
  VagDeviceLostSchema,
  VagFpsStatsSchema,
  VagNetworkSchema,
  VagPreviewDisposeSchema,
  VagPreviewPauseSchema,
  VagPreviewPlaySchema,
  VagPreviewReloadSchema,
} from '../protocol';

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

describe('VAG_NETWORK', () => {
  test('pass: payload request summary accepted', () => {
    const r = VagNetworkSchema.safeParse({
      type: 'VAG_NETWORK',
      payload: { kind: 'fetch', method: 'GET', url: '/api/files', status: 200, ms: 12, ok: true, ts: 0 },
    });
    expect(r.success).toBe(true);
  });
  test('fail: payload.kind invalid literal → path includes "kind"', () => {
    const r = VagNetworkSchema.safeParse({
      type: 'VAG_NETWORK',
      payload: { kind: 'worker', method: 'GET', url: '/', status: 200, ms: 0, ok: true, ts: 0 },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('kind'))).toBe(true);
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

describe('schema completeness — all runtime schema exports present', () => {
  test('Object.keys(...).filter(endsWith("Schema")).length === 8', async () => {
    // 8 actual cross-realm schemas (7 in the union + VagNetworkSchema, which is
    // map-only). Single-realm editor projections live on typed PanelBridge.
    const mod = await import('../protocol');
    const schemaKeys = Object.keys(mod).filter((k) => k.endsWith('Schema'));
    expect(schemaKeys).toHaveLength(8);
  });
});
