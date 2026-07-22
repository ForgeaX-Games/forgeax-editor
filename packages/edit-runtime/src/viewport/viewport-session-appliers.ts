// viewport-session-appliers — the edit-runtime registration seam for viewport
// lifecycle/control operations (M3).
//
// The registrar is deliberately framework-free: it imports no React, DOM, or
// component state. ViewportComponent supplies closures over the already-created
// runtime, and teardown owns the returned disposer. Domain is structural because
// every operation is registered into core's session-applier table.

import { getRegisteredSystems, Update } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import { registerSessionApplier, type SessionApplier } from '@forgeax/editor-core';

export interface ViewportSessionApplierDeps {
  readonly play: () => void;
  readonly stop: () => void;
  readonly setDisplay: (display: 'scene' | 'game') => void;
  readonly grantGameControl: () => void;
  readonly releaseGameControl: () => void;
  readonly world: World;
}

const invalidArgs = (hint: string) => ({ ok: false as const, error: { code: 'INVALID_ARGS' as const, hint } });

function registerAll(deps: ViewportSessionApplierDeps): Array<() => void> {
  const disposers: Array<() => void> = [];
  const register = (kind: string, applier: SessionApplier, title: string, argsSchema?: unknown): void => {
    disposers.push(registerSessionApplier(kind, applier, { title, ...(argsSchema === undefined ? {} : { argsSchema }) }));
  };

  try {
    register('play', () => { deps.play(); return { ok: true }; }, 'Play');
    register('stop', () => { deps.stop(); return { ok: true }; }, 'Stop');
    register('setDisplay', (op) => {
      const display = (op as { display?: unknown }).display;
      if (display !== 'scene' && display !== 'game') return invalidArgs('display must be "scene" or "game"');
      deps.setDisplay(display);
      return { ok: true };
    }, 'Set Viewport Display', {
      type: 'object', properties: { display: { type: 'string', enum: ['scene', 'game'] } }, required: ['display'],
    });
    register('grantGameControl', () => { deps.grantGameControl(); return { ok: true }; }, 'Grant Game Control');
    register('releaseGameControl', () => { deps.releaseGameControl(); return { ok: true }; }, 'Release Game Control');
    register('addSystem', (op) => {
      const name = (op as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') return invalidArgs('name must be a non-empty system name');
      const system = getRegisteredSystems().get(name);
      if (!system) return invalidArgs(`unknown system: ${name}`);
      deps.world.addSystem(Update, system).unwrap();
      return { ok: true };
    }, 'Enable System', {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    });
    register('removeSystem', (op) => {
      const name = (op as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') return invalidArgs('name must be a non-empty system name');
      deps.world.removeSystem(Update, name).unwrap();
      return { ok: true };
    }, 'Disable System', {
      type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
    });
  } catch (error) {
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!();
    throw error;
  }
  return disposers;
}

export function registerViewportSessionAppliers(deps: ViewportSessionApplierDeps): () => void {
  const disposers = registerAll(deps);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    for (let i = disposers.length - 1; i >= 0; i--) disposers[i]!();
  };
}
