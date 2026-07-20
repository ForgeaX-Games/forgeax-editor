// store/gateway — the app-level EditGateway singleton (init root).
//
// State: the one authoritative mutable EditSession path for the whole editor.
// Consumers: every other store/ sub-module (selection, doc-version,
// scene-persistence, disk-watch, ref-request …) imports this constructed
// singleton — ESM guarantees this module evaluates before its importers, so the
// two `gateway.subscribe(...)` eval-time side effects (doc-version, scene-persistence)
// always run against a live gateway (research F-4 coupling edge 1 / R3).
//
// Anchors:
//   plan-strategy §2 D-1: module-level singleton + named export (no factory DI)
//   plan-strategy §2 D-2: cluster 1 (store.ts:48) — gateway is the init root
//   requirements AC-09: pure structural migration (body verbatim from store.ts)
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';

// App-level singletons. The gateway is the authoritative mutable path; selection is
// transient view state (NOT a command) — but selecting is exactly what turns a
// vague "this" into a concrete pointing handle for the AI (deixis).
//
// Ported (trimmed) from the unveil-studio prototype: Edit-only — the Play
// snapshot / runtime-systems half of the prototype store is dropped here because
// in forgeax the *engine itself* runs Play mode (see interface ▶ Play). The Edit
// surface keeps the authored doc static and projects it onto the forgeax world.
export const gateway = new EditGateway(createEditSession());
