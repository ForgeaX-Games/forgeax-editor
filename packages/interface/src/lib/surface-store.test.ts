/**
 * Phase D2 — surface-store coverage. Pure module, no DOM needed.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  upsertSurface,
  removeExtensionSurfaces,
  listSurfaces,
  getSurface,
  subscribeSurfaces,
  _resetSurfaceStoreForTests,
} from './surface-store';

beforeEach(() => {
  _resetSurfaceStoreForTests();
});

describe('surface-store', () => {
  it('starts empty', () => {
    expect(listSurfaces()).toEqual([]);
  });

  it('upsert + get + list round-trip', () => {
    upsertSurface({
      extensionId: '@x/p',
      surfaceId: 'main',
      actions: [{ id: 'save', enabled: true }],
      snapshot: { count: 0 },
      updatedAt: 0,
    });
    expect(listSurfaces()).toHaveLength(1);
    const s = getSurface('@x/p', 'main')!;
    expect(s.surfaceId).toBe('main');
    expect(s.actions[0].id).toBe('save');
    expect(s.updatedAt).toBeGreaterThan(0); // upsert stamps Date.now()
  });

  it('upsert replaces existing entry by composite key', () => {
    upsertSurface({ extensionId: 'p', surfaceId: 's', actions: [], snapshot: 1, updatedAt: 0 });
    upsertSurface({ extensionId: 'p', surfaceId: 's', actions: [], snapshot: 2, updatedAt: 0 });
    expect(listSurfaces()).toHaveLength(1);
    expect(getSurface('p', 's')!.snapshot).toBe(2);
  });

  it('removeExtensionSurfaces drops only matching plugin', () => {
    upsertSurface({ extensionId: 'p1', surfaceId: 's', actions: [], snapshot: null, updatedAt: 0 });
    upsertSurface({ extensionId: 'p2', surfaceId: 's', actions: [], snapshot: null, updatedAt: 0 });
    removeExtensionSurfaces('p1');
    expect(listSurfaces().map((s) => s.extensionId)).toEqual(['p2']);
  });

  it('subscribe fires on upsert and remove', () => {
    let calls = 0;
    const off = subscribeSurfaces(() => { calls++; });
    upsertSurface({ extensionId: 'p', surfaceId: 's', actions: [], snapshot: null, updatedAt: 0 });
    upsertSurface({ extensionId: 'p', surfaceId: 's2', actions: [], snapshot: null, updatedAt: 0 });
    removeExtensionSurfaces('p');
    off();
    upsertSurface({ extensionId: 'q', surfaceId: 's', actions: [], snapshot: null, updatedAt: 0 });
    expect(calls).toBe(3); // post-unsub upsert ignored
  });

  it('subscribe listener crash does not break fanout', () => {
    let okCalls = 0;
    subscribeSurfaces(() => { throw new Error('boom'); });
    subscribeSurfaces(() => { okCalls++; });
    upsertSurface({ extensionId: 'p', surfaceId: 's', actions: [], snapshot: null, updatedAt: 0 });
    expect(okCalls).toBe(1);
  });

  it('removeExtensionSurfaces with no match does not fire listeners', () => {
    let calls = 0;
    subscribeSurfaces(() => { calls++; });
    removeExtensionSurfaces('nonexistent');
    expect(calls).toBe(0);
  });
});
