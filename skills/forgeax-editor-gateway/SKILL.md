---
name: forgeax-editor-gateway
description: >-
  All editor operations through a single EditGateway — dispatch (immediate op), begin/update/commit/cancel
  (continuous op), listOps (self-introspect), defineOp (compose new ops), eval (AI channel), trace (read
  span trees). Three-domain model (document/session/transient) decided by applier registration table.
  Structured errors via {ok, error}. AI entry: globalThis.__forgeaxEval in DEV builds, driven
  headlessly via skills/forgeax-editor-gateway/scripts/gateway-eval.mjs or in the already-open editor via skills/forgeax-editor-gateway/scripts/gateway-live.mjs.
  Use when building editor tools, AI-driven editing, extending the editor with new operations, or
  driving/inspecting a running editor's gateway from a script.
---

# forgeax-editor-gateway

> **All editor operations go through a single EditGateway — `dispatch` / `begin…commit` / `listOps` / `defineOp` / `eval`.**
>
> Editor state mutation has exactly one door. Human UI handlers and AI code use the same gateway,
> same op payload, same applier, same ledger — human-machine isomorphism. See one op walk through
> and you know how every editor state mutation walks.
>
> **Why it's shaped this way:** `DESIGN.md` (design decisions) · `AGENTS.md` §Design principles
> (the single-door axioms) · `docs/skills/forgeax-editor-gateway.md` (play/stop world-fork).
>
> [!CAUTION]
> **Reading/writing entities across a play/stop (`▶`/`■`) boundary?** First read
> [`docs/skills/forgeax-editor-gateway.md`](../../docs/skills/forgeax-editor-gateway.md) —
> `gateway.activeWorld` / `mode` and the world-fork rule that an `EntityHandle` is
> **stale** the moment you cross a play/stop boundary. Re-query after every `▶`/`■`.

## Mental Model

**Three-domain model**: an op's domain is decided by which registration table holds its
applier (structural, not a hand-pasted label):

| Domain | Applier table | Ledger behavior | Representative ops |
|:--|:--|:--|:--|
| `document` | `documentAppliers` | undo + ledger (reversible) | spawnEntity / setComponent / transaction |
| `session` | `sessionAppliers` | ledger only (irreversible, auditable) | setSelection / saveDocToDisk / requestFrame / play / stop / cameraOrbit |
| `transient` | `transientAppliers` | neither (ephemeral, no trace) | setHoverEntity / setFieldPreview |

**Immediate op** = `dispatch` with implicit begin=commit collapse.
**Continuous op** = `begin` (snapshot pre-state, occupy slot) -> `update*` (write-through, no ledger)
-> `commit` (compute from->to inverse, settle per domain). At most one active op at a time (single slot);
a second begin or scene switch/undo triggers implicit cancel of the prior op; stale handle returns
`OP_INTERRUPTED`.

**AI eval channel**: in DEV builds, `globalThis.__forgeaxEval` exposes an in-process
eval channel. AI CLI accesses it via `playwright page.evaluate` — zero new network surface (OOS-9).
scope① = `{gateway, query, _import}` (no world/renderer/assets). scope② = raw engine access,
gated behind explicit `unlockRawScope()` (dev-only; production always returns `SCOPE_LOCKED`).

**Trace**: every dispatch/undo/redo produces a span tree. Read them via
`gateway.trace.last()` / `gateway.trace.recent(n)` — plain-object trees with OTel-aligned fields
(traceId/spanId/parentSpanId/name/start/end/attributes/status). Nested dispatches auto-link
parent->child spans. Ring buffer retains the last 256 root trees; eviction increments a
readable `droppedTraces` counter.

## Core API Quick Reference

