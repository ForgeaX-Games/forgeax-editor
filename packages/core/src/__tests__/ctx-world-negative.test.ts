// AC-01 tsc-negative guard (F-1 review round 1, F-3).
//
// The round-1 review found that the "real tsc check" a comment promised did not
// exist: nothing enforced that a document applier body cannot reach the engine
// world through its ctx. This test closes that gap with an ACTUAL tsc run over a
// fixture (fixtures/ctx-world-negative.ts) that reaches `ctx.world`, and asserts:
//
//   (negative)  tsc reports TS2339 "Property 'world' does not exist on type
//               'DocApplierCtx'" for the `ctx.world` access  →  AC-01 holds:
//               DocApplierCtx has no world field, so appliers cannot bypass the
//               controlled ctx.engine proxy.
//   (positive)  tsc reports NO error mentioning the legal `ctx.engine` / `ctx.ids`
//               access — the sanctioned surface still type-checks.
//
// If a future refactor accidentally re-adds a `world` field to the ctx (or widens
// it to any/unknown), the negative assertion fails and the regression is caught.
//
// Anchors:
//   requirements AC-01: ApplierCtx / DocApplierCtx type has no world field
//   plan-strategy §2 D-2: EditSession (and its world) no longer enter appliers
//   implement-review round 1 F-3: AC-01 tsc-negative application point guard

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PKG_ROOT = path.resolve(import.meta.dir, '..', '..'); // packages/core
const TSC = path.resolve(PKG_ROOT, '..', '..', 'node_modules', '.bin', 'tsc');
const NEG_TSCONFIG = 'tsconfig.ctx-negative.json';
const FIXTURE = 'src/__tests__/fixtures/ctx-world-negative.ts';

/** Run `tsc -p tsconfig.ctx-negative.json` and return its combined output.
 *  tsc exits non-zero when it reports errors (expected here — the fixture is
 *  intentionally erroneous), so capture stdout from the thrown error too. */
function runNegativeTsc(): string {
  try {
    return execFileSync(TSC, ['-p', NEG_TSCONFIG], { cwd: PKG_ROOT, encoding: 'utf8' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

describe('AC-01 tsc-negative — DocApplierCtx has no world field (F-3)', () => {
  it('accessing ctx.world in an applier is a real tsc error (TS2339 on world)', () => {
    const out = runNegativeTsc();
    // The exact diagnostic the fixture must trigger — TS2339 for `world` on the
    // ctx type. Matching the property name + code (not the full message) keeps
    // this robust to tsc phrasing changes across versions.
    const worldError = out
      .split('\n')
      .filter((l) => l.includes(FIXTURE.replace(/\//g, path.sep)) || l.includes(FIXTURE))
      .find((l) => /error TS2339/.test(l) && /'world'/.test(l));
    expect(worldError, `expected a TS2339-on-'world' diagnostic for ${FIXTURE}; tsc output was:\n${out}`).toBeDefined();
    expect(worldError!).toContain('DocApplierCtx');
  });

  it('the legal ctx.engine / ctx.alias access does NOT produce an error (positive control)', () => {
    const out = runNegativeTsc();
    const fixtureErrors = out
      .split('\n')
      .filter((l) => l.includes(FIXTURE))
      .filter((l) => /error TS/.test(l));
    // The ONLY fixture error must be the intended `world` one. If `engine`/`ids`
    // also errored, the sanctioned ctx surface would be broken.
    for (const line of fixtureErrors) {
      expect(line, `unexpected fixture error (only ctx.world should error):\n${line}`).toMatch(/'world'/);
    }
    // And there must be at least one (the world error) — a totally clean compile
    // would mean the negative fixture stopped compiling erroneously.
    expect(fixtureErrors.length).toBeGreaterThan(0);
  });
});
