// editworld-freeze-snapshot.test.ts (w9) — AC-06/AC-07 focused freeze test.
//
// feat-20260707-editor-world-fork-ssot-level-load-play-activeworld M2.
//
// Distinct from the w6 full-chain integration: this test isolates the editWorld
// FREEZE contract. It builds a REAL editorApp (createApp assemble form) over an
// editWorld, registers a per-frame callback that counts ticks, then runs the
// lifecycle and asserts:
//   (AC-07) while play is active the editWorld frame-callback count does NOT
//           advance (editorApp.pause() truly halts the edit frame loop — a mere
//           injectEditMode(true) gate would keep the loop ticking, so this catches
//           the "gate is not enough" failure mode from research Finding 3).
//   (AC-06) the editWorld entity SET captured before play is byte-identical after
//           play->stop (play never touches editWorld — it forks a fresh world).
//   (AC-07) after stop, editorApp.resume() re-arms the edit loop and the callback
//           counts again.
//
// bun has no requestAnimationFrame; a capturing fake rAF steps frames deterministically.
//
// Anchors:
//   requirements AC-06 (editWorld entity set unchanged across play->stop)
//   requirements AC-07 (editWorld physically frozen — zero frame callbacks during play)
//   plan-strategy D-2 (editorApp.pause() -> editWorld zero tick)
//   research Finding 3 (injectEditMode(true) does NOT stop the frame loop)

import { describe, expect, it } from 'bun:test';
import { World, Entity } from '@forgeax/engine-ecs';
import { createApp, inputPlugin } from '@forgeax/engine-app';
import { transformPlugin, timePlugin, Name, Transform } from '@forgeax/engine-runtime';
import { assemblePlayWorld, type PlayAssembly } from '../play-assemble';
import { createRunLifecycle } from '../run-lifecycle';

type EcsWorld = InstanceType<typeof World>;

function installFakeRaf() {
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const prevRaf = g.requestAnimationFrame;
  const prevCaf = g.cancelAnimationFrame;
  let captured: ((t: number) => void) | null = null;
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    captured = cb;
    return 1;
  };
  g.cancelAnimationFrame = () => {
    captured = null;
  };
  return {
    step(t = 16): void {
      const cb = captured;
      captured = null;
      cb?.(t);
    },
    restore(): void {
      g.requestAnimationFrame = prevRaf;
      g.cancelAnimationFrame = prevCaf;
    },
  };
}

function makeFakeRenderer() {
  let disposeCalls = 0;
  const renderer = {
    ready: Promise.resolve({ ok: true }),
    assets: {},
    draw() {
      return { ok: true } as const;
    },
    dispose() {
      disposeCalls += 1;
    },
    onError(_cb: (e: unknown) => void) {
      return () => {};
    },
  };
  return {
    renderer,
    get disposeCalls() {
      return disposeCalls;
    },
  };
}

function makeSceneAsset() {
  return {
    kind: 'scene' as const,
    entities: [
      { localId: 0, components: { Transform: { posX: 0, posY: 0, posZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }, Name: { value: 'PlayRoot' } } },
    ],
  };
}

/** Snapshot the set of live entity handles in a world (self column scan).
 *  arch.size counts only live (dense) rows, so every row 0..size-1 is a live
 *  entity — including the packed value 0 (the very first entity, index 0
 *  generation 0, is a legitimate handle). Do NOT filter 0 out here. */
function entitySnapshot(world: EcsWorld): Set<number> {
  const set = new Set<number>();
  const graph = (world as unknown as {
    _getGraph: () => { archetypes: { columns: Map<number, Map<string, { view: Uint32Array }>>; size: number }[] };
  })._getGraph();
  for (const arch of graph.archetypes) {
    const selfCol = arch.columns.get(Entity.id)?.get('self');
    if (!selfCol) continue;
    for (let row = 0; row < arch.size; row++) {
      set.add(selfCol.view[row]! as number);
    }
  }
  return set;
}

