# EditGateway — activeWorld / mode / play-stop world-fork (AI user guide)

> **feat-20260707-editor-world-fork-ssot-level-load-play-activeworld** M4 w34.
> Companion to the `skills/forgeax-editor-gateway/SKILL.md` op-dispatch reference.
> This doc covers the **play/stop world-fork** semantics that changed how entity
> identity and the "current world" behave — read it BEFORE reading or writing any
> entity across a play/stop boundary.

## The one thing you must know first: handles do NOT survive play/stop

> [!CAUTION]
> **An `EntityHandle` is only valid inside the world it was read from.**
> Entering play (`▶`) forks a fresh `playWorld`; stopping (`■`) discards it. A
> handle captured in edit mode is **stale** the moment you cross into play, and a
> handle captured in play is **stale** the moment you stop. There is no id
> remapping across the boundary — the old `_e2h`/`_h2e`/`localId` double-map is
> gone (deleted this feature). **Re-query `gateway.activeWorld` (or call
> `getSelection()`) after every `▶`/`■` to obtain fresh handles.**

Reading a stale handle does **not** silently return `undefined` — it returns a
structured `stale-entity-handle` error you branch on by `.code` (see below).

## Mental model: two worlds, one pointer

The editor holds two engine worlds and a single active pointer:

| World | Lifetime | What it holds |
|:--|:--|:--|
| `editWorld` (`gateway.doc.world`) | persistent — lives for the whole session | authored scene + editor entities (gizmo, edit camera). Frozen during play. |
| `playWorld` | transient — one per `▶`, dropped on `■` | a fresh `new World()` level-loaded from the last-saved scene, then bootstrapped by game systems |

`gateway.activeWorld` is a **derived** pointer (no second state field):

```ts
get activeWorld(): World { return this._playWorld ?? this.doc.world; }
get mode(): 'edit' | 'play' { return this._playWorld !== null ? 'play' : 'edit'; }
```

- **edit mode** → `activeWorld === doc.world` (the editWorld), `mode === 'edit'`
- **play mode** → `activeWorld === playWorld` (a different object), `mode === 'play'`

All panels, viewport picking, and hierarchy walks read `gateway.activeWorld`, so
in play they show the **live playWorld** (including entities the game spawned at
runtime) and in edit they show the authored scene. `▶` and `■` clear selection
and emit a change notification so consumers re-read.

## Read surface: how to discover state without guessing

```ts
import { gateway } from '@forgeax/editor-core';

// Which mode am I in? — property, not a guess.
gateway.mode;          // 'edit' | 'play'

// The current world — same access path in both modes (P4 one abstraction).
const world = gateway.activeWorld;
world.inspect().entityCount;   // entity count of whatever world is active now
```

> [!NOTE]
> `activeWorld` / `mode` are **getters on the gateway object** — enumerate the
> gateway surface and you find them (north star: new capabilities grow on the
> gateway). You never track mode yourself; derive it from `gateway.mode`.

Entity reads go through the entity-state read face, which normalizes a stale
handle to a structured error instead of `undefined`:

```ts
// entComponent returns a Result — stale vs component-absent are DISTINCT.
const r = entComponent(gateway.activeWorld, handle, 'Transform');
if (!r.ok) {
  if (r.error.code === 'stale-entity-handle') {
    // handle from a previous world — re-query activeWorld / getSelection()
  } else if (r.error.code === 'component-absent') {
    // handle is LIVE, it just has no Transform
  }
}
```

## Play/stop lifecycle (session-domain ops)

`play` / `stop` are **session-domain** ops registered by edit-runtime at boot.
In headless (pure core, tests, CI) they are **unregistered** — probe `listOps()`
before firing (see SKILL.md). Their observable effects:

| Action | Effect |
|:--|:--|
| `▶` play | freeze editWorld frame loop (zero ticks — AC-07), assemble a fresh `playWorld` (level-load + bootstrap — AC-04), switch the pointer, clear selection |
| `■` stop | drop the `playWorld` (no restore, no undo — AC-05), resume editWorld, switch the pointer back, clear selection |

`▶` is idempotent while already playing (no-op); `■` is idempotent while already
stopped. `play → stop → play` is a clean idempotent cycle — each `▶` builds a
brand-new world; nothing leaks from the previous run.

> [!IMPORTANT]
> **Play uses the last-SAVED scene, not your unsaved in-memory edits.** `▶`
> re-instantiates the scene from disk. If the document is dirty, the host surfaces
> a `play-uses-last-saved-scene` hint. Save before play if you need unsaved edits
> reflected.

## Error recovery paths (branch on `.code`, never parse messages)

All errors are structured `{ ok:false, error:{ code, hint, ... } }`. The hint
encodes the self-rescue action directly.

| code | Trigger | Recovery (from `hint`) |
|:--|:--|:--|
| `stale-entity-handle` | reading an `EntityHandle` that does not exist in the target world (from a previous play/stop world, or despawned) | re-query `activeWorld` or call `getSelection()` for a fresh handle |
| `component-absent` | handle is **live** but the requested component is not on it | not stale — the entity simply lacks that component; adjust the query |
| `edit-rejected-in-play` | a **document-domain** dispatch (spawn/setComponent/transaction) attempted while `gateway.mode === 'play'` | stop play mode first, then edit; play data is a read-only simulation view (Edit ≠ Play) |

```ts
// Document-domain write while playing → rejected (play is read-only).
const r = gateway.dispatch({ kind: 'setComponent', entity: h, component: 'Transform', patch }, 'ai');
if (!r.ok && r.error.code === 'edit-rejected-in-play') {
  // Recovery: stop play (session op — passes through even in play), then
  // re-acquire a fresh edit-world handle and re-dispatch against the edit world.
  gateway.dispatch({ kind: 'stop' }, 'ai');       // mode → 'edit', playWorld dropped
  const editH = getSelection();                    // re-query — the play handle is now stale
  if (editH !== null) gateway.dispatch({ kind: 'setComponent', entity: editH, component: 'Transform', patch }, 'ai');
}
```

> [!NOTE]
> **Session-domain ops still pass through in play** (e.g. `setSelection`,
> `cameraOrbit`) — only document-domain writes are gated. The gate keeps both the
> frozen editWorld and the transient playWorld free of authoring writes.

## No dead concepts

This feature removed the old identity machinery. If you find references to any of
these in code or your own scripts, they are stale — the model is now
handle-in-activeWorld:

- `_e2h` / `_h2e` (entity↔handle double-map) — **deleted**
- `_nextId` / editor-minted `localId` — **deleted** (localId is now only an
  engine serialization-boundary concern, not a runtime identity)
- epoch guard / 4-layer play undo — **deleted** (play=level-load, stop=drop, no
  restore concept)

Refs: requirements AC-04/AC-05/AC-06/AC-07/AC-09/AC-14; plan-strategy §8 (AI User
Affordance), D-3 (activeWorld/mode derive), D-4 (stale-handle Result), D-5
(play-mode write gate); research Finding 13.
