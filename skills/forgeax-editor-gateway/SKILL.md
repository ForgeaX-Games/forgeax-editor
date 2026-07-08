---
name: forgeax-editor-gateway
description: >-
  All editor operations through a single EditGateway — dispatch (immediate op), begin/update/commit/cancel
  (continuous op), listOps (self-introspect), defineOp (compose new ops), eval (AI channel), trace (read
  span trees). Three-domain model (document/session/transient) decided by applier registration table.
  Structured errors via {ok, error}. AI entry: globalThis.__forgeaxEval in DEV builds.
  Use when building editor tools, AI-driven editing, or extending the editor with new operations.
---

# forgeax-editor-gateway

> **All editor operations go through a single EditGateway — `dispatch` / `begin…commit` / `listOps` / `defineOp` / `eval`.**
>
> Editor state mutation has exactly one door. Human UI handlers and AI code use the same gateway,
> same op payload, same applier, same ledger — human-machine isomorphism. "When you've seen one op
> walk through, you know how all warehouse state mutation walks."
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
| `session` | `sessionAppliers` | ledger only (irreversible, auditable) | setSelection / saveDocToDisk / play / stop / cameraOrbit |
| `transient` | `transientAppliers` | neither (ephemeral, no trace) | setHoverEntity / setFieldPreview |

**Immediate op** = `dispatch` with implicit begin=commit collapse.
**Continuous op** = `begin` (snapshot pre-state, occupy slot) -> `update*` (write-through, no ledger)
-> `commit` (compute from->to inverse, settle per domain). At most one active op at a time (single slot);
a second begin or scene switch/undo triggers implicit cancel of the prior op; stale handle returns
`OP_INTERRUPTED`.

**AI eval channel (NEW M5)**: in DEV builds, `globalThis.__forgeaxEval` exposes an in-process
eval channel. AI CLI accesses it via `playwright page.evaluate` — zero new network surface (OOS-9).
scope① = `{gateway, query, _import}` (no world/renderer/assets). scope② = raw engine access,
gated behind explicit `unlockRawScope()` (dev-only; production always returns `SCOPE_LOCKED`).

**Trace (NEW M5)**: every dispatch/undo/redo produces a span tree. Read them via
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
| `gateway.defineOp(def)` | `(OpDefinition) => DefineResult` | Compose new document/session op (id + argsSchema + plan -> transaction or session-plan) |
| `gateway.trace.last()` | `() => SpanNode \| null` | Read most recent root span tree (plain-object, AC-10) |
| `gateway.trace.recent(n)` | `(n: number) => SpanNode[]` | Read last N root span trees |
| `registerSessionApplier(kind, applier, meta?)` | `(string, fn, meta?) => () => void` | Downstream registration seam: edit-runtime registers play/stop/cameraOrbit appliers |
| `createEvalChannel(gw, opts?)` | `(EditGateway, {rawScope?}) => EvalChannel` | (M5) Create dev-only eval channel; `globalThis.__forgeaxEval` in DEV builds |
| `channel.eval(code)` | `(string) => EvaluateResult` | (M5) Evaluate JS code with scope①={gateway, query, _import} |
| `channel.unlockRawScope()` | `() => RawScopeResult` | (M5) Attempt scope② unlock; returns SCOPE_LOCKED in production |

## dispatch -- Immediate Operation

```ts
import { gateway } from '@forgeax/editor-core';

// Human: UI handler
gateway.dispatch({ kind: 'setSelection', id: entityId });
// origin defaults to 'human'; id:null clears selection

// AI: code context
gateway.dispatch({ kind: 'setSelection', id: entityId }, 'ai');
// origin='ai' -> ledger entry carries origin marker, auditable

// Result check
const r = gateway.dispatch({ kind: 'spawnEntity', name: 'Light', components: {} }, 'ai');
if (!r.ok) console.error(r.error.code, r.error.hint);
// Errors do not throw — property-access branching
```

## begin -> update -> commit -- Continuous Operation

```ts
// gizmo drag: mousedown -> mousemove* -> mouseup
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { posX: 0 } });
if (!b.ok) return; // begin failed (e.g. entity nonexistent) -> {ok:false, error}
const handle = b.handle;

// Per-frame drag (write-through, no ledger); update's partial accumulates into begin's op
gateway.update(handle, { patch: { posX: 1.0, posY: 0.5 } });
gateway.update(handle, { patch: { posX: 1.2, posY: 0.7 } });

// Mouse-up settle: compute from->to inverse, one undo
const result = gateway.commit(handle);
// document domain -> undo + ledger (one undo rolls back entire drag)
// session domain -> ledger only
```

## cancel -- Interrupt Rollback

```ts
const b = gateway.begin({ kind: 'setComponent', entity: 5, component: 'Transform', patch: { posX: 0 } });
if (!b.ok) return;
const handle = b.handle;
gateway.update(handle, { patch: { posX: 5.0 } });

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

> [!NOTE]
> **`play` / `stop` / `cameraOrbit`** are only available after edit-runtime boots and registers
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
    // query returns snapshot rows: { entity, Transform: { posX, posY, posZ, ... } }
    return query({ components: ['Transform'] }).map(e => ({
      kind: 'setComponent',
      entity: e.entity,
      component: 'Transform',
      patch: { posX: snapToGrid(e.Transform.posX, args.step) },
    }));
  },
});

// plan scope = querySnapshot + primitive constructors only, no world / EditSession
// gateway wraps as one transaction -> one undo (reuses document.ts existing reverse inverse)
// Composed op is immediately visible: listOps() now shows { id:'alignToGrid', source:'defined' }
```

