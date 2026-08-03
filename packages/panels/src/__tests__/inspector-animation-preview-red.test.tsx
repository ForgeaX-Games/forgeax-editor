// Inspector — animation-preview M1 source-contract pins.
//
// Two panel-side contracts that a refactor could silently drop (the functional
// behavior is proven by animation-transport-bar.test.tsx / AssetPicker.test.tsx
// and the core suites; here we pin the Inspector's wiring):
//   1. A component whose meta contract names a bespoke editorId renders the
//      REGISTERED editor above its generic fields (unregistered id keeps the
//      historical hint-only fallback).
//   2. Fixed-capacity arrays (array<shared<T>,N>) open the picker AT the clicked
//      slot — the variable-array path would append an element past the engine's
//      fixed column capacity (regression pin).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const panel = readFileSync(resolve(import.meta.dir, '..', 'Inspector.tsx'), 'utf8');
const registry = readFileSync(resolve(import.meta.dir, '..', 'bespoke-editors.ts'), 'utf8');

describe('Inspector bespoke editor integration (M1)', () => {
  it('resolves bespoke.editorId through the registry and renders above the fields', () => {
    expect(panel).toContain('getBespokeEditor(bespoke.editorId)');
    expect(panel).toContain('<BespokeEditor entity={sel} component={comp} />');
    // Unregistered id → historical hint fallback stays.
    expect(panel).toContain('bespoke-hint');
  });

  it('registers the animation-transport builtin editor', () => {
    expect(registry).toContain("registerBespokeEditor('animation-transport', AnimationTransportBar)");
  });
});

describe('Inspector fixed-capacity array slot pick (regression)', () => {
  it('opens the picker AT slot i for fixed-length arrays instead of appending', () => {
    expect(panel).toContain('f.arrayMeta?.length !== undefined');
    expect(panel).toContain('setPicker({ comp, field: f.key, assetType: arrType, slot: i, currentGuid })');
  });
});
