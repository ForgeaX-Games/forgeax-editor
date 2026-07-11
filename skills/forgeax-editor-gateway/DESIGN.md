# forgeax-editor-gateway — Design Notes

> Why the gateway is shaped the way it is. `SKILL.md` is the operational API reference
> (what to call, what comes back); this file is the *why* behind the non-obvious
> decisions. Read it when a design choice looks arbitrary or you're extending the gateway.

> [!IMPORTANT]
> **The single-door philosophy is NOT re-derived here — it has an SSOT.** The axioms
> (single door, `write-gate ⊇ ledger`, chrome-vs-authored litmus, registry razor,
> non-symmetry of single-door vs registry) live in `AGENTS.md` §"Design principles
> (the why behind invariant 7)" and, long-form, in the harness KB:
> `wiki/editor-operation-ssot-north-star.md`, `wiki/editor-architecture.md`,
> `wiki/editor-panel-realm-architecture.md`. This file only captures gateway-specific
> decisions that have no other home. When philosophy and this file conflict, AGENTS.md wins.

## Design decisions with no other home

These are the choices that surprised a reader (or bit one) and whose rationale wasn't
written down anywhere until it caused a bug.

### 1. `mode` / `activeWorld` are derived getters, not stored fields

`_playWorld: World | null` is the **only** world-fork state (`gateway.ts`). Everything
else is derived:

```ts
get activeWorld(): World { return this._playWorld ?? this.doc.world; }
get mode(): 'edit' | 'play' { return this._playWorld !== null ? 'play' : 'edit'; }
```

**Why derived, not a `_mode` field:** a second stored field would need syncing on every
`enterPlay`/`exitPlay` — two sources of truth for one fact (violates Derive, Don't
Duplicate). With one pointer, `mode` cannot disagree with reality.

**Consequence for callers:** `gateway.activeWorld === world` (raw scope) is the *only*
reliable "which world am I in" test. Do **not** compare `EntityHandle` values — a fresh
`playWorld` spawns entities in the same slot order as `editWorld`, so handles collide by
coincidence (both give Player `4` in a clean scene). Same slot ≠ same world. Full
play/stop world-fork semantics: see the companion `docs/skills/forgeax-editor-gateway.md`.

### 2. `origin` lives in a parallel array, not on the ledger entry

`gateway.ledger[i]` is the bare `EditorOp`; its `'human' | 'ai'` origin is
`gateway.origins[i]` — two index-aligned arrays pushed in lockstep at dispatch/commit.

**Why parallel, not `{op, origin}` entries:** the ledger IS the op stream — an entry is a
replayable `EditorOp` and nothing else. Bolting `origin` onto the entry would mean either
a non-`EditorOp` shape in the ledger (breaks replay) or every op type carrying an origin
field (leaks a cross-cutting concern into every schema). A sidecar array keeps the ledger
a pure op log.

**The trap this creates:** reading `gateway.ledger` alone looks like origin was lost. It
wasn't — but the two-array design is non-obvious, so `gateway.auditLog()` exists to zip
them (`[{op, origin}]`) and is the surface callers should use. `auditLog` vs `trace` vs
`historySteps` — see SKILL.md §auditLog.

### 3. Three read surfaces, deliberately not merged

`trace` (span trees: timing / engineCalls) · `historySteps()` (undoStack timeline,
document ops only) · `auditLog()` (ledger × origin, includes session ops). They overlap
enough to look mergeable but answer different questions — see the SKILL.md §auditLog
table. Kept separate because each has a distinct backing store (ring buffer / undoStack /
ledger+origins) and merging would couple their lifetimes (the trace ring buffer evicts;
the ledger is append-only forever).

### 4. DEV bridge drain follows the *active* app, not `editorApp`

The live bridge (`gateway-live.mjs` → relay → page) drains its eval queue from an app
frame-loop callback so every bridge write passes through that frame's systems
(deterministic). The queue was bound to `editorApp.registerUpdate` — but `▶` play calls
`editorApp.pause()`, freezing that loop, so a bridge eval submitted during play queued
forever until the 30 s relay timeout: **the AI lost the editor exactly when observing the
running game matters most.**

Fix (follow-the-live-app): register the same drain on the `playApp` frame loop too, via
an optional `onPlayFrame` dep threaded `ViewportComponent → initHostSession →
createRunLifecycle`. It rides whichever app is live and is dropped with the play assembly
on `■` (GC, no leak). run-lifecycle stays bridge-agnostic — it just fires `onPlayFrame`.

**General principle:** any per-frame machinery that must survive play cannot bind to
`editorApp` alone; play freezes it. Bind to the active app, or register on both.

## Why the eval channel splits scope① / scope②

scope① `{gateway, query, _import}` is the production AI surface — no raw `world`/
`renderer`/`assets`. scope② (raw engine) is dev-only, behind `unlockRawScope()`, and
`SCOPE_LOCKED` in production. **Why the split rather than always-raw:** the whole point of
the gateway is that authored mutation goes through one door with ledger/undo/trace. If AI
could reach into a raw `world` in production it would bypass all three (the registry-copy
anti-pattern in raw form). scope① forces AI through the same door humans use; scope② is a
devtools escape hatch, explicitly not the spine (AGENTS.md design-principle 5: `eval` is a
floor, the gateway is the semantic surface).

## SSOT topology (where each fact actually lives)

| Fact | SSOT |
|:--|:--|
| Single-door philosophy, write-gate ⊇ ledger, registry razor | `AGENTS.md` §Design principles + harness KB `wiki/editor-operation-ssot-*` |
| Op API shapes, error codes, three-domain table | `SKILL.md` (this skill) |
| play/stop world-fork, stale-handle recovery | `docs/skills/forgeax-editor-gateway.md` |
| Applier registration = domain assignment | `packages/core/src/io/appliers.ts` |
| Op schemas / validation | op definitions in `packages/core/src` (not restated in docs) |
| gateway-specific decisions above | this file |
