---
name: forgeax-editor-gateway
description: >-
  Discover, invoke, and diagnose a running ForgeaX Editor through its self-describing EditGateway.
  Use for editor tooling, AI editing, Play/Stop, assets, and viewport/runtime inspection.
---

# forgeax-editor-gateway

Treat the running Gateway as the API SSOT. Do not memorize operation payloads from this skill:
discover them from `help`, `listOps()`, `argsSchema`, and structured errors at execution time.

## Asset source workflow (M5)

The shortest source-authoring path is deliberately observable and one-door:

1. **Discover** with `gateway.listOps()` and select the canonical operation id.
2. **Preview** with `previewAssetSourceMutation` using `guid`, `scope.sourceKey`, `expectedRevision`, and `requestId`.
3. **Submit** `saveAssetSourceOverride` or `reimportAsset`; destructive discard uses `discardSourceOverridesAndReimport` plus the preflight `confirmationToken`.
4. **Wait** with `getOperationRun` / `waitOperationRun` / `subscribeOperationRun`; only `succeeded`, `failed`, or `cancelled` are terminal.
5. **Recover** from stable `error.code`, `expected`, `actual`, `retryable`, and `recoveryActions`; retry with a new `requestId`, or reconcile the Catalog before reading again.

Never parse `hint` text as a contract; branch on the structured fields above.

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
> Writes enter through `gateway.dispatch` or `begin → update → commit/cancel`; reads use
> `query({with:[...]})`. Human UI, AI, and product integrations submit the same operation shape.

## Connect and discover

From `packages/editor`:

```bash
bun run dev:standalone

# CLI grammar; does not require a connected page.
node skills/forgeax-editor-gateway/scripts/gateway.mjs --help

# Attached-page health and runtime-derived operation catalog.
node skills/forgeax-editor-gateway/scripts/gateway.mjs --health
node skills/forgeax-editor-gateway/scripts/gateway.mjs list
node skills/forgeax-editor-gateway/scripts/gateway.mjs help <operation-kind>
```

The discovery loop is:

1. `--health` must report `pageConnected: true`.
2. `list` returns `gateway.listOps()` from the running Editor.
3. `help <operation-kind>` selects its descriptor, including domain and `argsSchema`.
4. Form input from that schema and dispatch it.
5. On failure, branch on `error.code` / `error.hint`, refresh discovery, and retry only when safe.

```bash
node skills/forgeax-editor-gateway/scripts/gateway.mjs dispatch <operation-kind> \
  --input '<json-object>'
```

For reads or multi-step logic, use an eval snippet; prefer `--file` once quoting or async is involved:

```bash
node skills/forgeax-editor-gateway/scripts/gateway.mjs \
  "query({with:['Name','Transform']})"
node skills/forgeax-editor-gateway/scripts/gateway.mjs --file /tmp/inspect.mjs
```

## Choose page lifecycle

The Gateway is realm-local; attached and fresh are driver lifecycles, not different Gateway modes.

| Evidence needed | Driver |
|:--|:--|
| Current page and immediate UI response | `gateway.mjs` attaches through the DEV relay |
| Cold load, save→reopen, or CI isolation | `gateway-fresh-page.mjs` creates a Playwright page |
| Product-scoped operation or script | Use that product's typed transport/CLI; it owns carrier and scope |

```bash
node skills/forgeax-editor-gateway/scripts/gateway-fresh-page.mjs --help
node skills/forgeax-editor-gateway/scripts/gateway-fresh-page.mjs \
  "gateway.listOps()" --settle 0
```

`FORGEAX_BRIDGE_PORT` must match the Editor relay (default `127.0.0.1:15296`).
`FORGEAX_BRIDGE=0` disables it. This attached-page relay is a development driver; never expose or port
forward it. That driver restriction does not make operation-scope eval dev-only: product compositions may
carry the same `{gateway, query, _import}` scripts through their versioned, scope-selected typed transport.

## Execute safely

- `dispatch` is an immediate semantic operation. For gestures, keep one `begin` handle through
  `update*` and `commit`/`cancel`; only one continuous slot exists.
- Dispatch acceptance may precede completion. When the discovered schema exposes `requestId`, read
  `getOperationRun(requestId)` or await `waitOperationRun(requestId)`.
- Re-query after Play/Stop. Entity handles belong to one world and become stale across the boundary.
- `query` is a separate read-only function; do not invent `gateway.query(...)`.
- Use `gateway.trace.last()` after failures. `undo()` / `redo()` / `canUndo()` return booleans.
- Raw scope is for privileged development diagnosis, not authored writes. It is absent until the host grants
  it and `unlockRawScope()` succeeds. Never import engine `dist` into the page realm.

For real Play dogfood, launch a game-backed Editor (`bun fx start --game <dir>`). Bare
`dev:standalone` has no game backend. Discover Play fields from the running Gateway; wait for
`playPhase` to become terminal and inspect `lastPlayError` on failure.

## Extend instead of bypassing

If discovery lacks semantic intent, add it to the Gateway rather than creating another write path:

- Register a built-in applier and descriptor, or use `defineOp` for a composed operation.
- Let `argsSchema` describe and validate inputs; do not duplicate the schema in CLI/docs.
- Keep operation descriptors self-explanatory: titles, field descriptions, completion semantics,
  safety constraints, and recovery hints belong beside the runtime catalog.
- Asset and plugin actions (`importAsset`, `addSceneAssetToScene`, `collectSceneAsset`,
  `duplicateEntity`, `describeAssetByGuid`, `*.plugin.ts`, `defineSystem`) must be discoverable the
  same way; improve their descriptors when `help` is insufficient.
- Rendering diagnosis uses the discovered `captureFrame` operation. `globalThis.__forgeax` is an
  internal seam, not a caller API.

## When discovery is still insufficient

Use [references/field-notes.md](references/field-notes.md) only for accumulated edge cases, not
as contract. Read [DESIGN.md](DESIGN.md) for architectural rationale and
[world-fork semantics](../../.forgeax-harness/docs/skills/forgeax-editor-gateway.md) for Play/Stop identity rules.
When the runtime catalog and reference disagree, fix the catalog/descriptor first.

After changing this skill or CLI, run:

```bash
node scripts/validate-gateway-skill.mjs
bun run test:scripts
```
