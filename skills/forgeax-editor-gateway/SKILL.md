---
name: forgeax-editor-gateway
description: >-
  All editor operations through a single EditGateway — dispatch (immediate op), begin/update/commit/cancel
  (continuous op), listOps (self-introspect), defineOp (compose new ops), eval (AI channel), trace (read
  span trees). Three-domain model (document/session/transient) decided by applier registration table.
  Structured errors via {ok, error}. AI entry: globalThis.__forgeaxEval in DEV builds.
  **Prefer gateway-live.mjs (live window, instant feedback) for interactive work; gateway-eval.mjs
  (headless) for CI / fresh page loads.**
  Use when building editor tools, AI-driven editing, extending the editor with new operations, or
  driving/inspecting a running editor's gateway from a script.
---

# forgeax-editor-gateway

> **Operational contract:** use `gateway.dispatch` / `gateway.begin…commit` for editor operations,
> `gateway.listOps()` before invoking capabilities, and `query({ with: [...] })` for ECS reads.
> The same operation payload is used by human UI and AI callers.

## Asset source workflow (M5)

The shortest source-authoring path is deliberately observable and one-door:

1. **Discover** with `gateway.listOps()` and select the canonical operation id.
2. **Preview** with `previewAssetSourceMutation` using `guid`, `scope.sourceKey`, `expectedRevision`, and `requestId`.
3. **Submit** `saveAssetSourceOverride` or `reimportAsset`; destructive discard uses `discardSourceOverridesAndReimport` plus the preflight `confirmationToken`.
4. **Wait** with `getOperationRun` / `waitOperationRun` / `subscribeOperationRun`; only `succeeded`, `failed`, or `cancelled` are terminal.
5. **Recover** from stable `error.code`, `expected`, `actual`, `retryable`, and `recoveryActions`; retry with a new `requestId`, or reconcile the Catalog before reading again.

The Catalog remains the immutable read SSOT. `sourceKey` and Meta `expectedRevision` are identity and
concurrency facts; they are never inferred from a path, output index, UI label, or error message. The
operation descriptors expose accepted/terminal statuses, run retention, confirmation, destructive
policy, and the recovery index: `asset.preflight`, `run.get`, `run.wait`, `run.retry`,
`catalog.reconcile`. No UI handler, file CRUD, direct DDC access, second Catalog, or transport-specific
AI registry belongs in this path.

| Stable error family | First recovery action |
|:--|:--|
| `asset-source-key-*`, `asset-meta-revision-conflict`, `asset-confirmation-*` | `asset.preflight` |
| `asset-validation-failed`, `asset-cook-failed`, `run-cancelled-before-cas` | `run.retry` with a new request id |
| `asset-publish-observation-timeout`, `asset-catalog-subscription-gap` | `catalog.reconcile`, then `run.get` |
| `asset-operation-cas-committed` | `run.get` / `run.wait`; do not submit a duplicate mutation |

> [!IMPORTANT]
> This file is the call surface. The gateway-specific rationale lives in `DESIGN.md`; play/stop
> world-fork semantics live in `docs/skills/forgeax-editor-gateway.md`.
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
| `session` | `sessionAppliers` | ledger only (irreversible, auditable) | setSelection / saveDocToDisk / requestFrame / captureFrame / play / stop / cameraOrbit |
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

> [!IMPORTANT]
> **Scope① has two separate surfaces.** `gateway` is the operation/read-model object;
> `query` is an independent read-only function. Use `gateway.dispatch(...)` / `gateway.listOps()`
> for operations and `query({ with: ['Name', 'Transform'] })` for ECS snapshots. Do not call
> `gateway.query(...)` or pass `query({ components: [...] })`.

| Need | Correct entry | Common wrong entry |
|:--|:--|:--|
| Discover or invoke an editor operation | `gateway.listOps()` / `gateway.dispatch(op, origin)` | `query(...)` |
| Read live ECS component rows | `query({ with: ['Name', 'MeshRenderer'] })` | `gateway.query(...)` / `{ components: [...] }` |
| Read asset meaning from an opaque handle | `gateway.describeAsset(raw)` / `gateway.resolveAsset(raw)` | Guessing the numeric handle |

## First-call protocol

Run these calls in order. Each later call depends on the previous one succeeding.

| Step | Call | Stop condition |
|:--|:--|:--|
| 1. Transport | `gateway-live.mjs --health` | `pageConnected: true` |
| 2. Capability | `gateway.listOps()` | Required operation id is present |
| 3. Read state | `query({ with: ['Name', 'Transform'] })` | Result is `{ ok: true, rows }` |
| 4. Mutate / act | `gateway.dispatch(op, 'ai')` | Result is `{ ok: true }`; for async ops, await `gateway.waitOperationRun(requestId)` |
| 5. Diagnose | `error.code`, `error.hint`, `gateway.trace.last()` | Retry only after reading the structured error |

For standalone editor use relay `:15296`. Studio no longer owns a `:15295` eval relay:
use the server-side typed `editor_transport` host tool or `/api/editor/transport`, which
executes in the connected in-process Editor realm. If a custom `FORGEAX_BRIDGE_PORT` is set,
use the same value for the standalone dev stack and CLI.
The health response also reports `evalTimeoutMs`; this is the relay wait budget,
not an operation completion signal.

> [!CAUTION]
> `gateway-live.mjs` receives one shell argument. If the snippet contains string literals,
> shell quoting can remove those quotes before eval (for example `requestId='capture-x'` can
> arrive as `requestId=capture-x`). Use `--file <path>` for async or multi-line snippets; for
> a one-liner, pass JSON-style double quotes through the shell and keep the snippet itself valid JS.

