// ops-hide.test.ts — UE-parity hide gestures (docs 2026-08-04-editor-hide-ue-parity-plan)
//
// Locks the shared core ops behind H / Ctrl+H / Shift+H and the Hierarchy eye:
//   1. hideMany / setHiddenMany wrap multi-entity hides in ONE transaction
//      (one undo step) and skip entities already in the target state
//   2. showAllHidden clears every EditorHidden marker as one undo step
//   3. hideUnselected isolates the selection: selected entities AND their
//      ancestors stay visible, everything else hides
//   4. every hidden entity also carries the engine `Disabled` marker (render
//      exclusion), cleared again after undo / show
//
// All ops route through the singleton gateway's one dispatch door — these tests
// never call applyCommand directly (north-star §3.2).

import { describe, it, expect, beforeEach } from 'bun:test';
import { Disabled, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { createEditSession } from '../session/document';
import { gateway } from '../store/store';
import { hideMany, hideUnselected, setHiddenMany, showAllHidden } from '../session/ops';
import { EditorHidden } from '../components/EditorHidden';
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
  return gateway.activeWorld.get(h, EditorHidden).ok;
}
function disabled(h: EntityHandle): boolean {
  return gateway.activeWorld.get(h, Disabled).ok;
}

describe('hide ops (UE parity §1)', () => {
  beforeEach(() => {
    gateway.replaceDoc(createSession());
  });

  it('hideMany hides all targets with Disabled sync, ONE undo restores all', () => {
    const a = spawn('A');
    const b = spawn('B');
    hideMany([a, b]);
    expect(hidden(a)).toBe(true);
    expect(hidden(b)).toBe(true);
    expect(disabled(a)).toBe(true);
    expect(disabled(b)).toBe(true);

    // Multi-entity gesture = ONE transaction = ONE undo step (deleteMany parity).
    expect(gateway.undo()).toBe(true);
    expect(hidden(a)).toBe(false);
    expect(hidden(b)).toBe(false);
    expect(disabled(a)).toBe(false);
    expect(disabled(b)).toBe(false);
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

  it('setHiddenMany(false) shows targets and is a no-op when nothing differs', () => {
    const a = spawn('A');
    setHiddenMany([a], true);
    expect(hidden(a)).toBe(true);
    const applied = gateway.appliedCount();
    setHiddenMany([a], true); // already hidden → no dispatch
    expect(gateway.appliedCount()).toBe(applied);
    setHiddenMany([a], false);
    expect(hidden(a)).toBe(false);
    expect(disabled(a)).toBe(false);
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
    expect(disabled(a)).toBe(false);
    expect(disabled(b)).toBe(false);

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
    expect(disabled(parent)).toBe(false);
    expect(disabled(child)).toBe(false);
    // The selected subtree stays visible too.
    expect(hidden(grandchild)).toBe(false);
    expect(disabled(grandchild)).toBe(false);
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
    expect(disabled(keep)).toBe(false);
    expect(worldEntityHandles(gateway.activeWorld).length).toBe(2);
  });
});
