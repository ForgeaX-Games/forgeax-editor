// entity-state — missing-world Fail Soft (cross-game switch gap)
//
// Studio single-realm teardown clears gateway.doc.world before the next createApp
// injects. Hierarchy Rows that still hold stale fiber props must not throw on
// `undefined.get(...)`. See:
//   docs/superpowers/specs/2026-07-14-hierarchy-cross-game-switch-crash-design.md
import { describe, it, expect } from 'bun:test';
import {
  childrenOf,
  entExists,
  entName,
  entParent,
  entComponent,
  entComponents,
  worldEntityHandles,
  worldRootHandles,
} from '@forgeax/editor-core';
import type { EntityHandle } from '@forgeax/editor-core';

const NO_WORLD = undefined as unknown as Parameters<typeof entExists>[0];
const HANDLE = 1 as EntityHandle;

describe('entity-state missing-world guards (cross-game gap)', () => {
  it('entExists → false', () => {
    expect(entExists(NO_WORLD, HANDLE)).toBe(false);
  });

  it('entName → #<handle> fallback', () => {
    expect(entName(NO_WORLD, HANDLE)).toBe('#1');
  });

  it('entParent → null', () => {
    expect(entParent(NO_WORLD, HANDLE)).toBeNull();
  });

  it('entComponents → {}', () => {
    expect(entComponents(NO_WORLD, HANDLE)).toEqual({});
  });

  it('entComponent → stale-entity-handle (structured)', () => {
    const r = entComponent(NO_WORLD, HANDLE, 'Transform');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('stale-entity-handle');
      expect(r.error.entity).toBe(HANDLE);
    }
  });

  it('worldEntityHandles / worldRootHandles / childrenOf → []', () => {
    expect(worldEntityHandles(NO_WORLD)).toEqual([]);
    expect(worldRootHandles(NO_WORLD)).toEqual([]);
    expect(childrenOf(NO_WORLD, null)).toEqual([]);
    expect(childrenOf(NO_WORLD, HANDLE)).toEqual([]);
  });
});