**Trace**: every dispatch/undo/redo produces a span tree. Read them via
`gateway.trace.last()` / `gateway.trace.recent(n)` — plain-object trees with OTel-aligned fields
(traceId/spanId/parentSpanId/name/start/end/attributes/status). Nested dispatches auto-link
parent->child spans. Ring buffer retains the last 256 root trees; eviction increments a
readable `droppedTraces` counter.

## How to drive the gateway (pick the right tool)

There are **two drivers** to run gateway code from a script. **Prefer the live bridge** —
it's sub-millisecond, shares the in-memory world, and needs no playwright setup. The
headless driver is only for CI / fresh-page-loads.

| Driver | Script | How it works | When to use |
|:--|:--|:--|:--|
| **Live bridge** (preferred) | `scripts/gateway-live.mjs` | POSTs JS to the loopback relay → your open editor window's `__forgeaxEval` | **Default.** Interactive work, quick probes, continuous gestures. Same in-memory world — a spawn shows up instantly, no save+refresh. |
| Headless browser | `scripts/gateway-eval.mjs` | Spawns a fresh headless Chromium via Playwright, navigates to the editor, waits for settle | CI / fresh page loads / verify save→reopen round-trips. Separate browser instance — shares only the disk backend. |

> [!TIP]
> **The simplest decision:** if you have an editor window open, use `gateway-live`. If you're in CI
> or need a fresh page for a round-trip test, use `gateway-eval`.

### Quick start — live bridge

```bash
# 1) Start the editor (relay on :15296 + bridge enabled by default):
bun run dev:standalone
#   or: bun fx start --game games/sample --bg

# 2) Check the bridge is alive:
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --health

# 3) Drive the open window:
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs "gateway.listOps().length"
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --file snippet.js
# Long async evals (captureFrame, import, save) can use an explicit relay budget:
node skills/forgeax-editor-gateway/scripts/gateway-live.mjs --file capture.js --timeout 120000
```

### Quick start — headless (CI / fresh page)

```bash
# prereq: bun run test:e2e:install (once) + a running editor
node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs "gateway.listOps().length"
node skills/forgeax-editor-gateway/scripts/gateway-eval.mjs --file snippet.js --settle 0
```

> [!NOTE]
> Live bridge evals run at frame start (`app.registerUpdate`), not the instant they arrive —
> the page enqueues each eval and drains the queue before `world.update()`. This means
> writes are deterministic through the frame's systems. If the window is backgrounded
> (rAF paused), the queue stalls and the relay eventually returns `EVAL_TIMEOUT`; keep the
> editor window in the foreground. Details in §Scripts below.

## Core API Quick Reference

### Save terminal contract

`saveDocToDisk` is a Gateway session operation with a caller-owned `requestId`. The toolbar, keyboard
router, AI, and product transport all submit the same payload through `gateway.dispatch`:

```ts
const accepted = gateway.dispatch({
  kind: 'saveDocToDisk',
  requestId: 'save-20260730-1',
}, 'ai');
```

Acceptance is not completion. Read the Gateway-owned run by `requestId` with `getOperationRunResult`
or `waitOperationRun`; terminal success is published only after the canonical disk effect commits.
Save is deliberately non-cancellable. Retry uses a fresh requestId and preserves the failed run as the
parent attempt. Unknown, expired, conflicting, and unavailable requests remain structured errors with
machine-readable `code`, `retryable`, and `recoveryActions`; do not parse `hint`.

