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
| `gateway.begin(op)` | `(EditorOp) => {ok:true, handle} \| {ok:false, error}` | Start continuous op: pre-validate + snapshot, occupy slot, return handle |
| `gateway.update(handle, patch)` | `(OpHandle, Record<string,any>) => DispatchResult` | Accumulate patch into begin op, write-through state + repaint (no ledger, no inverse) |
| `gateway.commit(handle)` | `(OpHandle) => DispatchResult` | Finish continuous op: compute from->to inverse, settle per domain, release slot |
| `gateway.cancel(handle)` | `(OpHandle) => DispatchResult` | Roll back to pre-begin state, no trace, release slot |
| `gateway.listOps()` | `() => readonly OpDescriptor[]` | Self-introspect all registered ops (builtin + seam-registered + defineOp-composed) |
| `gateway.collectSceneAsset(entity)` | `(EntityHandle) => {ok:true, asset} \| {ok:false, error}` | Read one live subtree as a GUID-backed SceneAsset POD; no world/ledger mutation |
| `gateway.resolveAsset(handle)` | `(number) => {ok:true, asset} \| {ok:false, error}` | Resolve a shared<T> handle (query's opaque-handle.raw) to its live asset payload; covers builtin + catalog, O(1) |
| `gateway.describeAsset(handle)` | `(number) => {ok:true, kind, guid?, name?, builtin?} \| {ok:false, error}` | Human-readable identity of an asset handle: kind + (catalog assets) guid+name, or builtin:true |
| `gateway.assetCatalog()` | `() => readonly {guid, kind, name?, relativeUrl}[]` | List the asset catalog (projects registry.listCatalog); [] if no registry |
| `gateway.lookupAsset(guid)` | `(AssetGuid\|string) => Asset \| undefined` | Look up a catalogued asset payload by GUID (catalog only, no fetch) |
| `gateway.defineOp(def)` | `(OpDefinition) => DefineResult` | Compose new document/session op (id + argsSchema + plan -> transaction or session-plan) |
| `gateway.trace.last()` | `() => SpanNode \| null` | Read most recent root span tree (plain-object, AC-10) |
| `gateway.trace.recent(n)` | `(n: number) => SpanNode[]` | Read last N root span trees |
| `gateway.auditLog()` | `() => ReadonlyArray<{op, origin}>` | "Who did what" — the append-only ledger zipped with its index-aligned origin ('human'\|'ai'), oldest→newest; includes irreversible session ops (setSelection/save/play), unlike undoStack-derived `historySteps()` |
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
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { pos: [0, 0, 0] } });
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


> [!NOTE]
> **`play` / `stop` / `cameraOrbit` / `requestFrame`** are only available after edit-runtime boots and registers
> the seam (`registerSessionApplier`). In headless (no edit-runtime, e.g. pure core scripts / tests / CI),
> they are **unregistered** — `dispatch({ kind: 'play' })` returns `UNKNOWN_OP`. Probe with `listOps()`
> before sending: if `play`/`stop` are absent, the environment does not support them. Do not blindly fire.

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
> column-buffer references.

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