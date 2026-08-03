// animation-preview-op.test.ts — the setAnimationPreview session op (M1).
//
// Contract under test:
//   - Routable SESSION-domain op: dispatch lands in the ledger, undo stays frozen
//     (preview is session state, never authored intent).
//   - Fail-fast validation: numeric entity required, at least one of
//     playing/speed/phase per dispatch, ranges enforced (INVALID_ARGS).
//   - playing=false writes paused=true; speed pads+writes the primary slot of the
//     transport's speeds column; phase scrubs times[clipIndex] = phase * duration
//     via ctx.resolveAsset — and fails fast (ASSET_NOT_FOUND) when the primary
//     slot has no resolvable clip.
//   - The FIRST preview write snapshots the reflection-declared runtimeFields
//     (session/animation-preview) — the save-pollution defense this feature's
//     P0 verification proved necessary.

import { describe, expect, it, beforeAll, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AnimationPlayer } from '@forgeax/engine-animation';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { _resetSchemaCache } from '../scene/schema';
import type { EditSession, EditorOp } from '../types';
import {
  clearAnimationPreviews,
  hasAnimationPreview,
  restoreAllAnimationPreviews,
} from '../session/animation-preview';
// Side-effect: registers the setAnimationPreview applier (same as the barrel).
import '../session/animation-preview-ops';

void AnimationPlayer;

function createSession(): { session: EditSession; world: World } {
  const world = new World();
  const session = createEditSession();
  session.world = world as unknown as EditSession['world'];
  return { session, world };
}

function spawnPlayer(world: World, data: Record<string, unknown> = {}): number {
  const r = world.spawn({ component: AnimationPlayer, data });
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as unknown as number;
}

function readPlayer(world: World, entity: number): Record<string, unknown> {
  const r = world.get(entity as never, AnimationPlayer);
  if (!r.ok) throw new Error('AnimationPlayer read failed');
  return r.value as unknown as Record<string, unknown>;
}

beforeAll(() => {
  _resetSchemaCache();
});

beforeEach(() => {
  clearAnimationPreviews();
});

