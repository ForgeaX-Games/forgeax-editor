// scene-persistence-context — M1 equivalence safety net for the single-instance
// state convergence.
//
// M1 (plan-strategy D-2) collapses scene-persistence.ts's 7 module-level `let`
// singletons (currentSceneId / currentSceneFile / sceneList / currentSceneGuid /
// currentSceneRoot / asyncOpResult / isDirty) into ONE explicit
// `ScenePersistenceContext` object reached via a single `ctx` handle. The two
// cross-module reverse-writes disk-watch used to make through the exported
// `_setCurrentSceneGuid` / `_setDirty` setter pair (over `export let`
// live-bindings) now route through `ctx.setCurrentSceneGuid` / `ctx.setDirty`
// on the SAME live handle.
//
// §5.1: M1 is a pure structural move, exempt from red-green; this test is its
// equivalence safety net instead. It pins the post-convergence contract:
//   - a single ScenePersistenceContext handle with the 7 fields at their
//     historical initial values (OOS-1: zero behavior change);
//   - the disk-watch reverse-write path (setDirty / setCurrentSceneGuid) is
//     semantically identical to the deleted setters — a write via the method is
//     observed through the SAME live handle (not a snapshot), and via the public
//     read seam (hasPendingDiskSave) cross-module;
//   - the old `export let currentSceneGuid` / `export let _isDirty` + the
//     `_setDirty` / `_setCurrentSceneGuid` setter pair are gone (AC-01: no
//     module-level mutable singleton for persistence state).
//
// Headless: no network, no rAF, no real gateway.doc IO — every assertion
// touches only in-memory ctx state + the pure public read seam
// (hasPendingDiskSave / cancelPendingDiskSave), matching AC-02 (headless-testable
// form) and AC-05 (equivalence precondition for the M1 regression gate).
//
// Anchors:
//   (forward) plan-strategy feat-20260709-editor-large-file-di-decompose-wave2-c-domain-scen
//     plan-id; AC-01 (7 singletons -> explicit context, grep 0) + AC-02
//     (headless testable) + AC-05 (M1 equivalence gate); plan-strategy §2 D-2.
//   (backward) source scene-persistence.ts, split out by historical feat
//     feat-20260705-editor-core-engine-convergence-store-ts-decompose (store.ts
//     1344 -> 14 files; scene-persistence.ts 1032 is the debt this loop retires).

import { describe, expect, it, beforeEach } from 'bun:test';
import * as sp from '../store/scene-persistence';

describe('ScenePersistenceContext — single-instance state convergence (M1 / D-2)', () => {
  it('exposes a factory + a single ctx handle (AC-01)', () => {
    expect(typeof sp.createScenePersistenceContext).toBe('function');
    expect(sp.ctx).toBeDefined();
  });

  it('a fresh context carries the 7 fields at their historical initial values (OOS-1)', () => {
    const fresh = sp.createScenePersistenceContext();
    expect(fresh.currentSceneId).toBe('default');
    expect(fresh.currentSceneFile).toBeNull();
    expect(fresh.sceneList).toEqual([]);
    expect(fresh.currentSceneGuid).toBeNull();
    expect(fresh.currentSceneRoot).toBeNull();
    expect(fresh.asyncOpResult).toBeNull();
    expect(fresh.isDirty).toBe(false);
  });

  it('the old export let singletons + setter pair are gone (AC-01)', () => {
    // The pre-M1 mechanism: `export let currentSceneGuid` / `export let _isDirty`
    // read cross-module + `_setCurrentSceneGuid` / `_setDirty` written cross-module.
    // Convergence deletes all four exports; state lives on ctx now.
    expect('currentSceneGuid' in sp).toBe(false);
    expect('_isDirty' in sp).toBe(false);
    expect('_setDirty' in sp).toBe(false);
    expect('_setCurrentSceneGuid' in sp).toBe(false);
  });
});

describe('disk-watch reverse-write equivalence — same live handle (D-6 seam)', () => {
  beforeEach(() => {
    // Reset the shared handle to a clean state before each case (isolated,
    // idempotent — charter §6). No IO, no rAF.
    sp.ctx.setDirty(false);
  });

  it('setDirty toggles isDirty on the SAME live handle (not a snapshot)', () => {
    const ref = sp.ctx; // capture the handle a cross-module consumer would hold
    sp.ctx.setDirty(true);
    expect(ref.isDirty).toBe(true); // observed through the captured handle
    sp.ctx.setDirty(false);
    expect(ref.isDirty).toBe(false);
  });

  it('setDirty is read back through the public seam cross-module (hasPendingDiskSave)', () => {
    // hasPendingDiskSave is the toolbar's dirty-indicator read; it must reflect a
    // ctx.setDirty write — the equivalence with the deleted _setDirty setter that
    // disk-watch called after an external reload.
    sp.ctx.setDirty(true);
    expect(sp.hasPendingDiskSave()).toBe(true);
    sp.ctx.setDirty(false);
    expect(sp.hasPendingDiskSave()).toBe(false);
  });

  it('cancelPendingDiskSave clears isDirty on the same handle', () => {
    sp.ctx.setDirty(true);
    expect(sp.hasPendingDiskSave()).toBe(true);
    sp.cancelPendingDiskSave();
    expect(sp.ctx.isDirty).toBe(false);
    expect(sp.hasPendingDiskSave()).toBe(false);
  });

  it('setCurrentSceneGuid writes the guid onto the same live handle', () => {
    const ref = sp.ctx;
    sp.ctx.setCurrentSceneGuid('guid-equivalence-xyz');
    expect(ref.currentSceneGuid).toBe('guid-equivalence-xyz');
    // reset so the shared handle does not leak a guid into later suites
    sp.ctx.currentSceneGuid = null;
  });
});
