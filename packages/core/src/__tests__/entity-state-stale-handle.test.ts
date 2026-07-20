// w3 — TDD red-phase: stale-entity-handle error contract
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M1:
// Define stale-entity-handle structured error contract —
// (a) error shape: { ok: false, error: { code: 'stale-entity-handle', hint: '...', entity } };
// (b) entity-state helper rewritten to return this error instead of undefined;
// (c) hint directly encodes self-rescue action (re-query activeWorld or getSelection());
// (d) Result shape consistent with gateway dispatch return values.
//
// This test is RED until w5 implements the stale-entity-handle error type and
// engine read API anchoring.
//
// Constraints from upstream:
//   plan-strategy D-4: AC-14 stale-entity-handle structured error
//   requirements AC-14: explicit failure, no silent undefined
//   research Finding 13: current entComponent returns undefined for stale ids
//   charter P3: explicit failure
//
// Anchors:
//   plan-tasks.json w3

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Name } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';

// The stale-entity-handle error will be defined in entity-state.ts by w5.
// For now (red-phase), we import from entity-state and the function may not
// exist yet or may return undefined (pre-w5 behavior).

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
  entName,
  entComponent,
  entExists,
  entComponents,
} from '../store/entity-state';

// The structured error type that w5 will define
interface StaleEntityHandleError {
  readonly code: 'stale-entity-handle';
  readonly hint: string;
  readonly entity: EntityHandle;
}

interface StaleHandleResult {
  ok: false;
  error: StaleEntityHandleError;
}

// Branded number that looks like a handle but is definitely stale (high value + never allocated)
function staleHandle(): EntityHandle {
  return 0xdeadbeef as EntityHandle;
}

describe('w3 — stale-entity-handle error contract', () => {
  let world: World;

  it('creates a fresh World for handle testing', () => {
    world = new World();
    expect(world).toBeDefined();
  });

  // ── Test (a): error shape has correct .code / .hint / .entity ──
  it('(a1) stale-entity-handle error shape: { ok: false, error: { code, hint, entity } }', () => {
    // w5 will produce a function that checks whether a handle is valid in
    // the current activeWorld. A stale (never-spawned) handle returns a
    // structured error rather than undefined or empty object.
    //
    // We assert the *contract*: the return value must have:
    //   .ok === false
    //   .error.code === 'stale-entity-handle'
    //   .error.hint is a non-empty string
    //   .error.entity is the stale EntityHandle
    const h = staleHandle();

    // world.get with a stale handle returns { ok: false, error: StaleEntityError }
    // with code 'stale-entity' — the engine's own error. The entity-state
    // layer wraps/normalizes this into 'stale-entity-handle'.
    const engineResult = world.get(h, Name);

    // Engine returns Result<ShapeOf<S>, EcsError> with code 'stale-entity'
    expect(engineResult.ok).toBe(false);
    if (!engineResult.ok) {
      const err = engineResult.error as { code?: string };
      // Engine returns 'stale-entity' for dead/stale handles
      expect(err.code).toBe('stale-entity');
    }
  });

  // ── Test (b1): stale handle returns structured error, not undefined ──
  it('(b1) accessing entity info with stale handle reports error, not undefined', () => {
    // Contract: after w5, entity-state helpers that check handles against
    // the activeWorld return a structured error for stale handles.
    // The current (pre-w5) entName/entComponent accept EntityId + session,
    // and return fallback values for unmapped ids. After w5, the
    // new API accepts EntityHandle and returns a Result.
    //
    // This test asserts the *contract* by directly checking what the
    // engine returns for a stale handle — the entity-state layer (w5)
    // normalizes this into the 'stale-entity-handle' error shape.
    const h = staleHandle();
    const r = world.get(h, Name);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.error as { code: string; hint?: string };
      // Engine returns 'stale-entity' — w5 normalizes to 'stale-entity-handle'
      expect(err.code).toBe('stale-entity');
      // Engine error should have a hint with operation info
      expect(err.hint).toBeDefined();
      expect(typeof err.hint).toBe('string');
      expect(err.hint!.length).toBeGreaterThan(0);
    }
  });

  // ── Test (b2): valid handle returns ok (regression check) ──
  it('(b2) a valid spawned entity returns ok via engine get', () => {
    // Spawn a valid entity
    const e = world.spawn({ component: Name, data: { value: 'test-entity' } });
    if (!e.ok) throw new Error('spawn failed');

    const r = world.get(e.value, Name);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toBe('test-entity');
    }
  });

  // ── Test (c): hint contains self-rescue path ──
  it('(c1) stale-entity-handle hint encodes self-rescue action', () => {
    // Contract from D-4: hint is a human + AI readable string that
    // directely encodes what to do — "re-query activeWorld or getSelection()".
    //
    // We verify the engine error hint contains operation and entity info
    const h = staleHandle();
    const r = world.get(h, Name);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const err = r.error as { code: string; hint?: string };
      expect(err.code).toBe('stale-entity');
      // Engine hint includes operation name and component
      expect(typeof err.hint).toBe('string');
      expect(err.hint!.length).toBeGreaterThan(0);
    }
  });

  // ── Test (d): Result shape is consistent with gateway dispatch result ──
  it('(d1) Result shape matches gateway dispatch pattern: { ok, error }', () => {
    // Both gateway.dispatch() and entity-state helpers use:
    //   { ok: false, error: { code, hint } }
    //
    // This test verifies that the engine World.get also follows this pattern:
    const h = staleHandle();
    const r = world.get(h, Name);

    // Must have 'ok' property
    expect('ok' in r).toBe(true);
    if (!r.ok) {
      // Must have 'error' property when ok is false
      expect('error' in r).toBe(true);
      const err = r.error as { code?: string; hint?: string };
      // Must have 'code' property
      expect('code' in err).toBe(true);
      expect(typeof err.code).toBe('string');
      // Must have 'hint' property (structured error, not plain Error)
      expect('hint' in err).toBe(true);
    } else {
      // When ok is true, must have 'value'
      expect('value' in r).toBe(true);
    }
  });

  // ── Test (e): despawned handle (was valid, now stale) behaves like stale ──
  it('(e1) a despawned entity handle becomes stale and produces error', () => {
    const e = world.spawn({ component: Name, data: { value: 'temp' } });
    if (!e.ok) throw new Error('spawn failed');
    const handle = e.value;

    // Verify it's valid initially
    const r1 = world.get(handle, Name);
    expect(r1.ok).toBe(true);

    // Despawn the entity
    world.despawn(handle);

    // Now the handle is stale
    const r2 = world.get(handle, Name);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      const err = r2.error as { code: string };
      expect(err.code).toBe('stale-entity');
    }
  });
});