### Session-domain defineOp (M5)

```ts
gateway.defineOp({
  id: 'turnAllLightsOff',
  domain: 'session',  // session plan: sub-ops emit to ledger, NEVER undo
  argsSchema: { type: 'object', properties: {}, required: [] },
  plan: (query, _args) => {
    // query is fully open — any registered component name works (M5)
    const lights = query({ components: ['Light'] });
    return lights.rows.map(row => ({
      kind: 'setComponent',
      entity: row.entity,
      component: 'Light',
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
> **querySnapshot is now fully open (M5/M4)**. `query({ components: [...] })` accepts ANY registered
> component name — no more whitelist of just `Transform` + `Entity`. Unknown component names now
> return a structured error `{ok:false, error:{code:'UNKNOWN_COMPONENT', hint}}` instead of
> silently ignoring (AC-16). Handle-type fields (`unique<T>` / `shared<T>` / `string`) are
> marked as `{kind:'opaque-handle', type, raw}` — you cannot read their internals. TypedArray
> fields (`array<T,N>`) are snap-copied into plain `number[]` — safe, JSON-serializable, no live
> column-buffer references.

## eval -- AI Entry Channel (M5, DEV-only)

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
query({ components: ['Transform'] })  // -> works (read-only query)
await _import('@forgeax/engine-ecs')  // -> works (dynamic-import seam)
```

**scope②** = raw engine access, dev-only. Locked by default; requires explicit unlock:
```ts
// Production build:
channel.unlockRawScope()
// -> { ok: false, error: { code: 'SCOPE_LOCKED', hint: 'scope② is dev-only...' } }

// DEV build (injected at boot):
const ch = createEvalChannel(gw, { rawScope: { world, renderer } });
ch.unlockRawScope()  // -> { ok: true }
ch.eval('world.spawn(...)')  // -> raw world access now available
```

**Return value**: `{ok:true, value}` on success; `{ok:false, error:{code, hint}}` on failure.
- Syntax errors -> `code: 'SCRIPT_SYNTAX_ERROR'`
- Runtime throws -> `code: 'SCRIPT_RUNTIME_ERROR'`
- Error consumption via property access (`error.code`), NOT string parsing (charter P3).

## trace -- Read Span Trees (M5)

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

## Error Code Reference

All errors use `{ ok: false, error: { code, hint } }` return values (no exceptions).
AI branches on `error.code` by property access; hint carries actionable recovery guidance.

| code | Trigger | hint guidance |
|:--|:--|:--|
| `UNKNOWN_OP` | dispatch unknown op kind (no applier registered); includes `play`/`stop` in headless (seam not registered) | `no applier registered for "<kind>"; see listOps()`; `play`/`stop` specialized: hints edit-runtime boot required |
| `INVALID_ARGS` | session/transient args invalid (wrong type / missing required field); defineOp non-document/non-session domain | `invalid args for "<kind>": <path>: <message>` |
| `OP_ID_CONFLICT` | defineOp duplicate id | `op "<id>" already exists in catalog` |
| `PLAN_FAILED` | plan throws / returns empty or non-array | `plan threw: <message>` / `plan returned empty or non-array` |
| `PLAN_STEP_FAILED` | session-plan sub-op fails mid-sequence (M5) | failed op kind + index; already-emitted ops remain in ledger |
| `UNKNOWN_COMPONENT` | querySnapshot component name not found (M5) | lists registered component names in hint |
| `OP_INTERRUPTED` | stale handle on lifecycle method (implicitly cancelled) | `operation was interrupted; begin a new one` |
| `SCOPE_LOCKED` | unlockRawScope() in production (M5) | `scope② is dev-only — run in DEV mode or request rawScope injection` |
| `SCRIPT_SYNTAX_ERROR` | eval code parse failure (M5) | `syntax error near: <msg>; fix and resubmit` |
| `SCRIPT_RUNTIME_ERROR` | eval code throws at runtime (M5) | `runtime error: <msg>; inspect error and retry` |

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
stack (`setSelection`, `cameraOrbit`, `saveDocToDisk`, etc.). There is no Ctrl+Z for them.
Plan accordingly.

**Async disk continuations are outside span intervals**: the 4 async session ops
(`saveDocToDisk` / `loadDocFromDisk` / `switchSceneFile` / `createSceneFile`) fire-and-forget their
disk I/O after the applier returns synchronously. The span covers ONLY the synchronous applier body;
the detached continuation is NOT inside any span interval. This is consistent with OOS-1 and is
declared in the trace module header.

**scope② is dev-only**: raw engine access (`world`/`renderer`/etc.) is NOT available in
production builds. `unlockRawScope()` always returns `SCOPE_LOCKED` outside DEV. scope①
(`{gateway, query, _import}`) is the production AI surface.

**eval reentry creates nested spans**: calling `channel.eval()` from within eval code is allowed —
stack-based span tracing naturally produces parent-child nesting. Trace trees will reflect the
reentry structure.

**querySnapshot typed-array safety**: `array<T,N>` fields (e.g. `posX/Y/Z` in a `float32x3`)
are snap-copied to plain `number[]` — modifying the returned array does NOT write back to the engine
world. `unique<T>` / `shared<T>` / `string` handle fields are opaque — you cannot read their
internals; they carry their metadata as `{kind:'opaque-handle', type, raw}`.