Product transport projects this same owner through `run.dispatch`, `run.get`, `run.wait`, `run.retry`,
and `run.cancel`. Generic non-save runs continue to use their existing transport journal.

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
| `gateway.assetCatalog()` | `() => readonly catalog rows` | List the canonical producer catalog (including `relations`, `refs`, source and authoring facts); [] if no registry |
| `gateway.assetImpact(request)` | `(request: {operation: 'delete'\|'move'\|'reimport', guid?, sourcePath?}) => AssetImpactResult` | Derive bounded direct/transitive referencers from the current producer catalog; read-only, no second index |
| `gateway.sceneReadModel()` | `() => {gameId, currentScene, defaultScene, scenes}` | Read the persistence-owned scene list with stable GUIDs and derived current/default markers; []/null fields mean no game or no declared scene |
| `gateway.hasPendingDiskSave()` | `() => boolean` | Read the persistence-owned authored-vs-disk dirty fact shared by AI and the human dirty indicator |
| `dispatch({kind:'switchSceneFile', id, dirtyPolicy?})` | `dirtyPolicy: 'save' \| 'discard' \| 'cancel'` when dirty | Switch through the scene-list owner; omitting policy on dirty state returns `scene-switch-dirty`, and `cancel` returns `scene-switch-cancelled` without switching |
| `gateway.lookupAsset(guid)` | `(AssetGuid\|string) => Asset \| undefined` | Look up a catalogued asset payload by GUID (catalog only, no fetch) |
| `gateway.listComponents()` | `() => readonly string[]` | Self-introspect all registered component names (sorted). The "what components exist?" leg, parallel to listOps (ops) / assetCatalog (assets). Same source as the UNKNOWN_COMPONENT hint |
| `gateway.describeComponent(name)` | `(string) => {ok:true, name, schema, defaults?, enums?, shapes?, transient?} \| {ok:false, error}` | Field schema of one component (field→type-keyword map + JSON-safe defaults; producer-owned enum labels, semantic shapes, and derived-field markers when declared) — the answer to "what fields does Transform take?" BEFORE building a spawn/setComponent payload. Unknown name → UNKNOWN_COMPONENT listing registered names |
| `gateway.defineOp(def)` | `(OpDefinition) => DefineResult` | Compose new document/session op (id + argsSchema + plan -> transaction or session-plan) |
| `gateway.trace.last()` | `() => SpanNode \| null` | Read most recent root span tree (plain-object, AC-10) |
| `gateway.trace.recent(n)` | `(n: number) => SpanNode[]` | Read last N root span trees |
| `gateway.auditLog()` | `() => ReadonlyArray<{op, origin}>` | "Who did what" — the append-only ledger zipped with its index-aligned origin ('human'\|'ai'), oldest→newest; includes irreversible session ops (setSelection/save/play), unlike undoStack-derived `historySteps()` |
| `gateway.undo()` / `gateway.redo()` | `() => boolean` | Roll the document timeline back / forward one step. **Returns a bare `boolean`** (did-something), **NOT `DispatchResult`** — there is no `.ok`. `false` = nothing to undo/redo (empty stack). Gate with `canUndo()`/`canRedo()`, don't branch on `.ok`. Session ops (setSelection/save/play) are NOT on this stack — see "Session ops are irreversible" |
| `gateway.canUndo()` / `gateway.canRedo()` | `() => boolean` | Whether the undo/redo stack is non-empty — the guard for undo/redo UI buttons and for a docs-following AI's loop condition |
| `gateway.appliedCount()` | `() => number` | Number of currently-applied document steps (the timeline head position); pairs with `jumpTo(n)` |
| `gateway.historySteps()` | `() => HistoryStep[]` | undoStack-derived timeline (applied oldest→newest, then redoable future), each with origin; **document ops only** (no session ops — use `auditLog()` for those) |
| `gateway.historyDiff(index)` | `(number) => HistoryDiff \| undefined` | One bounded, one-based review projection from the same timeline entry: `{index, label, origin, future, entity?, op, inverse}`; `op` applies the change and `inverse` returns to the prior state |
| `registerSessionApplier(kind, applier, meta?)` | `(string, fn, meta?) => () => void` | Downstream registration seam: edit-runtime registers play/stop/cameraOrbit/requestFrame/captureFrame appliers |
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

// setComponent PATCHES an existing component; addComponent ATTACHES a new one —
// and they use DIFFERENT field names: setComponent takes `patch`, addComponent
// takes `value`. Mixing them is a common reflex; the gateway now rejects it with a
// structured error (never a thrown TypeError) so a wrong field is self-correcting:
//   setComponent{ entity, component, patch: {…} }   // patch an existing component
//   addComponent{ entity, component, value: {…} }   // attach a new component
// A missing/malformed required field on ANY builtin document op → {ok:false,
// error:{code:'INVALID_ARGS', hint}} at the door (same Fail-Fast validation
// session/transient ops always had). e.g. setComponent without `patch`:
//   → { ok:false, error:{ code:'INVALID_ARGS',
//        hint:'invalid args for "setComponent": patch: missing required field "patch"' } }
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
const catalog = gateway.assetCatalog();           // canonical rows: [{ guid, kind, packageUrl, relations?, refs? }]
const payload = gateway.lookupAsset(someGuid);    // Asset | undefined (catalog only) — FULL payload

// Following a GUID pointer (e.g. a material's texture binding)? Use the LIGHTWEIGHT
// by-GUID leg — NOT lookupAsset, which drags the whole binary buffer into scope:
const t = gateway.describeAssetByGuid(someGuid);
// → { ok:true, kind:'texture', guid, name, meta:{ width, height, format, colorSpace, mipmap } }
//   `meta` = the POD's own fields with the heavy buffers (pixels/vertices) STRIPPED.
```

The asset read surface is a 2×2 matrix — pick the cell by *how you address it* × *how much you want*:

| address ↓ / want → | full payload (heavy) | lightweight summary |
|:--|:--|:--|
| by **handle** (`query`'s `opaque-handle.raw`) | `resolveAsset(handle)` | `describeAsset(handle)` |
| by **GUID** (a catalog / POD pointer) | `lookupAsset(guid)` | `describeAssetByGuid(guid)` |

`describeAsset` / `describeAssetByGuid` return the **same** `AssetSummary` shape (one SSOT
projection): `{ kind, guid?, name?, builtin?, meta? }`. `meta` carries the POD's own lightweight
fields (a texture's `width`/`height`/`format`, a mesh's `attributes`, …) with binary buffers
removed — so it is safe to log/inspect. Reach for `resolveAsset`/`lookupAsset` **only** when you
actually need the pixels/vertices.

### Preview asset impact before a destructive or source operation

The producer catalog is the graph authority. `gateway.assetImpact` folds its current `relations`
into the bounded impact of one catalog GUID or one source path; it does not retain an editor-side
dependency index. Rows without producer relations use the catalog's legacy `refs` projection, so
older packs remain inspectable while they migrate. A source path may resolve to several imported
outputs from one source file.

```ts
const preview = gateway.assetImpact({ operation: 'delete', guid: materialGuid });
if (preview.resolution !== 'resolved') throw new Error(preview.hint ?? 'asset selector unresolved');
if (preview.blocking) {
  // Show preview.directReferencers / preview.transitiveReferencers to the user
  // before dispatching the existing delete op.
}