describe('w9 — editWorld freeze + snapshot (AC-06/AC-07)', () => {
  async function buildRig() {
    const fakeRaf = installFakeRaf();
    // Build a REAL editorApp over an editWorld so pause() genuinely halts ticking.
    const editWorld = new World();
    const editRenderer = makeFakeRenderer();
    // transform + time + input suffice to exercise the frame loop; animationPlugin
    // is omitted to avoid AnimationAssetResolver tick noise (no resolver resource
    // in this headless rig) — freeze semantics are plugin-agnostic.
    const editAppRes = await createApp({
      renderer: editRenderer.renderer as never,
      world: editWorld as never,
      plugins: [transformPlugin(), timePlugin(), inputPlugin()],
    });
    if (!editAppRes.ok) throw new Error('editorApp assemble failed');
    const editorApp = editAppRes.value;

    // Count edit frame ticks via a registered update callback.
    let editTicks = 0;
    editorApp.registerUpdate(() => {
      editTicks += 1;
    });

    // Seed a couple of editWorld entities (the authored scene stand-in).
    editWorld.spawn({ component: Name, data: { value: 'EditA' } }, { component: Transform, data: { posX: 1, posY: 2, posZ: 3, scaleX: 1, scaleY: 1, scaleZ: 1 } });
    editWorld.spawn({ component: Name, data: { value: 'EditB' } }, { component: Transform, data: { posX: 4, posY: 5, posZ: 6, scaleX: 1, scaleY: 1, scaleZ: 1 } });

    editorApp.start();

    const playRenderer = makeFakeRenderer();
    const gatewayEvents: string[] = [];
    const gateway = {
      enterPlay: (_w: unknown) => gatewayEvents.push('enterPlay'),
      exitPlay: () => gatewayEvents.push('exitPlay'),
    };
    const assemble = async (): Promise<{ ok: true; value: PlayAssembly } | { ok: false; error: unknown }> =>
      assemblePlayWorld({
        renderer: playRenderer.renderer as never,
        loadDefaultScene: async () => makeSceneAsset(),
        resolveBootstrap: async () => (() => {}) as never,
        attachInput: () => undefined,
        newWorld: () => new World() as never,
      });

    const lifecycle = createRunLifecycle({
      editorApp: editorApp as never,
      gateway: gateway as never,
      assemble: assemble as never,
    });

    return {
      fakeRaf,
      editWorld,
      editorApp,
      lifecycle,
      get editTicks() {
        return editTicks;
      },
    };
  }

  it('(AC-07) editWorld frame callbacks stop while play is active, resume after stop', async () => {
    const rig = await buildRig();
    try {
      // Baseline: edit loop is running — a couple of frames advance the counter.
      rig.fakeRaf.step();
      rig.fakeRaf.step();
      const beforePlay = rig.editTicks;
      expect(beforePlay).toBeGreaterThanOrEqual(2);

      // Enter play — editorApp.pause() halts the edit loop.
      await rig.lifecycle.playSimulation();
      const atPlayStart = rig.editTicks;
      // Step frames: these now drive the PLAY app, not the paused edit app.
      rig.fakeRaf.step();
      rig.fakeRaf.step();
      rig.fakeRaf.step();
      // AC-07: edit callback count is frozen during play.
      expect(rig.editTicks).toBe(atPlayStart);

      // Stop — editorApp.resume() re-arms the edit loop.
      rig.lifecycle.stopSimulation();
      rig.fakeRaf.step();
      rig.fakeRaf.step();
      expect(rig.editTicks).toBeGreaterThan(atPlayStart);
    } finally {
      rig.fakeRaf.restore();
    }
  });

  it('(AC-06) editWorld entity set is identical before play and after stop', async () => {
    const rig = await buildRig();
    try {
      const before = entitySnapshot(rig.editWorld);
      expect(before.size).toBeGreaterThanOrEqual(2);

      await rig.lifecycle.playSimulation();
      // During play the editWorld must not gain/lose entities (play forks a
      // separate world; editWorld is untouched).
      const during = entitySnapshot(rig.editWorld);
      expect([...during].sort()).toEqual([...before].sort());

      rig.lifecycle.stopSimulation();
      const after = entitySnapshot(rig.editWorld);
      expect([...after].sort()).toEqual([...before].sort());
    } finally {
      rig.fakeRaf.restore();
    }
  });

  it('(AC-06) editWorld component values are unchanged across play->stop', async () => {
    const rig = await buildRig();
    try {
      const readNames = (): string[] => {
        const names: string[] = [];
        for (const h of entitySnapshot(rig.editWorld)) {
          const r = rig.editWorld.get(h as never, Name);
          if (r.ok) names.push(r.value.value);
        }
        return names.sort();
      };
      const before = readNames();
      expect(before).toContain('EditA');
      expect(before).toContain('EditB');

      await rig.lifecycle.playSimulation();
      rig.lifecycle.stopSimulation();

      expect(readNames()).toEqual(before);
    } finally {
      rig.fakeRaf.restore();
    }
  });
});
