// w30 — hot-reload two-tier branch tests (TDD red stage).
//
// Edit-mode hot reload (plan-strategy D-8) decides between two tiers when a
// gameplay/structure script is re-imported:
//   • same component schema fingerprint (tuning params / system-logic only)
//       → KEEP the world, incrementally update systems (entities untouched)
//   • different component schema fingerprint (a field added/removed/retyped)
//       → DISCARD the world, re-instantiate from the SceneAsset (A0' world is
//         disposable; OOS-7 edit-mode hot reload rebuilds, no fine-grained
//         unload — OOS-8)
//
// The fingerprint judge is the engine `component.toSchemaJSON()` snapshot over
// `getRegisteredComponents()` (research Finding 1: toSchemaJSON @
// component.ts:660). This test pins the PURE tier-decision logic that the
// edit-runtime hot-reload orchestrator (w37) consumes.
//
// Anchors:
//   plan-tasks.json w30: hot-reload two-tier branch unit test
//   requirements AC-15: toSchemaJSON snapshot fingerprint drives the two tiers
//   plan-strategy D-8: same snapshot → in-place update; different → rebuild
//   OOS-7 / OOS-8: no Play-mode runtime hot reload; no fine-grained unload

import { describe, expect, it } from 'bun:test';

import { schemaFingerprint, decideReloadTier } from '../hot-reload';

// A minimal stand-in for the engine `Component` token surface the fingerprint
// reads: just `toSchemaJSON()`. We model schema changes by changing the JSON it
// returns.
function comp(schema: Record<string, unknown>): { toSchemaJSON(): string } {
  return { toSchemaJSON: () => JSON.stringify(schema) };
}

describe('schemaFingerprint — snapshot over registered components', () => {
  it('is stable for the same component set + schemas (order-independent)', () => {
    const a = new Map([
      ['Transform', comp({ posX: 'f32', posY: 'f32' })],
      ['Mesh', comp({ kind: 'string' })],
    ]);
    const b = new Map([
      ['Mesh', comp({ kind: 'string' })],
      ['Transform', comp({ posX: 'f32', posY: 'f32' })],
    ]);
    // Insertion order differs but the fingerprint must be identical.
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
  });

  it('empty component list yields a stable empty fingerprint', () => {
    const empty = new Map<string, { toSchemaJSON(): string }>();
    expect(schemaFingerprint(empty)).toBe(schemaFingerprint(new Map()));
  });
});

describe('decideReloadTier — same fingerprint keeps the world', () => {
  it('tuning a param (no schema change) → world-update', () => {
    const before = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32' })]]));
    // System logic / numeric defaults changed but the component SCHEMA is
    // identical → fingerprint unchanged → keep the world.
    const after = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32' })]]));
    expect(before).toBe(after);
    expect(decideReloadTier(before, after)).toBe('world-update');
  });

  it('only a default value changed (schema shape unchanged) → world-update', () => {
    // toSchemaJSON serializes the schema SHAPE (field → type), not runtime
    // default scalar values; changing a default leaves the fingerprint equal.
    const before = schemaFingerprint(new Map([['Speed', comp({ value: 'f32' })]]));
    const after = schemaFingerprint(new Map([['Speed', comp({ value: 'f32' })]]));
    expect(decideReloadTier(before, after)).toBe('world-update');
  });
});

describe('decideReloadTier — different fingerprint rebuilds the world', () => {
  it('adding a field → world-rebuild', () => {
    const before = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32' })]]));
    const after = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32', posY: 'f32' })]]));
    expect(before).not.toBe(after);
    expect(decideReloadTier(before, after)).toBe('world-rebuild');
  });

  it('removing a field → world-rebuild', () => {
    const before = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32', posY: 'f32' })]]));
    const after = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32' })]]));
    expect(decideReloadTier(before, after)).toBe('world-rebuild');
  });

  it('changing a field type → world-rebuild', () => {
    const before = schemaFingerprint(new Map([['Hp', comp({ value: 'f32' })]]));
    const after = schemaFingerprint(new Map([['Hp', comp({ value: 'u32' })]]));
    expect(before).not.toBe(after);
    expect(decideReloadTier(before, after)).toBe('world-rebuild');
  });

  it('adding a whole new component → world-rebuild', () => {
    const before = schemaFingerprint(new Map([['Transform', comp({ posX: 'f32' })]]));
    const after = schemaFingerprint(
      new Map([
        ['Transform', comp({ posX: 'f32' })],
        ['Velocity', comp({ vx: 'f32' })],
      ]),
    );
    expect(decideReloadTier(before, after)).toBe('world-rebuild');
  });
});