const reimportPreview = gateway.assetImpact({ operation: 'reimport', sourcePath: 'models/hero.glb' });
// reimportPreview.targets = every catalog output of the source file
```

The preview is a pure read. It never mutates, deletes, moves, or reimports; the existing registered
Gateway operations remain the write owner. Callers must pass exactly one selector (`guid` or
`sourcePath`) and must treat `blocking`, `confirmation.required`, and the returned relation
provenance as facts to present or record before invoking a destructive operation.

```ts
// Inspect what texture a material binds — WITHOUT a multi-MB pixel dump:
const mr = query({ with: ['MeshRenderer'] });
const matHandle = mr.rows[0].MeshRenderer.materials[0];        // shared<MaterialAsset> handle
const mat = gateway.resolveAsset(matHandle as number);         // material POD is small
const texGuid = mat.ok && mat.asset.values?.baseColorTexture;  // → a GUID string
if (texGuid) gateway.describeAssetByGuid(texGuid);            // { kind:'texture', meta:{width,height,format} }
//                    ^ do NOT lookupAsset(texGuid) here — that returns every pixel.
```

> [!IMPORTANT]
> `shared<T>` is the engine's general shared-ref store — "asset" is its common use,
> not its definition. Not every `shared<T>` has a GUID: **builtin** meshes
> (`HANDLE_CUBE`/`HANDLE_TRIANGLE`) live in a process-static registry, not the
> asset catalog, so `describeAsset` returns `{builtin:true}` with no `guid`/`name`.
> `resolveAsset` still returns their payload (it covers builtin + catalog). `raw`
> of `0` = unset slot; a stale/unknown handle → `{ok:false, code:'ASSET_NOT_FOUND'}`;
> `describeAssetByGuid` on an unknown/uncatalogued GUID → the same structured miss.
> `unique<T>`/`ref`/`buffer` stay opaque (no catalog GUID; not resolved here).

### Import an external asset, then place it in the scene (the asset WRITE legs)

The read legs above (`assetCatalog`/`describeAsset`/`resolveAsset`/`lookupAsset`) answer *"what
assets exist?"*. The **write legs** are ordinary `dispatch` ops — the same door humans use from the
Content Browser, so an AI is an equal peer (registry razor). They are **session-domain, ledger-only**
(no undo — a cook/instantiate produces derived artefacts) and, because they do disk / `loadByGuid`
I/O, **request-correlated async**: `dispatch` returns `{ok:true, result:{operationRun}}`
synchronously while the work completes in the Gateway-owned OperationRun. There is **no
`created[]`** on a session op; read the terminal fact with `getOperationRun()`,
`waitOperationRun()`, or `subscribeOperationRun()` using the same caller-minted `requestId`.
Concurrent requests have independent runs; never infer completion from a singleton phase, a
wrapper entity, or a host log.

| Op | Args | Does |
|:--|:--|:--|
| `importAsset` | `{ destPath, sourceName?, skipUpload?, requestId }` | Cook a source file already on disk (game-relative path OK) into catalog sub-assets. A GLB/FBX yields *many* sub-assets (mesh/material/texture/**scene**, and for a rigged model **skeleton/skin/animation-clip**). Read its terminal OperationRun with the same `requestId`. |
| `previewImportedScene` | `{ guid, sourceKey, revision, sourcePath?, requestId }` | Open the exact effective imported SceneAsset as a read-only preview and retain its immutable effective snapshot. Ordinary double-click uses this operation; it never creates an authored write target. |
| `promoteImportedScene` | `{ importedGuid, sourceKey, revision, targetPackPath, targetName, contentPolicy, discardSourceChanges?, requestId }` | Create a new authored scene pack with a new GUID. `contentPolicy` is mandatory: `effective-base` uses the retained immutable effective snapshot; `current-session` is accepted only in a supported imported-source-edit session and uses Engine world collection. A dirty `effective-base` request must explicitly set `discardSourceChanges:true`. The target must be an unused game-relative `assets/**/*.pack.json`; Promote never writes source/meta/DDC. |
| `addSceneAssetToScene` | `{ sceneGuid, name?, requestId }` | Instantiate a catalogued **`kind:'scene'`** sub-asset (by GUID) into the live scene as a nested SceneInstance mount — real geometry + hierarchy (incl. `Skin` + `Skeleton` joints for a rigged asset), round-trips through save→reopen→Play. **This is the last leg**: `importAsset` gets a file INTO the catalog; this gets it INTO the scene. **It does NOT create an `AnimationPlayer`** — see "Animate a skinned asset" below. `requestId` is the independent OperationRun identity for this mount. If async load/instantiate fails, the provisional wrapper is rolled back through `destroyEntity`; inspect terminal `error.current.cleanup` for `{ attempted, ok, wrapper }` facts (or a structured cleanup error) before retrying. |
| `createMaterial` | `{ guid, name, baseColor:[r,g,b,a], metallic?, roughness?, packPath?, refs? }` | **AUTHOR a NEW PBR material from params** — the create-a-look counterpart to `bindAssetRef`'s bind-an-existing-look. Mints a `MaterialAsset` (POD built by the engine's canonical `Materials.standard()` — 3-pass GBuffer+Forward+ShadowCaster) into the pack; document-domain (undoable, inverse `destroyAsset`). **You mint `guid` yourself** (`crypto.randomUUID()`) — the op returns no minted value (the dispatch result carries only entity handles), so reuse the SAME guid for the follow-up `bindAssetRef`. **Omit `packPath`** — it defaults to the active scene's real pack (the same one the scene saves to, so it round-trips Edit=Play); only pass it (game-relative, e.g. `"sample/assets/scene.pack.json"`) to target another pack. Author-then-bind: `createMaterial{guid,name,baseColor,metallic,roughness}` → `bindAssetRef{entity, component:'MeshRenderer', field:'materials', assetType:'MaterialAsset', guids:[guid], slot}`. |
| `bindAssetRef` | `{ entity, component, field, assetType, guids, slot?, requestId }` | **Bind catalogued asset GUIDs into a `shared<T>` component field** — the async GUID→handle binder (`loadByGuid`→`allocSharedRef`) followed by an undoable `setComponent`. Its terminal OperationRun reports target, GUIDs, resolved handles, and scalar/array/slot shape. Owned entities and mount members are supported; mount-member shared refs fold into `mounts[].overrides[]` on save. `addComponent`/`setComponent` also resolve already-catalogued GUID strings synchronously. |
| `requestReimport` | `{ paths: string[] }` | Re-cook already-imported sources (e.g. after the file changed on disk). |
| `duplicateAsset` / `renameAsset` / `destroyAsset` / `restoreAsset` | (see each `argsSchema`) | Catalog-management ops, mirrors of the Content Browser context menu. |

Placement callers share the producer-owned plan surface. `planAssetPlacement(ref, options)` is a
read-only editor-core helper: it projects the asset's `authoring.placement` descriptor and returns
the exact `spawnEntity` or `addSceneAssetToScene` Gateway args. Content Browser drag, context-menu
placement, and the edit-runtime bridge must dispatch those returned args unchanged; an unavailable
producer capability is a structured refusal. AI callers can dispatch the same returned operation
shape directly through the Gateway, so the plan is not a second mutation path.

The human feedback surface is the same projection, not a placement-specific status store. The
Operation Center derives `addSceneAssetToScene` and `bindAssetRef` subject facts from the versioned
Gateway OperationRun snapshot: scene/asset identity, wrapper or target entity, component/field,
source path, and `error.current.cleanup` when rollback was attempted. Its `inspect` action selects
the affected entity or asset through Gateway session ops; `reveal-source` dispatches the existing
`revealInFileManager` op; `retry` always uses a fresh requestId and the same operation. A UI may
show the recovery action, but it must not infer terminal state from a toast or console message.

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
// 1) Cook the file on disk into the catalog (session op — request-correlated).
const importRequestId = crypto.randomUUID();
gateway.dispatch({ kind: 'importAsset', destPath: 'assets/Fox.glb', sourceName: 'Fox.glb', requestId: importRequestId }, 'ai');
const imported = await gateway.waitOperationRun(importRequestId);
if (!imported.ok || imported.value.status === 'failed') throw new Error('import failed');
// NOTE: an import that writes the .meta sidecar can trigger a pack disk-watch page reload;
// drive import and the catalog confirm-read in SEPARATE eval calls when the host reloads.

// 2) Poll the catalog for the cooked scene sub-asset (no created[] on a session op).
const scene = gateway.assetCatalog().find(
  (c) => c.kind === 'scene' && (c.relativeUrl || '').toLowerCase().includes('fox'),
);

// 3) Place it — real geometry + skeleton/skin, one mounts[] entry. (No AnimationPlayer — see below.)
const mountRequestId = crypto.randomUUID();
gateway.dispatch({ kind: 'addSceneAssetToScene', sceneGuid: scene.guid, name: 'Fox', requestId: mountRequestId }, 'ai');

// 4) Read this mount's independent terminal fact, not a latest-only phase or a component query.
const mounted = await gateway.waitOperationRun(mountRequestId);
if (!mounted.ok || mounted.value.status === 'failed') throw new Error(mounted.ok ? mounted.value.error?.hint : mounted.error.hint);

// 5) Confirm the skinned instance landed. Query by semantic component — mount
// descendants do not inherit the wrapper's Name.
const rigged = query({ with: ['Skin'] });   // rows now include the Fox subtree (an entity carrying Skin)
```