| Entry | Shape | Purpose |
|:--|:--|:--|
| `gateway.dispatch(op, origin?)` | `(EditorOp, 'human'\|'ai') => DispatchResult` | Immediate op: construct EditorOp -> dispatch, domain settled by applier table |
| `gateway.begin(op, origin?)` | `(EditorOp, 'human'\|'ai') => {ok:true, handle} \| {ok:false, error}` | Start continuous op: pre-validate + snapshot, occupy slot, return handle. **origin defaults to `'human'` and the WHOLE lifecycle carries it** — AI-driven gestures MUST pass `'ai'` here (commit has no origin param), else the ledger records the drag as human |
| `gateway.update(handle, patch)` | `(OpHandle, Record<string,any>) => DispatchResult` | Accumulate patch into begin op, write-through state + repaint (no ledger, no inverse) |
| `gateway.commit(handle)` | `(OpHandle) => DispatchResult` | Finish continuous op: compute from->to inverse, settle per domain, release slot |
| `gateway.cancel(handle)` | `(OpHandle) => DispatchResult` | Roll back to pre-begin state, no trace, release slot |
| `gateway.listOps()` | `() => readonly OpDescriptor[]` | Self-introspect all registered ops (builtin + seam-registered + defineOp-composed) |
| `gateway.collectSceneAsset(entity)` | `(EntityHandle) => {ok:true, asset} \| {ok:false, error}` | Read one live subtree as a GUID-backed SceneAsset POD; no world/ledger mutation |
| `gateway.resolveAsset(handle)` | `(number) => {ok:true, asset} \| {ok:false, error}` | Resolve a shared<T> handle (query's opaque-handle.raw) to its live asset payload; covers builtin + catalog, O(1) |
| `gateway.describeAsset(handle)` | `(number) => {ok:true, kind, guid?, name?, builtin?} \| {ok:false, error}` | Human-readable identity of an asset handle: kind + (catalog assets) guid+name, or builtin:true |
| `gateway.assetCatalog()` | `() => readonly {guid, kind, name?, relativeUrl}[]` | List the asset catalog (projects registry.listCatalog); [] if no registry |
| `gateway.lookupAsset(guid)` | `(AssetGuid\|string) => Asset \| undefined` | Look up a catalogued asset payload by GUID (catalog only, no fetch) |
| `gateway.listComponents()` | `() => readonly string[]` | Self-introspect all registered component names (sorted). The "what components exist?" leg, parallel to listOps (ops) / assetCatalog (assets). Same source as the UNKNOWN_COMPONENT hint |
| `gateway.describeComponent(name)` | `(string) => {ok:true, name, schema, defaults?} \| {ok:false, error}` | Field schema of one component (field→type-keyword map + JSON-safe defaults) — the answer to "what fields does Transform take?" BEFORE building a spawn/setComponent payload. Unknown name → UNKNOWN_COMPONENT listing registered names |
| `gateway.defineOp(def)` | `(OpDefinition) => DefineResult` | Compose new document/session op (id + argsSchema + plan -> transaction or session-plan) |
| `gateway.trace.last()` | `() => SpanNode \| null` | Read most recent root span tree (plain-object, AC-10) |
| `gateway.trace.recent(n)` | `(n: number) => SpanNode[]` | Read last N root span trees |
| `gateway.auditLog()` | `() => ReadonlyArray<{op, origin}>` | "Who did what" — the append-only ledger zipped with its index-aligned origin ('human'\|'ai'), oldest→newest; includes irreversible session ops (setSelection/save/play), unlike undoStack-derived `historySteps()` |
| `gateway.undo()` / `gateway.redo()` | `() => boolean` | Roll the document timeline back / forward one step. **Returns a bare `boolean`** (did-something), **NOT `DispatchResult`** — there is no `.ok`. `false` = nothing to undo/redo (empty stack). Gate with `canUndo()`/`canRedo()`, don't branch on `.ok`. Session ops (setSelection/save/play) are NOT on this stack — see "Session ops are irreversible" |
| `gateway.canUndo()` / `gateway.canRedo()` | `() => boolean` | Whether the undo/redo stack is non-empty — the guard for undo/redo UI buttons and for a docs-following AI's loop condition |
| `gateway.appliedCount()` | `() => number` | Number of currently-applied document steps (the timeline head position); pairs with `gotoStep(n)` |
| `gateway.historySteps()` | `() => HistoryStep[]` | undoStack-derived timeline (applied oldest→newest, then redoable future), each with origin; **document ops only** (no session ops — use `auditLog()` for those) |
| `registerSessionApplier(kind, applier, meta?)` | `(string, fn, meta?) => () => void` | Downstream registration seam: edit-runtime registers play/stop/cameraOrbit/requestFrame appliers |
| `createEvalChannel(gw, opts?)` | `(EditGateway, {rawScope?}) => EvalChannel` | Create dev-only eval channel; `globalThis.__forgeaxEval` in DEV builds |
| `channel.eval(code)` | `(string) => EvaluateResult` | Evaluate JS code with scope①={gateway, query, _import} |
| `channel.unlockRawScope()` | `() => RawScopeResult` | Attempt scope② unlock; returns SCOPE_LOCKED in production |

## dispatch -- Immediate Operation

```ts
import { gateway } from '@forgeax/editor-core';

// Human: UI handler
gateway.dispatch({ kind: 'setSelection', id: entityId });
// origin defaults to 'human'; id:null clears selection

// AI: code context
gateway.dispatch({ kind: 'setSelection', id: entityId }, 'ai');
// origin='ai' -> recorded for audit; read it back via gateway.auditLog() (see §auditLog).

// Result check
const r = gateway.dispatch({ kind: 'spawnEntity', name: 'Light', components: {} }, 'ai');
if (!r.ok) console.error(r.error.code, r.error.hint);
// Errors do not throw — property-access branching

// Spawn WITH components: the `components` map is passed straight to engine.spawn,
// so each component uses the ENGINE schema, not the editor's per-axis field names.
// Transform = { pos:[x,y,z], quat:[x,y,z,w], scale:[x,y,z] } — NOT posX/posY/posZ.
// A wrong field name fails fast with SPAWN_FAILED whose hint lists the real fields.
gateway.dispatch({
  kind: 'spawnEntity',
  name: 'AI-Cube',
  components: { Transform: { pos: [0, 1, 0] } },
}, 'ai');

// New-entity handle: creating ops (spawnEntity / instantiateSceneAsset /
// duplicateEntity / a transaction of them) return the new roots on
// r.result.created — a stable EntityHandle[] you can immediately act on. Single
// spawn → length 1; a transaction flattens every sub-op's roots in op order.
// Non-creating document ops return created: []. session/transient ops omit
// result entirely. This replaces the old "dispatch then diff a query" dance.
if (r.ok) {
  const [handle] = r.result?.created ?? [];
  if (handle !== undefined) gateway.dispatch({ kind: 'setSelection', id: handle }, 'ai');
}
```

## begin -> update -> commit -- Continuous Operation

```ts
// gizmo drag: mousedown -> mousemove* -> mouseup
// Transform fields are the ENGINE schema: pos/quat/scale/world (vectors), NOT posX/posY/posZ.
// pos is [x,y,z]; quat is [x,y,z,w]; scale is [x,y,z]. Same names on read (query) and write.
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { pos: [0, 0, 0] } }, 'ai');
if (!b.ok) return; // begin failed (e.g. entity nonexistent) -> {ok:false, error}
const handle = b.handle;

// Per-frame drag (write-through, no ledger); update's partial accumulates into begin's op
gateway.update(handle, { patch: { pos: [1.0, 0.5, 0] } });
gateway.update(handle, { patch: { pos: [1.2, 0.7, 0] } });

// Mouse-up settle: compute from->to inverse, one undo
const result = gateway.commit(handle);
// document domain -> undo + ledger (one undo rolls back entire drag)
// session domain -> ledger only
```

> [!IMPORTANT]
> **Driving a continuous op across separate `gateway-live.mjs` / `gateway-eval.mjs` calls
> (the natural AI pattern: one call per mousedown/move/up).** The `OpHandle` is a live object;
> the bridge only round-trips JSON, and it serializes to `{ id: 'op-…' }`. So either (a) stash it
> in the page — `window.__h = b.handle` in the begin call, then `gateway.update(window.__h, …)`
> next call — or (b) reconstruct it: read `b.handle.id` from the begin result and pass a plain
> `{ id }` object to `update`/`commit`. Only ONE op slot exists: any intervening `begin` (yours or a
> human's) supersedes the prior handle, and the stale one returns `OP_INTERRUPTED`. For a
> self-contained gesture, do begin+update+commit inside ONE snippet (no cross-call handle at all).

## cancel -- Interrupt Rollback

```ts
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { pos: [0, 0, 0] } });
if (!b.ok) return;
const handle = b.handle;
gateway.update(handle, { patch: { pos: [5.0, 0, 0] } });

// User presses undo or scene switch
gateway.cancel(handle);
// -> roll back to pre-begin Transform, no ledger/undo trace

// Subsequent ops on stale handle
gateway.commit(handle);
// -> { ok: false, error: { code: 'OP_INTERRUPTED', hint: '...' } }
```

## listOps -- Self-Introspect Capability Boundary

```ts
const ops = gateway.listOps();
// [
//   { id: 'setSelection', domain: 'session', source: 'builtin', argsSchema: {...} },
//   { id: 'saveDocToDisk', domain: 'session', source: 'builtin', argsSchema: {...} },
//   { id: 'spawnEntity', domain: 'document', source: 'builtin', argsSchema: {...} },
//   { id: 'play',   domain: 'session', source: 'builtin', ... },  // visible after edit-runtime boot
//   { id: 'alignToGrid', domain: 'document', source: 'defined', argsSchema: {...} },
// ]

// AI fetches capability boundary once before starting work
const sessionOps = ops.filter(o => o.domain === 'session');
const docOps = ops.filter(o => o.domain === 'document');
```

### Duplicate an existing entity (public material-safe path)

```ts
// First identify the source without guessing interned string handles.
const found = query({ with: ['Name'] });
if (!found.ok) throw new Error(found.error.code);
const ball = found.rows.find((row) => row.Name.value === 'BouncyBall');
if (!ball) throw new Error('BouncyBall not found');

// One document op: collects source subtree → GUID-backed SceneAsset → instantiate.
// It appears in listOps() and records AI origin, undo, redo, and trace normally.
const result = gateway.dispatch({ kind: 'duplicateEntity', entity: ball.entity }, 'ai');
if (!result.ok) throw new Error(result.error.code);
// The new copy's roots are on result.result.created — no query diff needed.
const copy = result.result?.created[0];
if (copy !== undefined) gateway.dispatch({ kind: 'setSelection', id: copy }, 'ai');

// Advanced composition only: collect the portable POD, then instantiate elsewhere.
const collected = gateway.collectSceneAsset(ball.entity);
if (collected.ok) {
  gateway.dispatch({ kind: 'instantiateSceneAsset', asset: collected.asset }, 'ai');
}
```

`duplicateEntity` is preferred for ordinary copies. `collectSceneAsset` is read-only:
it neither mutates the world nor adds an undo/ledger entry. Both use the live app's
registry/module graph, preserving material GUID resolution and child hierarchy.

### Read what asset an entity references (mesh / material)

`query` returns an asset-reference field (`shared<T>`, e.g. `MeshFilter.assetHandle`)
as `{kind:'opaque-handle', type, raw}` where `raw` is the engine handle VALUE — a
stable machine id, not the asset's meaning. To turn it into meaning, feed `raw` to
the gateway's asset-read surface (pure reads: no world/undo/ledger mutation):

```ts
const r = query({ with: ['MeshFilter'] });
if (!r.ok) throw new Error(r.error.code);
const row = r.rows[0];
const handle = row.MeshFilter.assetHandle.raw as number;   // the shared<MeshAsset> handle

// "What mesh is this?" — human-readable identity (best-effort):
const d = gateway.describeAsset(handle);
// catalog asset → { ok:true, kind:'mesh', guid:'…', name:'rock' }
// builtin mesh  → { ok:true, kind:'mesh', builtin:true }   (HANDLE_CUBE etc. — no GUID)

// Need the payload (geometry / material params)? resolveAsset gives the live POD:
const a = gateway.resolveAsset(handle);           // { ok:true, asset:{ kind:'mesh', vertices, … } }

// Enumerate / look up the catalog directly:
const catalog = gateway.assetCatalog();           // [{ guid, kind, name?, relativeUrl }]
const payload = gateway.lookupAsset(someGuid);    // Asset | undefined (catalog only)
```

> [!IMPORTANT]
> `shared<T>` is the engine's general shared-ref store — "asset" is its common use,
> not its definition. Not every `shared<T>` has a GUID: **builtin** meshes
> (`HANDLE_CUBE`/`HANDLE_TRIANGLE`) live in a process-static registry, not the
> asset catalog, so `describeAsset` returns `{builtin:true}` with no `guid`/`name`.
> `resolveAsset` still returns their payload (it covers builtin + catalog). `raw`
> of `0` = unset slot; a stale/unknown handle → `{ok:false, code:'ASSET_NOT_FOUND'}`.
> `unique<T>`/`ref`/`buffer` stay opaque (no catalog GUID; not resolved here).

### Import an external asset, then place it in the scene (the asset WRITE legs)

The read legs above (`assetCatalog`/`describeAsset`/`resolveAsset`/`lookupAsset`) answer *"what
assets exist?"*. The **write legs** are ordinary `dispatch` ops — the same door humans use from the
Content Browser, so an AI is an equal peer (registry razor). They are **session-domain, ledger-only**
(no undo — a cook/instantiate produces derived artefacts) and, because they do disk / `loadByGuid`
I/O, **fire-and-forget async**: `dispatch` returns `{ok:true}` synchronously while the work completes
in a detached promise. There is **no `created[]`** on a session op — confirm completion by **polling
`assetCatalog()` / `query()`**, not by reading the dispatch result.

| Op | Args | Does |
|:--|:--|:--|
| `importAsset` | `{ destPath, sourceName?, skipUpload? }` | Cook a source file already on disk (game-relative path OK) into catalog sub-assets. A GLB/FBX yields *many* sub-assets (mesh/material/texture/**scene**, and for a rigged model **skeleton/skin/animation-clip**). |
| `addSceneAssetToScene` | `{ sceneGuid, name? }` | Instantiate a catalogued **`kind:'scene'`** sub-asset (by GUID) into the live scene as a nested SceneInstance mount — real geometry + hierarchy (incl. `Skin`/`AnimationPlayer` for skinned assets), round-trips through save→reopen→Play. **This is the last leg**: `importAsset` gets a file INTO the catalog; this gets it INTO the scene. |
| `requestReimport` | `{ paths: string[] }` | Re-cook already-imported sources (e.g. after the file changed on disk). |
| `duplicateAsset` / `renameAsset` / `destroyAsset` / `restoreAsset` | (see each `argsSchema`) | Catalog-management ops, mirrors of the Content Browser context menu. |

> [!IMPORTANT]
> **Why `addSceneAssetToScene` and not `instantiateSceneAsset` for a catalogued GUID.**
> `instantiateSceneAsset` is a **document** op that takes a *pre-collected POD* from
> `collectSceneAsset(entity)` — it needs an entity **already in the world** (it's the copy/paste
> path). A freshly-imported asset is only a **catalog GUID**, nothing in the world yet, and placing
> it requires an async `loadByGuid` — which can't ride the synchronous document applier. So the two
> are distinct legs: **`collectSceneAsset`→`instantiateSceneAsset`** duplicates a live subtree;
> **`addSceneAssetToScene`** places a catalogued GUID. `lookupAsset(sceneGuid)` returns `undefined`
> for a scene sub-asset (its payload is fetched by `loadByGuid`, not held in the catalog) — that's
> expected, not an error; use `addSceneAssetToScene`, don't try to hand-feed the POD.

End-to-end recipe — import a rigged GLB and place it (each step is one front-door call):

```ts
// 1) Cook the file on disk into the catalog (session op — fire-and-forget).
gateway.dispatch({ kind: 'importAsset', destPath: 'assets/Fox.glb', sourceName: 'Fox.glb' }, 'ai');
// → {ok:true}. NOTE: an import that writes the .meta sidecar can trigger a pack
//   disk-watch page reload; drive import and the confirm-read in SEPARATE eval calls.

// 2) Poll the catalog for the cooked scene sub-asset (no created[] on a session op).
const scene = gateway.assetCatalog().find(
  (c) => c.kind === 'scene' && (c.relativeUrl || '').toLowerCase().includes('fox'),
);

// 3) Place it — real geometry + skeleton/skin/animation, one mounts[] entry.
gateway.dispatch({ kind: 'addSceneAssetToScene', sceneGuid: scene.guid, name: 'Fox' }, 'ai');

// 4) Confirm the skinned instance landed (poll query — the mount is async).
const rigged = query({ with: ['Skin', 'AnimationPlayer'] });   // rows now include the Fox subtree
```

### Discover component names + field schemas (before you spawn / setComponent)

`spawnEntity`/`setComponent` take engine-schema components, but `listOps()`'s
`argsSchema` only declares `components: {type:'object'}` — it can't tell you a component's
field names (the set is the engine's dynamic registry, not a static schema). Use the component
read surface to learn them at runtime instead of guessing and tripping `SPAWN_FAILED`:

```ts
// "What components exist?" — the self-introspection leg parallel to listOps()/assetCatalog()
gateway.listComponents();
// → ['AnimationPlayer', 'AudioListener', …, 'Transform', …]  (sorted; same source as the
//   UNKNOWN_COMPONENT hint, so it never drifts)

// "What fields does Transform take, and of what type?" — read BEFORE building a payload
const d = gateway.describeComponent('Transform');
// → { ok:true, name:'Transform',
//     schema:   { pos:'array<f32, 3>', quat:'array<f32, 4>', scale:'array<f32, 3>', world:'array<f32, 16>' },
//     defaults: { pos:[0,0,0], quat:[0,0,0,1], scale:[1,1,1], … } }   // JSON-safe (TypedArrays snap-copied)

// Now the spawn payload writes itself — no posX/posY/posZ guesswork:
if (d.ok) gateway.dispatch({ kind:'spawnEntity', name:'Cube', components:{ Transform:{ pos:[0,1,0] } } }, 'ai');

// Unknown name → structured error listing the registered names (same shape as query's):
const miss = gateway.describeComponent('Postion');   // typo
// → { ok:false, error:{ code:'UNKNOWN_COMPONENT', hint:'component "Postion" is not registered. registered component names: …' } }
```

> [!NOTE]
> `describeComponent` / `listComponents` are **read-only gateway methods, not ops** — they don't
> appear in `listOps()` and never touch the ledger (same tier as `describeAsset`/`assetCatalog`).
> `schema` values are the engine's type keywords as strings (`'array<f32, 3>'`, `'f32'`,
> `'shared<MeshAsset>'`, `'entity'`, …). `defaults` is present only when the component declared
> layer-2 defaults; its vector values are plain `number[]` (JSON-safe), not live TypedArrays.


> [!NOTE]
> **`play` / `stop` / `cameraOrbit` / `requestFrame`** are only available after edit-runtime boots and registers
> the seam (`registerSessionApplier`). In headless (no edit-runtime, e.g. pure core scripts / tests / CI),
> they are **unregistered** — `dispatch({ kind: 'play' })` returns `UNKNOWN_OP`. Probe with `listOps()`
> before sending: if `play`/`stop` are absent, the environment does not support them. Do not blindly fire.

## Author asset-resident game logic (plugins)

A game can ship **custom components + systems** as `*.plugin.ts` files under its
`assets/` root — no code in `main.ts`. The editor's plugin loader dynamically imports every
`assets/**/*.plugin.ts` at boot; the `defineComponent` / `defineSystem` calls inside register
into the one live engine registry as an **import side effect**. This is how a component like
`Rotator` becomes attachable in the editor and a system like `rotate` runs in Play.

**You (the AI) never call the loader** — you author the `*.plugin.ts` file, then use the SAME
gateway surface as for builtin components. A plugin component is isomorphic to a builtin one:
attach with `setComponent`, read with `query`, it round-trips through the scene pack.

```ts
// games/<game>/assets/rotator.plugin.ts  — registration is an IMPORT SIDE EFFECT,
// export nothing that must be called.
import { defineComponent, defineSystem, Entity } from '@forgeax/engine-ecs';
import { Transform, quat } from '@forgeax/engine-runtime';

export const Rotator = defineComponent('Rotator', {
  axis:  { type: 'array<f32, 3>', default: new Float32Array([0, 1, 0]) }, // typed-array default REQUIRED
  speed: { type: 'f32', default: 1 },                                     // radians/sec
});

export const rotate = defineSystem({
  name: 'rotate',
  queries: [{ with: [Rotator, Transform, Entity] }], // Entity REQUIRED for bundle.Entity.self
  before: ['propagateTransforms'],
  fn: (_world, [rows]) => { /* spin Transform.quat about Rotator.axis each tick */ },
});
```

Once the file exists, the editor boots the component in and you drive it through the gateway:

```ts
// Attach a plugin component — identical to any builtin component:
const found = query({ with: ['Name'] });
const ball = found.ok && found.rows.find((r) => r.Name.value === 'BlueBall');
gateway.dispatch(
  { kind: 'setComponent', entity: ball.entity, component: 'Rotator', patch: { axis: [0, 1, 0], speed: 3 } },
  'ai',
);
query({ with: ['Rotator'] });   // → rows[].Rotator = { axis:[0,1,0], speed:3 }  (reads back like a builtin)
gateway.dispatch({ kind: 'saveDocToDisk' }, 'ai');   // persists into the scene pack — Edit == Play
```

> [!IMPORTANT]
> **Edit registers the component; Play registers the system — asymmetric on purpose.** In ✎ Edit
> the loader registers the plugin's **component only**, so you can attach/author `Rotator` but the
> ball does **not** spin (`Transform.quat` stays `[0,0,0,1]` — you don't want authored props moving
> under your cursor). Only ▶ Play's fresh world adds the plugin **systems**, so `rotate` ticks there.
> Which systems a scene runs is **derived** from which `*.plugin.ts` exist under `assets/` — it is not
> persisted per-scene, so there is no "systems" field to set.

> [!IMPORTANT]
> **Observing the rotation is a play-world read — `query(...)` reaches it directly.** `query` follows
> `gateway.activeWorld` (edit → `doc.world`, play → the live play world), the same pointer as
> `gateway.mode`, so **during play `query({ with: ['Transform'] })` returns the *play* world's live
> component columns** — re-`query` after ▶ and read the spinning `quat`; no viewport-watching needed.
> One remaining trap: `dispatch({ kind: 'play' })` returns `{ ok: true }` **before** `gateway.mode`
> flips to `'play'` (the world-fork is async, ~a frame later) — **poll `gateway.mode`** until it reads
> `'play'`, then query. Writes stay frozen during play (`dispatch` → `edit-rejected-in-play`); only the
> read follows the active world ("play data is a read-only simulation view").

## defineOp -- Compose New Operations

```ts
const result = gateway.defineOp({
  id: 'alignToGrid',
  domain: 'document',
  argsSchema: {
    type: 'object',
    properties: { step: { type: 'number' } },
    required: ['step'],
  },
  plan: (query, args) => {
    // query({ with: [...] }) → { ok:true, rows:[{ entity, Transform:{ pos:[x,y,z], quat:[x,y,z,w], scale:[x,y,z], world:[16] } }] }
    // (descriptor key is `with`, NOT `components`; result carries rows/ok).
    // Transform fields are ENGINE-schema vectors — pos/quat/scale/world — NOT posX/posY/posZ.
    const r = query({ with: ['Transform'] });
    if (!r.ok) return [];
    return r.rows.map(e => {
      const [x, y, z] = e.Transform.pos;
      return {
        kind: 'setComponent',
        entity: e.entity,
        component: 'Transform',
        patch: { pos: [snapToGrid(x, args.step), y, z] },
      };
    });
  },
});

// plan scope = querySnapshot + primitive constructors only, no world / EditSession
// gateway wraps the plan as one transaction -> one undo
// Composed op is immediately visible: listOps() now shows { id:'alignToGrid', source:'defined' }
```

### Dispatch a composed op (call the op you just defined)

`defineOp` only *registers* the op — you invoke it with the SAME `gateway.dispatch`
as any builtin. **Args are TOP-LEVEL fields on the op object, not nested under an
`args` key** (the `plan(query, args)` signature reads them off the op minus `kind`):

```ts
// ✅ correct — args flat on the op:
gateway.dispatch({ kind: 'alignToGrid', step: 1 }, 'ai');   // plan receives args = { step: 1 }

// ❌ wrong — nested `args` is a silent no-op:
gateway.dispatch({ kind: 'alignToGrid', args: { step: 1 } }, 'ai');
//   plan receives args = { args: { step: 1 } }, so args.step is undefined.
```

> [!IMPORTANT]
> **`argsSchema` IS enforced at dispatch for defined ops** — a missing `required`
> field or a wrong-typed value returns `{ ok:false, error:{ code:'INVALID_ARGS' } }`
> **before** your `plan` runs, so a bad arg can never reach the plan and corrupt the
> world. Declare the schema honestly (it is a real contract, not decoration) and
> branch on `r.ok` like any other dispatch.

- **One undo for the whole op.** A `document` composed op records a **single**
  `{ kind:'<id>' }` ledger entry (a `transaction` wrapping every sub-op) — one
  `undo()` rolls back the entire plan. This is the mirror image of a **`session`**
  composed op, whose sub-ops are flattened into the ledger as separate entries with
  no composite (see below) and are not undoable at all.
- **`listOps()` rows carry a `title`** too: a defined op shows
  `{ id, domain, source:'defined', argsSchema, title }` (title defaults to the id).

### Session-domain defineOp

```ts
gateway.defineOp({
  id: 'turnAllLightsOff',
  domain: 'session',  // session plan: sub-ops emit to ledger, NEVER undo
  argsSchema: { type: 'object', properties: {}, required: [] },
  plan: (query, _args) => {
    // query is fully open — any registered component name works
    const lights = query({ with: ['PointLight'] });
    if (!lights.ok) return [];
    return lights.rows.map(row => ({
      kind: 'setComponent',
      entity: row.entity,
      component: 'PointLight',
      patch: { intensity: 0 },
    }));
  },
});

// Dispatching a session-domain defined op:
//   Each sub-op gets its own flat ledger entry (no composite entry, D-7).
//   First failure stops execution with PLAN_STEP_FAILED + hint (failed op kind + index).
//   Already-emitted ops stay in the ledger (append-only, never pretend-rollback — AC-18).
//   Empty plan -> {ok:true} with zero ledger entries.
```

### Scoped plan -- operate on a parent's children

The most common composed op is not "scan the whole table" but "apply to a **scoped
set**" — a group's members, a row to distribute, a stack to align. The scope is
almost always **a parent's direct children**. Two equivalent ways to read that set:

```ts
// A plan that distributes a parent's direct children evenly along an axis.
gateway.defineOp({
  id: 'distributeChildren',
  domain: 'document',
  argsSchema: {
    type: 'object',
    properties: {
      parent:  { type: 'number', description: 'parent entity handle' },
      axis:    { type: 'string', enum: ['x', 'y', 'z'] },
      spacing: { type: 'number' },
    },
    required: ['parent', 'axis', 'spacing'],
  },
  plan: (query, args) => {
    // Read the group's members. Both directions work; pick by what you already query:
    //   • Parent side: query({with:['Children']}) → row.Children.entities is a real
    //     entity[] (the child handles). Enumerable directly.
    //   • Child side (used here): query({with:['ChildOf', ...]}) filtered by
    //     ChildOf.parent gives the members AND their Transform in one pass — handy
    //     when you need each child's data too. ChildOf is the SSOT; Children is the
    //     engine's derived reverse-mirror (ChildOf declares relationship:{mirror:'Children'}).
    const r = query({ with: ['ChildOf', 'Transform'] });
    if (!r.ok) return [];
    const idx = { x: 0, y: 1, z: 2 }[args.axis];
    return r.rows
      .filter(row => row.ChildOf && row.ChildOf.parent === args.parent)
      .sort((a, b) => a.entity - b.entity)   // stable order — plan must be deterministic
      .map((row, i) => {
        const pos = row.Transform.pos.slice();
        pos[idx] = i * args.spacing;
        return { kind: 'setComponent', entity: row.entity, component: 'Transform', patch: { pos } };
      });
  },
});

// Dispatch it like any op; the whole fan-out is ONE document transaction:
gateway.dispatch({ kind: 'distributeChildren', parent: groupHandle, axis: 'x', spacing: 3 }, 'ai');
//   → children land at x = 0, 3, 6, …
//   → a single gateway.undo() reverts EVERY child move at once (composite = one undo)
//   → auditLog() records ONE 'distributeChildren' entry (origin:'ai'), not the expanded setComponents
```

> [!NOTE]
> **The plan gets only `query` — no selection, no `world`.** There is no
> `gateway.getSelection()` inside a plan and `Selected` is not a queryable component
> (`query({with:['Selected']})` → `UNKNOWN_COMPONENT`). Scope a composed op by a
> parameter you pass in (a `parent` handle, an explicit entity list in `args`), not by
> reading editor UI state. This keeps the op headless-replayable — the same reason it
> takes a path, not a live selection.

> [!IMPORTANT]
> **querySnapshot is fully open**. `query({ with: [...] })` accepts ANY registered
> component name — no more whitelist of just `Transform` + `Entity`. Unknown component names now
> return a structured error `{ok:false, error:{code:'UNKNOWN_COMPONENT', hint}}` instead of
> silently ignoring (AC-16). `string` fields resolve to JSON-safe authored strings (for example,
> `row.Name.value === 'BouncyBall'`). Live-resource fields (`unique<T>` / `shared<T>` / `ref<T>` /
> buffers) remain `{kind:'opaque-handle', type, raw}` — `raw` is the engine handle VALUE. For a
> `shared<T>` asset handle, feed `raw` to `gateway.describeAsset(raw)` (identity) or
> `gateway.resolveAsset(raw)` (payload) — see "Read what asset an entity references". TypedArray
> fields (`array<T,N>`) are snap-copied into plain `number[]` — safe, JSON-serializable, no live
> column-buffer references. Variable-length `array<T>` fields (e.g. `Children.entities`, an
> `array<entity>`) also serialize to a plain snap-copied array of their elements — the member
> handles are directly enumerable, not an opaque count.

## eval -- AI Entry Channel (DEV-only)

In DEV builds, an eval channel is mounted on `globalThis.__forgeaxEval`. Access it via
`page.evaluate` in Playwright (zero network surface — OOS-9):

```ts
// From Playwright test or CLI agent:
const result = await page.evaluate(`
  __forgeaxEval.eval('gateway.listOps()')
`);
// result = { ok: true, value: [...] }

// dispatch through eval:
const r2 = await page.evaluate(`
  __forgeaxEval.eval(
    '(function() { gateway.dispatch({kind:"spawnEntity", name:"from-ai", components:{}}, "ai"); return "ok"; })()'
  )
`);
```

**scope①** = `{gateway, query, _import}` — NO world/renderer/assets (AC-02):
```ts
// Inside eval code:
typeof world        // -> 'undefined'  (scope① excludes raw engine)
gateway.dispatch(…) // -> works (gateway is injected)
query({ with: ['Transform'] })  // -> works (read-only query; descriptor key is `with`)
await _import('@forgeax/engine-ecs')  // -> works (dynamic-import seam)
```

> [!CAUTION]
> **Never `_import` an engine `dist` or `/@fs/.../engine/...` module to collect from,
> inspect, or mutate `gateway.activeWorld`.** Such imports may not share the live
> application's component-token/module graph, yielding incomplete scene assets without a useful
> error. For entity reads use `query`; for portable scene data use
> `gateway.collectSceneAsset(entity)`; for mutation use `gateway.dispatch(...)`. `_import` remains
> for application helpers that do not mix engine tokens with the live world.

**scope②** = raw engine access, dev-only. Locked by default; requires explicit unlock:
```ts
// Production build:
channel.unlockRawScope()
// -> { ok: false, error: { code: 'SCOPE_LOCKED', hint: 'scope② is dev-only...' } }

// DEV build (edit-runtime injects rawScope = { world, renderer, assets } at boot):
__forgeaxEval.unlockRawScope()   // -> { ok: true }
__forgeaxEval.eval('world.spawn(...)')  // -> world / renderer / assets now in scope
```

> [!CAUTION]
> **scope② is a debug escape hatch, not a shortcut around the door.** A raw `world.spawn`/`world.set`
> skips the ledger, undo, trace, and origin — it authors state no collaborator or `auditLog()` can see, the
> exact bypass invariant 7 forbids for humans (AGENTS.md). Author through `dispatch`/`begin…commit`; reach
> for scope② only to *inspect* raw engine internals a query can't reach. A goal that seems to *need* raw
> writes is a missing gateway op — add the op (`defineOp` / an applier), don't route around it.

**Return value**: `{ok:true, value}` on success; `{ok:false, error:{code, hint}}` on failure.
- Syntax errors -> `code: 'SCRIPT_SYNTAX_ERROR'`
- Runtime throws -> `code: 'SCRIPT_RUNTIME_ERROR'`
- Error consumption via property access (`error.code`), NOT string parsing (charter P3).

> [!CAUTION]
> **An `async` snippet returns `{ok:true, value:<Promise>}` — `eval` does NOT await for you.** Any
> snippet using `await` / `_import` (async IIFE) resolves to a Promise in `value`; await it yourself:
> ```ts
> const r = __forgeaxEval.eval('(async()=>{ const m = await _import("…"); return … })()');
> const out = r.ok && typeof r.value?.then === 'function' ? await r.value : r;
> ```
> `skills/forgeax-editor-gateway/scripts/gateway-eval.mjs` does this unwrap automatically.

> [!IMPORTANT]
> **The channel mounts BEFORE the scene finishes loading.** `waitForFunction(() => !!__forgeaxEval)`
> resolves while the async `loadByGuid → instantiate` is still in flight, so an entity/hierarchy
> query fired right at readiness sees a partial (or empty) world. Settle briefly first
> (`skills/forgeax-editor-gateway/scripts/gateway-eval.mjs` waits `--settle` ms, default 1500). Scene-independent calls
> (`listOps`, `defineOp`) need no settle — pass `--settle 0`.

## Debug rendering -- capture an RHI frame (engine capability, OUTSIDE the gateway)

> [!IMPORTANT]
> **RHI frame capture is an ENGINE debug capability, not an editor op — it is NOT in `listOps()`
> and never will be.** Black-screen / wrong-texture / wrong-binding symptoms are a rendering
> concern, not an authored edit, so capture does not enter the ledger / undo / trace. Don't hunt
> for a `captureFrame` op or add one — that would hand-roll an engine capability into the editor
> door (AGENTS.md anti-pattern #1). The "one door" is for **authored editor state**; render-debug
> is reached separately, documented here so a docs-only AI stops looking in the wrong place.

**How to reach it.** When `FORGEAX_ENGINE_RHI_DEBUG=1`, the engine mounts `globalThis.__forgeax.captureFrame(n)`
on the page. The eval channel's scope① can see `window`, so you drive it from the same
`gateway-eval.mjs` door — no new transport:

```ts
// via gateway-eval.mjs (an async snippet — the driver awaits the Promise for you):
(async () => {
  if (typeof globalThis.__forgeax?.captureFrame !== 'function') {
    return { ok: false, why: 'FORGEAX_ENGINE_RHI_DEBUG!=1 or wrong server' };
  }
  gateway.dispatch({ kind: 'requestFrame' }, 'ai');       // ensure there IS a frame to record
  const res = await globalThis.__forgeax.captureFrame(1); // records 1 frame to a tape on disk
  return res;   // { runId, tapePath, reportPath }
})()
```

Then inspect the tape **offline** (no live device) — the frame-model / per-draw inspect / dockview
viewer all live in the engine skill, which is the SSOT (do not re-derive here):

```bash
node packages/engine/packages/rhi-debug/dist/cli.mjs summary <tapePath>   # structured FrameModel (passes/draws/bindings)
```

> **Deeper:** per-draw bindings + RT PNG inspect, the four-panel viewer, tape format, error codes
> — engine skill `packages/engine/skills/forgeax-engine-rhi-debug/SKILL.md` (contract SSOT
> `packages/engine/packages/rhi-debug/README.md`).

> [!CAUTION]
> **Two traps cost more than the capture itself (both are environment, not the API):**
> - **Capture needs only the host vite.** Launch `FORGEAX_ENGINE_RHI_DEBUG=1 FORGEAX_BRIDGE=0 bun run dev`
>   (single vite, :15290; the engine boots in-process there). The two-server `dev:standalone`
>   (host :15290 + edit-runtime :15280) HMR-thrashes once rhi-debug's heavier deps (`pngjs`/`ws`)
>   load, so a headless driver rarely catches a stable window.
> - **Prove the flag actually reached the running server before blaming the API.** A leftover,
>   *unflagged* dev server squatting on :15290 makes `window.__forgeax` `undefined` — it looks like
>   "capability absent" but is "wrong server". Verify with `POST /__forgeax-debug/trigger` returning
>   **non-404** (503/409 `no-browser-tab` is the proof the plugin is registered); `curl :15290 → 200`
>   alone proves nothing.

## Scripts

`skills/forgeax-editor-gateway/scripts/gateway-eval.mjs` — boot a headless browser at a running editor, wait for `__forgeaxEval`
(+ scene settle), evaluate one snippet, await it if async, print `{ok,value|error}` JSON. Reuse this
instead of re-deriving the boot dance. Exit 1 on eval-level failure (syntax/runtime), 0 otherwise
(domain errors like `UNKNOWN_COMPONENT` ride in `value`/`error`, exit 0).

> [!NOTE]
> Both drivers share `scripts/gateway-cli-common.mjs` (SSOT for arg parsing / snippet reading /
> `{ok,value|error}` print). Flags are **strict**: an undeclared flag exits 2 with the accepted
> list — it can NEVER leak its value into the code string. Pass **only** each script's own flags:
> `gateway-eval.mjs` takes `--file/--raw/--url/--timeout/--settle`; `gateway-live.mjs` takes
> `--file/--health` (no `--settle`/`--raw`/`--url` — the live page is already booted).

```bash
# prereq: a running editor with a scene open, and playwright available:
#   editor standalone → `bun run dev:standalone` (:15290, no onboarding) + `bun run test:e2e:install`
#   studio embed       → `bun fx start` (:18920; onboarding auto-skipped; append ?scene=…&gameRoot=…)
node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs "gateway.listOps().length"                 # scene-independent
node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs "query({with:['Transform']}).rows.length"  # settles for scene first
node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs --raw "typeof world"                       # unlock scope② then eval
node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs --file snippet.js --settle 0               # snippet from file, no settle
```

| Flag / env | Effect |
|:--|:--|
| `--raw` | `unlockRawScope()` before eval (grants `world`/`renderer`/`assets`; dev-only) |
| `--file <path>` | read snippet from a file instead of argv |
| `--settle <ms>` | wait after channel-ready for the scene to finish loading (default 1500; `0` to skip) |
| `--url <url>` / `$FORGEAX_GATEWAY_URL` | target (default `http://localhost:15290`) |
| `$FORGEAX_PLAYWRIGHT` / `$FORGEAX_CHROMIUM` | point at a `playwright-core` index + chrome binary when the full `playwright` package is absent |

### Live window bridge (DEV-only)

`skills/forgeax-editor-gateway/scripts/gateway-live.mjs` evaluates a snippet in the **already-open editor window**. Unlike
`gateway-eval.mjs`, it does not create a headless browser: it routes the snippet through the
loopback relay to that page's existing `__forgeaxEval` channel, so operations affect its current
in-memory world.

> [!IMPORTANT]
> **Bridge evals run at frame start, not the instant they arrive.** A WebSocket
> message can land at any phase of the engine's rAF tick, so the page ENQUEUES
> each bridge eval and drains the queue from `app.registerUpdate` — which runs at
> frame start, before `world.update()`. Every bridge write is therefore guaranteed
> to pass through that frame's systems (deterministic, reproducible across runs).
> The reply is deferred to that drain (sub-millisecond; imperceptible). Consequence:
> if the window is not rendering (backgrounded tab → rAF paused), the queue does
> not drain and evals time out after 30s — keep the editor window in the foreground.
> This applies ONLY to the bridge; in-window UI dispatch runs synchronously.

```bash
# Starts the relay and enables the page connection by default.
bun run dev:standalone
# `bun fx start [--game DIR]` enables the bridge by default too (same relay :15295).

# In another terminal, after the editor page finishes booting:
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --health
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs "gateway.listOps().length"
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --file snippet.js

# Disable the relay/page connection for a standalone run:
FORGEAX_BRIDGE=0 bun run dev:standalone

# Use one custom port for relay, page, and CLI:
FORGEAX_BRIDGE_PORT=15305 bun run dev:standalone
FORGEAX_BRIDGE_PORT=15305 node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --health
```

`--health` exits nonzero until both the relay and page are connected. `--file <path>` reads the
snippet from a file. `FORGEAX_BRIDGE=0` is the explicit opt-out; ordinary bare Vite hosts keep the
bridge disabled. `VITE_FORGEAX_BRIDGE` and `VITE_FORGEAX_BRIDGE_PORT` are Vite build-time variables,
so restart the edit-runtime dev server after changing them.

> [!CAUTION]
> The relay accepts arbitrary JavaScript for the connected editor page. It is **DEV-only**, binds
> only to `127.0.0.1`, and must never be exposed through a public interface, port forward, or
> production deployment. Use only on a trusted local development machine. The browser bridge does
> not connect unless explicitly enabled by `dev-standalone` (or `VITE_FORGEAX_BRIDGE=1`).

## trace -- Read Span Trees

Every dispatch (including undo/redo) leaves a span tree. Read them programmatically:

```ts
// After dispatching some ops:
gateway.dispatch({ kind: 'spawnEntity', name: 'cube', components: {} }, 'ai');
const tree = gateway.trace.last();
// tree = {
//   traceId: 'a1b2...', spanId: 'c3d4...', parentSpanId: null,
//   name: 'spawnEntity', start: 1234.56, end: 1234.78, status: 'OK',
//   attributes: { engineCalls: ['world.spawn'] },
//   children: [ /* sub-spans from nested dispatchSub, if any */ ]
// } | null

// Last N root trees:
const recent = gateway.trace.recent(10);  // SpanNode[]

// From inside eval:
const r = __forgeaxEval.eval(`
  (function() {
    gateway.dispatch({kind:'spawnEntity', name:'thing', components:{}}, 'ai');
    var tree = gateway.trace.last();
    return tree ? tree.name : 'no-trace';
  })()
`);
```

Ring buffer: 256 root trees. Eviction increments `droppedTraces` (detectable, never silently discard — charter P3).

## auditLog -- "Who Did What" (ledger × origin)

To answer *"what edits happened, and were they human or AI?"* use `gateway.auditLog()` — NOT
`trace`. Three read surfaces exist and they are easy to confuse:

| Surface | What it holds | Has origin? | Use it for |
|:--|:--|:--|:--|
| `gateway.trace` | span trees (timing, `engineCalls`, `sideEffects`) per dispatch | **NO** | perf / which engine calls a dispatch made |
| `gateway.historySteps()` | undoStack-derived timeline | yes | undo/redo UI; document ops only (no session ops) |
| `gateway.auditLog()` | append-only ledger zipped with origin | **yes** | "who did what", incl. session ops (setSelection/save/play) |

```ts
// "Did the human or the AI delete that entity?"
const log = gateway.auditLog();       // [{ op: EditorOp, origin: 'human'|'ai' }], oldest→newest
const del = log.filter(e => e.op.kind === 'transaction' && /delete/.test(e.op.label ?? ''));
console.log(del.map(e => ({ label: e.op.label, who: e.origin })));
```

> [!IMPORTANT]
> `origin` is **not** a field on the ledger entry — `gateway.ledger[i]` is the bare `EditorOp`,
> its origin is `gateway.origins[i]` (index-aligned). Reading `ledger` alone makes origin look
> lost; `auditLog()` zips the two for you — use it, don't hand-zip. `trace` carries no origin, so
> it can NOT answer human-vs-AI questions. (Why two arrays: DESIGN.md §2.)

## Error Code Reference

All errors use `{ ok: false, error: { code, hint } }` return values (no exceptions).
AI branches on `error.code` by property access; hint carries actionable recovery guidance.

| code | Trigger | hint guidance |
|:--|:--|:--|
| `UNKNOWN_OP` | dispatch unknown op kind (no applier registered); includes `play`/`stop` in headless (seam not registered) | `no applier registered for "<kind>"; see listOps()`; `play`/`stop` specialized: hints edit-runtime boot required |
| `INVALID_ARGS` | session/transient args invalid (wrong type / missing required field); defineOp non-document/non-session domain | `invalid args for "<kind>": <path>: <message>` |
| `OP_ID_CONFLICT` | defineOp duplicate id | `op "<id>" already exists in catalog` |
| `PLAN_FAILED` | plan throws / returns empty or non-array | `plan threw: <message>` / `plan returned empty or non-array` |
| `PLAN_STEP_FAILED` | session-plan sub-op fails mid-sequence | failed op kind + index; already-emitted ops remain in ledger |
| `UNKNOWN_COMPONENT` | querySnapshot component name not found | lists registered component names in hint |
| `ASSET_NOT_FOUND` | resolveAsset/describeAsset given a handle resolving to no asset (slot 0 unset, stale, or not a shared<T> handle) | `no asset for handle <n>; it may be slot 0 (unset), stale, or not a shared<T> handle` |
| `OP_INTERRUPTED` | stale handle on lifecycle method (implicitly cancelled) | `operation was interrupted; begin a new one` |
| `SCOPE_LOCKED` | unlockRawScope() in production | `scope② is dev-only — run in DEV mode or request rawScope injection` |
| `SCRIPT_SYNTAX_ERROR` | eval code parse failure | `syntax error near: <msg>; fix and resubmit` |
| `SCRIPT_RUNTIME_ERROR` | eval code throws at runtime | `runtime error: <msg>; inspect error and retry` |

## Gate B Constraint

CI enforces an incremental gate: `scripts/lint-op-via-gateway.mjs` blocks any new scattered store
mutator that bypasses the gateway. **Compliant pattern**: all new operations go through
`gateway.dispatch()` or `registerSessionApplier()` (downstream seam).
**Exemptions**: `ref-request.ts` (VAG postMessage), `mesh-stats.ts` (derived statistics),
`assets-changed.ts` (change signals), `disk-watch.ts` (infrastructure init).

> [!CAUTION]
> Directly importing store/ submodule setters (e.g. `import { setSelection } from '../store/selection'`)
> in UI packages is a **violation** — all UI handlers MUST go through `gateway.dispatch()`.

## Boundaries and Guardrails

**Dead loop no interrupt (eval)**: eval runs in-process with no timeout. An infinite loop freezes
the host. Before running a loop, first `query` to bound iteration count; keep batch size small.
Host browser refresh is the only recovery.

**Session ops are irreversible**: session-domain ops write to the ledger but NEVER to the undo
stack (`setSelection`, `cameraOrbit`, `requestFrame`, `saveDocToDisk`, etc.). There is no Ctrl+Z for them.
Plan accordingly.

**Async disk continuations are outside span intervals**: the 4 async session ops
(`saveDocToDisk` / `loadDocFromDisk` / `switchSceneFile` / `createSceneFile`) fire-and-forget their
disk I/O after the applier returns synchronously. The span covers ONLY the synchronous applier body;
the detached continuation is NOT inside any span interval. This is consistent with OOS-1 and is
declared in the trace module header.

**eval reentry creates nested spans**: calling `channel.eval()` from within eval code is allowed —
stack-based span tracing naturally produces parent-child nesting. Trace trees will reflect the
reentry structure.