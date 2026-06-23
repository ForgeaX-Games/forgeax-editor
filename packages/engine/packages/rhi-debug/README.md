# @forgeax/engine-rhi-debug

> RenderDoc-inspired RHI frame record + deterministic replay + offline inspect for forgeax-engine.
> First user is AI subagent; exposed via WS:5732 JSON-RPC, CLI, and direct import.

## Proposition

This package records every RHI call (createBuffer, writeBuffer, beginRenderPass, setPipeline, draw, etc.) into a **tape** -- an ordered sequence of `RhiCallEvent` items plus a hash-deduplicated binary blob pool. The tape can be **replayed** on a fresh `RhiDevice` (caps permitting) and **inspected** at any draw index, yielding bind group bindings, draw call metadata, and RT readback PNGs.

Three key properties:
- **Proxy-based**: `wrap(rhiInstance)` returns a `DebugRhiInstance` that intercepts all RHI calls without modifying `@forgeax/engine-rhi` or `@forgeax/engine-rhi-webgpu`.
- **Deterministic replay**: on dawn-node, replay RT pixels match original within epsilon <= 0.01 (same device, same caps).
- **AI-friendly**: `fields` cropping avoids context explosion; RT is always a PNG path string, never inline base64.

Enable via `FORGEAX_ENGINE_RHI_DEBUG=1`. When unset, the entire package is tree-shaken from production bundles.

## API

### Core functions

| export | signature | description |
|:--|:--|:--|
| `wrap` | `(instance: RhiInstance): DebugRhiInstance` | Proxy-wrap an RhiInstance. `DebugRhiInstance extends RhiInstance` with added `arm(frames)`, `onFrameEnd()`, `finalize()`, `getTape()`, `getState()`, `getEvents()`, `getBlobPool()`, `transitionToError()`, `disposeError()`. |
| `wrapCreateShaderModule` | `(originalFn: CreateShaderModuleFn, debugInst: DebugRhiInstance): CreateShaderModuleFn` | Standalone wrapper for `createShaderModule` (which is not on `RhiDevice` in rhi-webgpu). Records `createShaderModule` events in the tape. |
| `createReplay` | `(tape: Tape, targetDevice: RhiDevice, targetCaps: RhiCaps): Result<Replay, DebugError>` | Create a Replay object from a tape. Performs caps fail-fast check (returns `caps-mismatch` if `tape.rhiCapsRecorded` is not a subset of `targetCaps`). |
| `inspectAt` | `(replay: Replay, drawIdx: number, fields?: InspectFields[]): Promise<Result<InspectReport, DebugError>>` | Inspect replay state at a specific draw index. `fields` controls which data is computed: `['bindings']` skips RT readback; `['rt']` includes PNG path. |
| `wireDebugRhiInspector` | `(reg: Registry, ctx: WireDefaultInspectorsContext): RegisterRootResult` | Register 3 RPC methods (`debug.captureFrame`, `debug.inspectAt`, `debug.replayDispose`) on a console `Registry`. Used by `wireDefaultInspectors` as the `debugRhi` injector. |

### CLI subcommands

> [!NOTE]
> **Current invocation: `node packages/rhi-debug/dist/cli.mjs <subcommand>`** (after `pnpm -F @forgeax/engine-rhi-debug build`). The `forgeax-engine-console` plugin-bin route below is the documented end-state shape — landing it requires either (a) a `forgeax-engine-console-rhi-debug` plugin bin in `packages/rhi-debug/package.json#bin` (kubectl 4th-path discovery), or (b) a built-in `capture-frame` / `inspect-at` registration in `packages/console/src/cli.ts#FORGEAX_CLI_SPEC.subcommands`. Tracked as follow-up tweak. Until then, the WS:5732 RPC route (`debug.captureFrame` / `debug.inspectAt` / `debug.replayDispose`) is the canonical end-to-end path; the CLI's `--help` text + flag table is snapshot-tested in `cli.test.ts`.

| command (end-state shape) | description |
|:--|:--|
| `forgeax-engine-console capture-frame [--frames=1] [--label=<str>] [--target=ws://localhost:5732]` | Connect to running console server, dispatch `debug.captureFrame` RPC, print tapePaths. |
| `forgeax-engine-console inspect-at <tapePath> <drawIdx> [--fields=bindings,rt] [--target=ws://localhost:5732]` | Connect to console server, dispatch `debug.inspectAt` RPC, print InspectReport JSON. |

### RPC methods (WS:5732)

| method | params | returns |
|:--|:--|:--|
| `debug.captureFrame` | `{ frames: number, label?: string }` | `{ tapes: Array<{ frameIdx, runId, tapePath, reportPath }> }` |
| `debug.inspectAt` | `{ tapePath: string, drawIdx: number, fields?: string[] }` | `InspectReport` (JSON; RT is PNG path string) |
| `debug.replayDispose` | `{ tapePath: string }` | `{ disposed: true }` |

### State machine

```
idle -> armed -> recording -> finalizing -> idle       (normal path)
idle -> armed -> recording -> error                     (capture failure)
error -> idle           (via disposeError())
```

8 legal transitions: `idle->armed` (arm), `armed->recording` (first frame-end after arm), `recording->idle` (N frames done, auto-finalize), `recording->error` (device.lost), `error->idle` (disposeError).

3 illegal: duplicate arm returns `recorder-already-armed`; arm from error returns `recorder-already-armed`; finalize from error writes `valid: false`.

## Error codes

