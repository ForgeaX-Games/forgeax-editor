// AC-01 tsc-negative fixture (F-1 review round 1, F-3).
//
// This file is INTENTIONALLY type-erroneous and is EXCLUDED from the normal
// `bun -F @forgeax/editor-core typecheck` gate (core tsconfig `exclude`). It is
// compiled ON DEMAND by ctx-world-negative.test.ts via a dedicated tsconfig, to
// prove — with a real tsc run, not a comment — that a document applier body
// cannot reach the engine world through its ctx:
//
//   AC-01: DocApplierCtx has NO `world` field. Accessing `ctx.world` MUST be a
//   tsc error (TS2339). The controlled `ctx.engine` write proxy is the ONLY
//   world access an applier gets, and it is legal.
//
// The test greps this file's tsc output for the TS2339-on-`world` diagnostic
// (negative assertion) and confirms NO diagnostic mentions the legal `engine`
// access (positive control). See plan-strategy §2 D-2.

import type { DocApplierCtx } from '../../session/document';

/** NEGATIVE: reaching for the engine world through the ctx must not compile —
 *  DocApplierCtx deliberately omits `world` (AC-01). */
export function badApplierReachesWorld(ctx: DocApplierCtx): unknown {
  return ctx.world; // expected: error TS2339 Property 'world' does not exist ...
}

/** POSITIVE control: the sanctioned write proxy + id map are present and legal.
 *  If the type were accidentally broadened to `any`/`unknown`, the negative
 *  case above would stop erroring — the test's negative assertion guards that. */
export function goodApplierUsesEngine(ctx: DocApplierCtx): unknown {
  const _e = ctx.engine;
  const _a = ctx.alias;
  return [_e, _a];
}
