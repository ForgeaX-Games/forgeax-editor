// no-edit-physics-sim.test.ts (solo P7 round-15) — structural guardrail that the
// EDIT world carries NO physics simulation, mirroring no-edit-mode-imports.test.ts.
//
// THE BUG THIS CATCHES: ViewportComponent's edit `createApp` used to assemble
// `physicsPlugin(editPhysics)` into the sceneWorld (= doc.world, save's only
// source). Physics tick systems then ran every EDIT frame, so a `RigidBody`
// authored at rest FELL to the floor on load and a save persisted the fallen
// pose — Edit ≠ Play, authored-intent corruption (solo notebook
// 20260713-134657-author-physics-fall-play, artifacts/09).
//
// THE INVARIANT (D-7 / M6, ViewportComponent.tsx :378-383): "the sceneWorld's
// authored data carries no game systems (game systems only exist in the transient
// playWorld built by play-assemble)". Physics is a game SIMULATION system and must
// obey it — like every other gameplay system (P4 Rotator). This gate asserts the
// asymmetry structurally so a re-leak fails CI, not a user's authoring session:
//   - the EDIT assembly (ViewportComponent.tsx) does NOT call physicsPlugin(...)
//   - the PLAY assembly (play-assemble.ts) STILL calls physicsPlugin(...)
//
// Comments are stripped before matching so the explanatory prose in
// ViewportComponent (which names physicsPlugin to explain its REMOVAL) is not a
// false positive — the same stripComments approach as no-edit-mode-imports.test.ts.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'viewport');
const EDIT_ASSEMBLY = resolve(VIEWPORT_DIR, 'ViewportComponent.tsx');
const PLAY_ASSEMBLY = resolve(VIEWPORT_DIR, 'play-assemble.ts');

/** Strip block + line comments so prose that names physicsPlugin to explain its
 *  removal is not a false positive — only real code calls count. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

// A real assembly CALL: `physicsPlugin(` (import-or-prose mentions are stripped
// as comments above; a bare identifier without `(` is not an assembly).
const PHYSICS_PLUGIN_CALL = /\bphysicsPlugin\s*\(/;

describe('solo P7 round-15 — physics does not simulate in the EDIT world', () => {
  it('sanity: both assembly files are readable + non-empty (non-vacuous scan)', () => {
    expect(stripComments(readFileSync(EDIT_ASSEMBLY, 'utf8')).length).toBeGreaterThan(100);
    expect(stripComments(readFileSync(PLAY_ASSEMBLY, 'utf8')).length).toBeGreaterThan(100);
  });

  it('the EDIT assembly (ViewportComponent) does NOT assemble physicsPlugin', () => {
    const code = stripComments(readFileSync(EDIT_ASSEMBLY, 'utf8'));
    expect(PHYSICS_PLUGIN_CALL.test(code)).toBe(false);
  });

  it('the PLAY assembly (play-assemble) STILL assembles physicsPlugin (sibling intact)', () => {
    const code = stripComments(readFileSync(PLAY_ASSEMBLY, 'utf8'));
    expect(PHYSICS_PLUGIN_CALL.test(code)).toBe(true);
  });
});