`DebugErrorCode` is a 12-member closed union, completely independent from `RhiErrorCode`.

| code | hint template |
|:--|:--|
| `recorder-not-attached` | env `FORGEAX_ENGINE_RHI_DEBUG=1` not set at bootstrap |
| `recorder-already-armed` | previous arm() still active; call `disposeError()` or wait for capture to finish |
| `frame-end-hook-missing` | `createRenderer` internal `onFrameEnd` injection point absent (theoretically unreachable) |
| `tape-format-version-mismatch` | tape formatVersion vs runtime version (`{tapeVersion}` vs `{expectedVersion}`) |
| `tape-handle-graph-broken` | dangling handle `{danglingHandleId}` referenced at event `{referencingEventIndex}` |
| `caps-mismatch` | missing caps: `{missingCaps}` |
| `replay-step-out-of-range` | stepTo(`{requestedStep}`) out of [0, `{totalEvents}`); current=`{currentStep}` |
| `replay-deterministic-violation` | RT pixel diff between original and replay exceeds threshold (test-only error) |
| `rt-readback-failed` | `copyTextureToBuffer` / `mapAsync` chain failed |
| `png-encode-failed` | PNG encoding of RT readback data failed |
| `rpc-target-not-wired` | `wireDefaultInspectors(reg, ctx)` called without `debugRhi` injector |
| `replay-dispose-busy` | in-flight inspect at draw indices `{inFlightDrawIndices}`; `await` them first |

Each error object carries structured `.code` / `.expected` / `.hint` / `.detail` (discriminated union narrowed on `.code`). AI users consume via `switch (err.code)` exhaustive -- TypeScript catches missing branches at compile time.

## Tape format constants

| constant | value | locked in |
|:--|:--|:--|
| `TAPE_FORMAT_VERSION` | `1` | m1-3 types.ts |
| `PER_EVENT_OVERHEAD` | `192` bytes | plan-strategy 5.3; m2-4 blob pool |

Serialization: `serializeTape(tape) -> { json: string, bin: ArrayBuffer }`. JSON header contains `formatVersion` + `rhiCapsRecorded` + events array. Binary blob pool contains hash-keyed `ArrayBuffer` data for `writeBuffer` / `writeTexture` / shader source.

## Dependency contract

> [!NOTE]
> requirements §2.2 + AC-01 originally read "`dependencies` contains exactly
> `@forgeax/engine-rhi`". Round 1 implement-review (I-1) flagged the live
> `package.json#dependencies` as having three entries — this section is the
> SSOT for the deviation and the rationale.

| dep | section | rationale |
|:--|:--|:--|
| `@forgeax/engine-rhi` | `dependencies` | proxy target; recorder/replayer/inspector all consume the spec interfaces |
| `@forgeax/engine-types` | `dependencies` | `Result` / `ok` / `err` SSOT (AGENTS.md §Error model — closed-union `.code` shipped from `@forgeax/engine-types`); inlining a second `Result` factory inside this package would violate the "1 SSOT per fact" axiom in `forgeax-harness/rules/architecture-principles.md` §1 |
| `pngjs` | `dependencies` | RT readback PNG encoder for `inspectAt(...).rt` (AC-15). Pure-TS PNG encode in v1; no dawn-node hard requirement |
| `@forgeax/engine-rhi-webgpu` | `peerDependencies` | dawn-node binding. Optional at runtime — `wrap(rhi)` works against any RHI backend; the dependency is `peer` so `FORGEAX_ENGINE_RHI_DEBUG=0` consumers do not pay an install cost |
| `@forgeax/engine-rhi-wgpu` | `peerDependencies` | wgpu-wasm binding. Same rationale (OOS-7: capture/replay against wgpu-wasm is v2) |

The original AC-01 wording is preserved as a **descriptive intent** ("debug instrumentation should not pull in the RHI backends"), but the *literal* one-dep constraint was relaxed to honor the SSOT axiom (`@forgeax/engine-types`) and to avoid a base64-encoded inline PNG implementation (`pngjs`). Backends remain `peer`, satisfying the original tree-shake intent: AC-03 (tree-shake grep gate) verifies no `engine-rhi-debug` import survives in `FORGEAX_ENGINE_RHI_DEBUG=0` bundles.

## Out of scope (v1)

| id | item | deferred to |
|:--|:--|:--|
| OOS-1 | Override (edit UBO / swap shader / skip draw) during replay | v2 |
| OOS-2 | Per-pixel history | v2 |
| OOS-3 | Timestamp trace (`writeTimestamp` / `resolveQuerySet`) | v2 |
| OOS-4 | UI panel | v3 |
| OOS-5 | Destroy-event recording (`destroyBuffer` / `destroyTexture`) | add-only minor when destroy feat lands |
| OOS-6 | Tape cross-version compatibility | v2 (formatVersion mismatch rejects) |
| OOS-7 | rhi-wgpu (wasm) backend capture/replay testing | v2 |
| OOS-8 | Browser pixel-deterministic replay | v1: dawn-node only epsilon <= 0.01; browser: non-zero + structural only |
| OOS-9 | URL param `?forgeax-debug=1` trigger | v2 (v1: `FORGEAX_ENGINE_RHI_DEBUG=1` env only) |
| OOS-10 | `executeBundles` event recording | v2 (currently placeholder returns `rhi-not-available`) |
| OOS-11 | Auto-recovery from capture failure (recording -> idle) | v1: manual `disposeError()` required |