> [!IMPORTANT]
> **What lands is a wrapper + a subtree — query by the COMPONENT, not the wrapper name.**
> `addSceneAssetToScene` mounts an identity-`Transform` **wrapper** entity (named by `name`)
> whose CHILDREN carry the actual `MeshRenderer` / `Skin` / geometry. Filtering by the wrapper's
> name and expecting a `MeshRenderer` on it sees nothing → a false "it didn't land". First wait for
> the mount's `waitOperationRun(requestId)` result to reach `succeeded` (or branch on its structured
> `failed` error), then query by the component you want (`query({ with: ['MeshRenderer'] })`) to
> catch the mesh children. For a
> multi-material scene, a non-empty `MeshRenderer.materials` array is semantic mount evidence; do
> not expect the derived mesh child to carry the wrapper name.
> Also: the mount is **async** and **each headless `gateway-eval.mjs` call is a fresh page load
> (= a reopen from disk)** — a mount you placed but did NOT `saveDocToDisk` is gone on the next
> eval. Place → inspect → **save** within one eval if you need it to persist; a *separate* eval is
> already the reopen (that is exactly how you verify a save→reopen round-trip).

> [!CAUTION]
> **Animate a skinned asset — mount override support and limits.**
> The mount gives you the `Skin` + skeleton joints, **not a playing animation**. That is correct by
> design: the gltf cook emits the clips as separate `kind:'animation-clip'` catalog sub-assets and
> deliberately does **not** bake an `AnimationPlayer` — *which* clip plays is authoring intent, so YOU
> author it. The intended shape (mirrors `apps/hello/skin`): find the entity carrying `Skin`, then
> `dispatch({ kind:'addComponent', entity, component:'AnimationPlayer', value:{ clips:[<clip>], weights:[1], looping:true } })`
> (`addComponent`, **not** `setComponent` — `setComponent` only patches a component that already exists).
> `describeComponent('AnimationPlayer')` gives the field schema (`clips/times/weights/speeds/paused/looping`).
> **Clip binding and mount-member round-trip:**
> 1. **Bind the clip GUID with `bindAssetRef`, NOT raw `addComponent`.** `clips` belongs to
>    a producer-declared `slots` group that keeps `clips`, `times`, `weights`, and `speeds` the same length;
>    passing a clip **GUID** to `addComponent`/`setComponent` is silently coerced to handle `0` (they pass
>    component data raw). Use the front-door binder instead:
>    `dispatch({ kind:'bindAssetRef', entity, component:'AnimationPlayer', field:'clips', assetType:'AnimationClip', guids:[clipGuid], slot:0, requestId: crypto.randomUUID() })`
>    — it resolves the GUID (`loadByGuid`→`allocSharedRef`) and writes the live handle. (First `addComponent`
>    an `AnimationPlayer` with the scalar params — `weights/speeds/paused/looping` — then `bindAssetRef` the
>    `clips`; wait on the same requestId for terminal success/error. For a second clip use `slot:1`; the
>    binder pads the parallel columns with their producer defaults before one document write. A bad or
>    uncatalogued GUID reaches a terminal structured `ASSET_NOT_FOUND` result without changing the arrays.
>    This closes the old "no clip-binding leg" gap for **owned** and mounted entities (solo rounds 11 and
>    R1-04).
> 2. **Mount-member component add, field patch, and shared refs round-trip.** The public `setComponent`
>    door automatically projects a mounted member's ordinary patch onto the engine-owned
>    `setSceneOverride` path, so AI and Inspector callers do not need a private projection. The document
>    applier expands a `slots` field into one complete parallel-group patch with rollback/inverse semantics.
>    The engine collector folds these edits into the parent authored pack's `mounts[].overrides[]`.
>    Component removal, member deletion, structural reparent, and entity-reference patches are not
>    representable in v1 and are rejected by the editor before mutating the World.

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
//     defaults: { pos:[0,0,0], quat:[0,0,0,1], scale:[1,1,1], … },
//     shapes?: { pos:'vector', quat:'quaternion' }, enums?: {...}, transient?: {...} }
//   // JSON-safe (TypedArrays snap-copied); optional producer fields are omitted
//   // from these maps when their producer has no corresponding annotation.

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

### Author physics through the component schema

Physics is authored with the same document operations as every other engine component. There is no
physics-only mutation registry to keep in sync with the Inspector:

| Intent | Component facts | Gateway shape |
|:--|:--|:--|
| Fixed/static scenery | `RigidBody.type = 0` (`static`) or `Collider` alone for an implicit fixed body | `spawnEntity` / `addComponent` |
| Dynamic body | `RigidBody.type = 1` (`dynamic`), mass/damping/CCD | `spawnEntity` / `setComponent` |
| Kinematic character | `RigidBody.type = 2` (`kinematic`) + capsule `Collider` + `CharacterController` | `spawnEntity` / `setComponent` |
| Collision shape/filter | `Collider.shape = 0/1/2` (`cuboid`/`sphere`/`capsule`), `halfExtents`, `radius`, `halfHeight`, friction/restitution, sensor, collision/solver groups | `spawnEntity` / `setComponent` |

```ts
const rb = gateway.describeComponent('RigidBody');
const collider = gateway.describeComponent('Collider');
const controller = gateway.describeComponent('CharacterController');
// Use rb.enums.type and collider.enums.shape; do not guess numeric enum values.

gateway.dispatch({
  kind: 'spawnEntity',
  name: 'Physics Character',
  components: {
    Transform: { pos: [0, 1, 0] },
    RigidBody: { type: 2 },
    Collider: { shape: 2, radius: 0.3, halfHeight: 0.5 },
    CharacterController: { maxSlopeClimbDeg: 40, snapToGroundDist: 0.25 },
  },
}, 'ai');
```

> [!CAUTION]
> `restitution`, `friction`, `isSensor`, `collisionGroups`, and `solverGroups` belong to
> `Collider`; `ccdEnabled`, `mass`, `gravityScale`, and damping belong to `RigidBody`. A wrong field
> is rejected as a structured `SPAWN_FAILED` / `SET_FAILED` error before mutation. Fixed arrays such as
> `Collider.halfExtents` require exactly three numbers and report `details.fieldPath` on failure.

Collision status is a Play-only read projection. Query `CollidingEntities` after `play` reaches the
terminal `gateway.playPhase === 'play'`; it is transient, is stripped from authored packs, and must not
be added to a scene as a persistence workaround. In Edit, selecting an entity with `Collider` shows the
selection-derived wireframe in the viewport; the DebugDraw lines are transient chrome and create no
ledger entry or pack data. The current engine contract has no single `compound` field: a compound-shaped
authored arrangement is a parent with multiple collider-bearing child entities; a true single-body
compound requirement belongs to the Engine physics contract rather than an editor-side shadow format.

### Author spatial audio through the component schema

Audio uses the same Gateway document path. Discover the producer contract first, import a real audio
source through the correlated `importAsset` run, then author a listener and source explicitly. An audio
catalog row may truthfully report no generic drag-placement capability; that does not block the typed
`AudioSource.clip` binding path below.

```ts
const sourceSchema = gateway.describeComponent('AudioSource');
const listenerSchema = gateway.describeComponent('AudioListener');
// AudioSource: clip shared<AudioClipAsset>, playing bool, loop bool, volume f32,
// spatialBlend f32, bus string. AudioListener is an empty marker component.

const listener = gateway.dispatch({
  kind: 'spawnEntity',
  name: 'Main Audio Listener',
  components: { Transform: { pos: [0, 1, 4] }, AudioListener: {} },
}, 'ai');
const source = gateway.dispatch({
  kind: 'spawnEntity',
  name: 'Spatial Music Source',
  components: {
    Transform: { pos: [0, 1, 0] },
    AudioSource: { playing: true, loop: true, volume: 0.4, spatialBlend: 1, bus: 'music' },
  },
}, 'ai');

const audio = gateway.assetCatalog().find((asset) => asset.kind === 'audio');
if (audio && source.ok) {
  const bind = gateway.dispatch({
    kind: 'bindAssetRef', entity: source.result.created[0],
    component: 'AudioSource', field: 'clip', assetType: 'AudioClipAsset',
    guids: [audio.guid], requestId: 'audio-bind-1',
  }, 'ai');
  const terminal = bind.ok ? await gateway.waitOperationRun('audio-bind-1') : bind;
}
```

`bus` uses the engine audio buses `sfx` and `music`; `spatialBlend` is the 2D↔3D mix, while `playing`,
`loop`, and `volume` are authored runtime controls. Use the Inspector to select the same source: it
projects the clip GUID, booleans, numeric controls, and bus from the live component and dispatches the
same `setComponent`/`bindAssetRef` operations. Save with `saveDocToDisk`, reopen, and query both
`AudioSource` and `AudioListener` before Play. During Play, query those components again and require
`playPhase === 'play'`; Stop must return to Edit without leaving a second audio world or listener.

An invalid scalar (for example `AudioSource.volume: 'loud'`) fails before mutation with
`SET_FAILED` and `details.fieldPath: 'AudioSource.volume'`; correct the value and retry through
`setComponent`. Do not emulate decoder, device, bus, or spatial behavior in editor code. The empty
`AudioListener` marker is authored state and must survive scene-pack serialization; only components
declared `transient: true` are derived and excluded from save.

> [!IMPORTANT]
> **Camera post-processing lives on the `Camera` component, NOT `PostProcessParams`.** The knobs you
> reach for — `tonemap` / `exposure` / `whitePoint` / `bloom` / `bloomThreshold` / `bloomIntensity` /
> `bloomBlurRadius` / `clearColor` — are scalar fields on `Camera` (`describeComponent('Camera')`), so you
> author them exactly like light/shadow scalars: `spawnEntity{components:{Camera:{tonemap:1, bloom:1,
> exposure:1.3, …}}}` (author) or `setComponent{entity, component:'Camera', patch:{exposure:0.9}}` (tune),
> then `saveDocToDisk` — they round-trip byte-faithful to disk (Edit=Play). The separately-named
> `PostProcessParams` component (`{shader:'string', data:'buffer'}`) is a DIFFERENT thing: a low-level
> custom-fullscreen-shader escape hatch (register a shader id + raw params bytes for a bespoke pass), not
> the home of production tonemapping/bloom. Don't reach for `PostProcessParams` to turn on bloom — the name
> is a trap; use `Camera`. (solo round-14)


> [!NOTE]
> **`play` / `stop` / `cameraOrbit` / `requestFrame` / `captureFrame`** are only available after edit-runtime boots and registers
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
> One remaining trap: `dispatch({ kind: 'play' })` returns `{ ok: true }` **before** play actually
> starts — the world-fork is async (~a frame later) and CAN fail (bad scene → it degrades back to edit).
> `{ ok: true }` only means "the play request was accepted", not "play is running". **Poll
> `gateway.playPhase`** — a terminal-aware view (`'edit'` → `'starting'` → `'play'` \| `'failed'`) — until
> it reads a *terminal* value: `'play'` (assembled, query the live world) or `'failed'` (read
> `gateway.lastPlayError` for why; `gateway.mode` stays `'edit'`). Do **not** blind-poll `gateway.mode`
> alone: on a failed assemble it never flips, so a `mode`-only poller waits forever for a play that will
> never come (the round-3/5 trap). Writes stay frozen during play (`dispatch` → `edit-rejected-in-play`);
> only the read follows the active world ("play data is a read-only simulation view").

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
> handles are directly enumerable, not an opaque count. **`bool` fields project to a real JS
> `boolean`** (`true`/`false`), matching the engine `world.get` and the on-disk pack — so
> `if (row.DirectionalLight.castShadow === true)` works; do NOT compare a bool against `1`. Other
> scalars (`f32`/`i32`/`enum`/…) stay `number`.

## eval -- AI Entry Channel (DEV-only)

In DEV builds, an eval channel is mounted on `globalThis.__forgeaxEval`. Access it via
`page.evaluate` in Playwright, or — preferred — through the **live bridge** (`gateway-live.mjs`)
which routes to the same channel in your open editor window. See §How to drive the gateway
and §Scripts for the full decision table.

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

## Debug rendering -- capture an RHI frame through the gateway

> [!IMPORTANT]
> **RHI frame capture is a session-domain gateway operation.** It is intentionally not an
> authored document edit, so it enters the session ledger but not the undo stack. The engine's
> `globalThis.__forgeax.captureFrame` is an implementation seam owned by edit-runtime; callers
> must discover and invoke the gateway operation instead of reaching that global directly.

**How to reach it.** When `FORGEAX_ENGINE_RHI_DEBUG=1`, edit-runtime registers `captureFrame`
into the live gateway. Discover it with `gateway.listOps()`, dispatch a request-correlated
operation, then await its terminal result:

```ts
// via gateway-live.mjs or gateway-eval.mjs:
(async () => {
  const op = gateway.listOps().find((item) => item.id === 'captureFrame');
  if (op === undefined) {
    return { ok: false, why: 'edit-runtime is not booted or --rhi-debug is unavailable' };
  }
  const requestId = `capture-${crypto.randomUUID()}`;
  const accepted = gateway.dispatch({ kind: 'captureFrame', frames: 1, requestId }, 'ai');
  if (!accepted.ok) return accepted;
  const terminal = await gateway.waitOperationRun(requestId);
  if (!terminal.ok) return terminal;
  return terminal.value; // { status:'succeeded', result:{ runId, tapePath, reportPath } }
})()
```

`captureFrame` waits for the runtime-owned recorder completion; `requestFrame` is not needed as
a second raw trigger. If the editor was not started with `--rhi-debug`, the operation returns the
structured `rhi-debug-unavailable` error through the gateway.

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

Two CLI drivers for the `__forgeaxEval` channel. **Prefer `gateway-live`** — it's sub-millisecond,
needs no playwright, and shares the in-memory world so ops appear instantly in the open editor.

Both share `scripts/gateway-cli-common.mjs` (SSOT for arg parsing / snippet reading /
`{ok,value|error}` print). Flags are **strict**: an undeclared flag exits 2 with the accepted
list — it can NEVER leak its value into the code string.

### Live window bridge (preferred — `gateway-live.mjs`)

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
> not drain and evals eventually time out — keep the editor window in the foreground. The relay
> default is 120s and can be changed per request with `--timeout`.
> This applies ONLY to the bridge; in-window UI dispatch runs synchronously.

```bash
# Starts the relay and enables the page connection by default.
bun run dev:standalone
# `bun fx start [--game DIR]` enables the bridge by default too (same relay :15296).

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
snippet from a file. `--timeout <ms>` changes the relay's HTTP wait budget for that request;
the default is 120000 ms and the accepted range is 1000–300000 ms. This only prevents the
transport from returning `EVAL_TIMEOUT`; an accepted Gateway operation is complete only after
its own `waitOperationRun(requestId)` reaches the required terminal status. `FORGEAX_BRIDGE=0`
is the explicit opt-out; ordinary bare Vite hosts keep the bridge disabled.
`FORGEAX_BRIDGE_EVAL_TIMEOUT_MS` sets the relay default. `VITE_FORGEAX_BRIDGE` and
`VITE_FORGEAX_BRIDGE_PORT` are Vite build-time variables, so restart the edit-runtime dev
server after changing them.

> [!CAUTION]
> The relay accepts arbitrary JavaScript for the connected editor page. It is **DEV-only**, binds
> only to `127.0.0.1`, and must never be exposed through a public interface, port forward, or
> production deployment. Use only on a trusted local development machine. The browser bridge does
> not connect unless explicitly enabled by `dev-standalone` (or `VITE_FORGEAX_BRIDGE=1`).

### Headless browser (`gateway-eval.mjs`)

`skills/forgeax-editor-gateway/scripts/gateway-eval.mjs` — boot a headless browser at a running editor, wait for `__forgeaxEval`
(+ scene settle), evaluate one snippet, await it if async, print `{ok,value|error}` JSON. Reuse this
instead of re-deriving the boot dance. Exit 1 on eval-level failure (syntax/runtime), 0 otherwise
(domain errors like `UNKNOWN_COMPONENT` ride in `value`/`error`, exit 0).

> [!NOTE]
> `gateway-eval.mjs` takes `--file/--raw/--url/--timeout/--settle`; `gateway-live.mjs` takes
> `--file/--timeout/--health` (no `--settle`/`--raw`/`--url` — the live page is already booted).

```bash
# prereq: a running editor with a scene open, and playwright available:
#   editor standalone → `bun run dev:standalone` (:15290, no onboarding) + `bun run test:e2e:install`
#     ⚠ EMPTY scene: dev:standalone passes no --game, so no game backend / no entities. For real
#       scene or Play dogfood: `bun fx start --game games/sample --bg` (spawns :15281 platform-io
#       backend + /api proxy so the scene loads and ▶ Play actually assembles a play world).
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

> [!IMPORTANT]
> **When to use headless over live.** The headless driver spawns a **fresh browser** — its
> main use is verifying save→reopen round-trips (a separate eval IS already the reopen) and CI.
> For interactive work, prefer `gateway-live.mjs`: it's faster, needs no playwright, and ops
> appear in the open editor instantly.

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
| `SCRIPT_RUNTIME_ERROR` | eval code throws at runtime | For `gateway.query(...)`, use `query({ with: [...] })`; for `query({ components: [...] })`, use `with`; otherwise inspect the message and retry |
| `rhi-debug-unavailable` | `captureFrame` dispatched without the RHI debug runtime | Start the editor with `--rhi-debug`, then rediscover `captureFrame` with `listOps()` |
| `rhi-capture-failed` | Runtime recorder rejected or failed a capture | Read the terminal `OperationRun` error, correct the runtime condition, then dispatch a new `requestId` |

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
stack (`setSelection`, `cameraOrbit`, `requestFrame`, `captureFrame`, `saveDocToDisk`, etc.). There is no Ctrl+Z for them.
Plan accordingly.

**Async disk continuations are outside span intervals**: the 4 async session ops
(`saveDocToDisk` / `loadDocFromDisk` / `switchSceneFile` / `createSceneFile`) fire-and-forget their
disk I/O after the applier returns synchronously. The span covers ONLY the synchronous applier body;
the detached continuation is NOT inside any span interval. This is consistent with OOS-1 and is
declared in the trace module header.

**eval reentry creates nested spans**: calling `channel.eval()` from within eval code is allowed —
stack-based span tracing naturally produces parent-child nesting. Trace trees will reflect the
reentry structure.
