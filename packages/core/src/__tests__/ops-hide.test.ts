// ops-hide.test.ts — engine Visibility hide gestures
//
// Locks the shared core ops behind H / Ctrl+H / Shift+H and the Hierarchy eye:
//   1. hideMany / setVisibilityMany wrap multi-entity hides in ONE transaction
//      (one undo step) and skip entities already in the target state
//   2. showAllHidden changes every explicit hidden Visibility intent as one undo step
//   3. hideUnselected isolates the selection: selected entities AND their
//      ancestors stay visible, everything else hides
//   4. effective descendant hiding comes from the engine Visibility resolver;
//      the editor does not materialize Disabled markers
//
// All ops route through the singleton gateway's one dispatch door — these tests
// never call applyCommand directly (north-star §3.2).

import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { createEditSession } from '../session/document';
import { gateway } from '../store/store';
import { hideMany, hideUnselected, setVisibilityMany, showAllHidden } from '../session/ops';
import { Visibility, VisibilityStateValue, readVisibilityIntent, resolveVisibility } from '../visibility';
import { worldEntityHandles } from '../store/entity-state';
import type { EditorOp, EditSession } from '../types';
import type { EntityHandle } from '../scene/scene-types';

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawn(name: string, parent?: number): EntityHandle {
  const cmd: EditorOp = {
    kind: 'spawnEntity',
    name,
    ...(parent !== undefined ? { parent } : {}),
    components: { Transform: { pos: [0, 0, 0] } },
  };
  const r = gateway.dispatch(cmd);
  if (!r.ok) throw new Error('spawn failed');
  return (cmd as unknown as { _id: number })._id as EntityHandle;
}

function hidden(h: EntityHandle): boolean {
  return readVisibilityIntent(gateway.activeWorld, h) === 'hidden';
}

describe('hide ops (UE parity §1)', () => {
  beforeEach(() => {
    gateway.replaceDoc(createSession());
  });

  it('hideMany sets explicit Visibility intent, ONE undo restores all', () => {
    const a = spawn('A');
    const b = spawn('B');
    hideMany([a, b]);
    expect(hidden(a)).toBe(true);
    expect(hidden(b)).toBe(true);
    const aVisibility = gateway.activeWorld.get(a, Visibility);
    const bVisibility = gateway.activeWorld.get(b, Visibility);
    expect(aVisibility.ok).toBe(true);
    expect(bVisibility.ok).toBe(true);
    if (aVisibility.ok) expect(aVisibility.value.state).toBe(VisibilityStateValue.hidden);
    if (bVisibility.ok) expect(bVisibility.value.state).toBe(VisibilityStateValue.hidden);

    // Multi-entity gesture = ONE transaction = ONE undo step (deleteMany parity).
    expect(gateway.undo()).toBe(true);
    expect(hidden(a)).toBe(false);
    expect(hidden(b)).toBe(false);
    expect(gateway.activeWorld.get(a, Visibility).ok).toBe(false);
    expect(gateway.activeWorld.get(b, Visibility).ok).toBe(false);
  });

  it('hideMany skips already-hidden entities instead of double-dispatching', () => {
    const a = spawn('A');
    const b = spawn('B');
    hideMany([a]);
    const applied = gateway.appliedCount();
    hideMany([a, b]); // only B is a real target
    expect(gateway.appliedCount()).toBe(applied + 1);
    expect(hidden(a)).toBe(true);
    expect(hidden(b)).toBe(true);
  });

  it('setVisibilityMany shows targets and is a no-op when nothing differs', () => {
    const a = spawn('A');
    setVisibilityMany([a], 'hidden');
    expect(hidden(a)).toBe(true);
    const applied = gateway.appliedCount();
    setVisibilityMany([a], 'hidden'); // already hidden → no dispatch
    expect(gateway.appliedCount()).toBe(applied);
    setVisibilityMany([a], 'visible');
    expect(hidden(a)).toBe(false);
    const visibility = gateway.activeWorld.get(a, Visibility);
    expect(visibility.ok).toBe(true);
    if (visibility.ok) expect(visibility.value.state).toBe(VisibilityStateValue.visible);
  });

  it('showAllHidden clears every hidden entity as one undo step', () => {
    const a = spawn('A');
    const b = spawn('B');
    const c = spawn('C');
    hideMany([a, b]);
    showAllHidden();
    expect(hidden(a)).toBe(false);
    expect(hidden(b)).toBe(false);
    expect(hidden(c)).toBe(false);

    expect(gateway.undo()).toBe(true); // undo the show-all transaction…
    expect(hidden(a)).toBe(true);
    expect(hidden(b)).toBe(true);
  });

  it('hideUnselected isolates the selection, keeping ancestors and subtree visible', () => {
    const parent = spawn('Parent');
    const child = spawn('Child', parent);
    const grandchild = spawn('Grandchild', child);
    const other = spawn('Other');
    hideUnselected(new Set([child]));
    expect(hidden(other)).toBe(true);
    expect(hidden(child)).toBe(false);
    // The parent must stay visible: hiding it would recursively take the
    // isolated child down with it (UE isolate semantics).
    expect(hidden(parent)).toBe(false);
    expect(resolveVisibility(gateway.activeWorld).effective(child)).toBe('visible');
    // The selected subtree stays visible too.
    expect(hidden(grandchild)).toBe(false);
    expect(resolveVisibility(gateway.activeWorld).effective(grandchild)).toBe('visible');
  });

  it('hideUnselected with an empty selection is a no-op', () => {
    spawn('A');
    const applied = gateway.appliedCount();
    hideUnselected(new Set());
    expect(gateway.appliedCount()).toBe(applied);
  });

  it('hide gestures never touch entities outside the target list', () => {
    const a = spawn('A');
    const keep = spawn('Keep');
    hideMany([a]);
    expect(hidden(a)).toBe(true);
    expect(hidden(keep)).toBe(false);
    expect(gateway.activeWorld.get(keep, Visibility).ok).toBe(false);
    expect(worldEntityHandles(gateway.activeWorld).length).toBe(2);
  });
});
