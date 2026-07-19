// no-parallel-render-path.test.ts (w21) — AC-07 editor-side source guardrail.
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M4.
//
// AC-07: the composite two-world render must ride the engine's draw-source seam
// (createApp `drawSource`), NOT a self-hosted rAF loop that calls renderer.draw
// directly. research F1 confirmed the editor had NO parallel render path before
// this feat (the only requestAnimationFrame is a one-shot input-liveness
// breadcrumb with no draw). This test is the REGRESSION GUARDRAIL — it greps the
// edit-runtime assembly source and asserts:
//   (1) zero `renderer.draw(` / `.draw(` method calls in editor source (a parallel
//       render path). The engine frame-loop owns draw; the editor only supplies a
//       drawSource callback (createDrawSource is a factory NAME, not a draw call —
//       excluded).
//   (2) the composite path IS wired through the draw-source seam — ViewportComponent
//       passes `drawSource:` to createApp (positive guard: the seam is actually used,
//       so (1) passing is non-vacuous rather than "no render at all").
//
// Any requestAnimationFrame in the source is allowed ONLY when it is draw-free
// (the F1-documented input breadcrumb). We assert no rAF body contains a draw by
// forbidding `.draw(` outright (1) — a rAF that drew would trip it.
//
// Anchors:
//   requirements AC-07 (zero self-hosted rAF + direct renderer.draw parallel path)
//   plan-strategy §7 M4 (AC-07 editor 半边 源码断言) + PD5 F-1
//   research F1 (editor has no parallel render path; drawSource seam is the wiring)

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .ts/.tsx file under edit-runtime/src, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if ((name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // line comments and /* block comments *\/ so a `.draw(` mentioned in
 *  prose (e.g. play-assemble.ts's `renderer.draw(world)` explanation) is not a
 *  false positive. Crude but sufficient: this source has no `.draw(` in strings. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

describe('w21 — AC-07 editor has no parallel render path (composite rides drawSource)', () => {
  const files = sourceFiles(SRC_ROOT);

  it('has zero direct renderer.draw( / .draw( calls in edit-runtime source', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'));
      // A `.draw(` method call is a parallel render path. drawSource /
      // createDrawSource are factory identifiers, not draw calls.
      const re = /\.draw\s*\(/g;
      if (re.test(code)) offenders.push(f.replace(`${SRC_ROOT}/`, ''));
    }
    expect(offenders).toEqual([]);
  });

  it('wires the composite render through createApp drawSource (non-vacuous)', () => {
    const viewportComponent = readFileSync(join(SRC_ROOT, 'viewport', 'ViewportComponent.tsx'), 'utf8');
    // The composite two-world path exists: drawSource is handed to createApp.
    expect(viewportComponent).toContain('drawSource: worldManager.createDrawSource()');
  });
});