describe('setAnimationPreview — validation (fail fast)', () => {
  let gw: EditGateway;
  let world: World;
  beforeEach(() => {
    ({ world } = createSession());
    const s = createSession();
    gw = new EditGateway(s.session);
    world = s.world;
  });

  it('rejects a missing/non-numeric entity (INVALID_ARGS)', () => {
    const r = gw.dispatch({ kind: 'setAnimationPreview', playing: true } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('rejects a dispatch with none of playing/speed/phase (INVALID_ARGS)', () => {
    const e = spawnPlayer(world);
    const r = gw.dispatch({ kind: 'setAnimationPreview', entity: e } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_ARGS');
  });

  it('rejects out-of-range speed and phase (INVALID_ARGS)', () => {
    const e = spawnPlayer(world);
    const badSpeed = gw.dispatch({ kind: 'setAnimationPreview', entity: e, speed: 11 } as EditorOp);
    expect(badSpeed.ok).toBe(false);
    if (!badSpeed.ok) expect(badSpeed.error.code).toBe('INVALID_ARGS');
    const badPhase = gw.dispatch({ kind: 'setAnimationPreview', entity: e, phase: 1.5 } as EditorOp);
    expect(badPhase.ok).toBe(false);
    if (!badPhase.ok) expect(badPhase.error.code).toBe('INVALID_ARGS');
  });

  it('rejects an entity without AnimationPlayer (NO_SUCH_COMPONENT)', () => {
    const bare = world.spawn();
    if (!bare.ok) throw new Error('spawn failed');
    const r = gw.dispatch({ kind: 'setAnimationPreview', entity: bare.value as unknown as number, playing: true } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_SUCH_COMPONENT');
  });

  it('phase scrub without a bound clip fails fast (ASSET_NOT_FOUND), nothing written', () => {
    const e = spawnPlayer(world);
    const r = gw.dispatch({ kind: 'setAnimationPreview', entity: e, phase: 0.5 } as EditorOp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ASSET_NOT_FOUND');
    // AC-6: validation happens before snapshot/write — no partial mutation.
    expect(hasAnimationPreview(e)).toBe(false);
  });
});

describe('setAnimationPreview — transport writes through the session door', () => {
  let gw: EditGateway;
  let world: World;
  beforeEach(() => {
    const s = createSession();
    gw = new EditGateway(s.session);
    world = s.world;
  });

  it('playing=false writes paused=true; playing=true resumes', () => {
    const e = spawnPlayer(world, { paused: true });
    const r1 = gw.dispatch({ kind: 'setAnimationPreview', entity: e, playing: true } as EditorOp);
    expect(r1.ok).toBe(true);
    expect(readPlayer(world, e).paused).toBe(false);
    const r2 = gw.dispatch({ kind: 'setAnimationPreview', entity: e, playing: false } as EditorOp);
    expect(r2.ok).toBe(true);
    expect(readPlayer(world, e).paused).toBe(true);
  });

  it('speed pads + writes the primary slot of the speeds column', () => {
    const e = spawnPlayer(world);
    const r = gw.dispatch({ kind: 'setAnimationPreview', entity: e, speed: 2 } as EditorOp);
    expect(r.ok).toBe(true);
    const speeds = Array.from(readPlayer(world, e).speeds as ArrayLike<number>);
    expect(speeds[0]).toBe(2);
  });

  it('phase scrubs times[clipIndex] = phase * clip duration (ctx.resolveAsset)', () => {
    const clip = world.allocSharedRef('AnimationClip', { kind: 'animation-clip', duration: 2 });
    const e = spawnPlayer(world, {
      clips: [clip as unknown as number],
      times: [0],
      weights: [1],
      speeds: [1],
    });
    const r = gw.dispatch({ kind: 'setAnimationPreview', entity: e, phase: 0.25 } as EditorOp);
    expect(r.ok).toBe(true);
    const times = Array.from(readPlayer(world, e).times as ArrayLike<number>);
    expect(times[0]).toBeCloseTo(0.5, 5);
  });

  it('grows the session ledger, never the undo stack (AI-dispatchable)', () => {
    const e = spawnPlayer(world);
    const ledgerBefore = gw.ledger.length;
    const undoBefore = gw.appliedCount();
    gw.dispatch({ kind: 'setAnimationPreview', entity: e, playing: false } as EditorOp, 'ai');
    expect(gw.ledger.length).toBe(ledgerBefore + 1);
    expect(gw.appliedCount()).toBe(undoBefore);
    expect(gw.origins[gw.origins.length - 1]).toBe('ai');
  });
});

describe('setAnimationPreview — snapshot/restore save-pollution defense', () => {
  let gw: EditGateway;
  let world: World;
  beforeEach(() => {
    const s = createSession();
    gw = new EditGateway(s.session);
    world = s.world;
  });

  it('the first preview write snapshots the runtimeFields; restore returns authored values', () => {
    const e = spawnPlayer(world, { paused: false, speeds: [1] });
    expect(hasAnimationPreview(e)).toBe(false);
    gw.dispatch({ kind: 'setAnimationPreview', entity: e, playing: false, speed: 3 } as EditorOp);
    expect(hasAnimationPreview(e)).toBe(true);
    expect(readPlayer(world, e).paused).toBe(true);

    const restored = restoreAllAnimationPreviews(gw.engineFacade() as never);
    expect(restored).toBe(1);
    const after = readPlayer(world, e);
    expect(after.paused).toBe(false);
    expect(Array.from(after.speeds as ArrayLike<number>)[0]).toBe(1);
  });

  it('restore writes fresh copies — the snapshot baseline is not aliased by the world', () => {
    const e = spawnPlayer(world, { speeds: [1] });
    gw.dispatch({ kind: 'setAnimationPreview', entity: e, speed: 4 } as EditorOp);
    restoreAllAnimationPreviews(gw.engineFacade() as never);
    // A second preview session re-snapshots from the restored (authored) values.
    gw.dispatch({ kind: 'setAnimationPreview', entity: e, speed: 9 } as EditorOp);
    restoreAllAnimationPreviews(gw.engineFacade() as never);
    expect(Array.from(readPlayer(world, e).speeds as ArrayLike<number>)[0]).toBe(1);
  });
});
