// @forgeax/engine-rhi-debug/src/inspector -- inspectAt(replay, drawIdx, fields?) + LRU cache.
//
// Core features (M6):
// - inspectAt: fields cropping ('bindings'/'drawCall'/'rt') with optional RT PNG readback.
// - LRU cache (size=2) keyed by tapePath, with dispose-busy race protection.
// - RT PNG readback via copyTextureToBuffer + mapAsync + pngjs encode.
// - Pass PNG on-demand generation from .report.json pass index.
//
// Related: requirements AC-15/AC-19/AC-20/AC-21/AC-26/AC-27; m6-1/m6-2/m6-3.

/// <reference types="@webgpu/types" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RhiDevice } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { readbackTexturePixels, resolveAttachmentSize } from './readback';
import type { Replay } from './replayer';
import { computePassOffsets } from './tape-format';
import type {
  InspectBindingEntry,
  InspectDrawCall,
  InspectFields,
  InspectReport,
  RhiCallEvent,
} from './types';

// ============================================================================
// Constants
// ============================================================================

const LRU_MAX_SIZE = 2;

// ============================================================================
// InspectorCache -- LRU cache keyed by tapePath (m6-2)
// ============================================================================

interface ReplayCacheEntry {
  readonly replay: Replay;
  currentEventIdx: number;
  lastAccessTs: number;
}

/**
 * LRU cache of Replay objects keyed by tapePath.
 *
 * Max size = 2 (AC-21). On third unique tape, the oldest (by lastAccessTs)
 * entry is evicted and its replay.dispose() is called.
 *
 * dispose-busy protection (m6-2): if dispose() is called while there are
 * in-flight inspectAt calls for the same tapePath, the dispose is rejected
 * with code='replay-dispose-busy'.
 */
export class InspectorCache {
  /** @internal */
  // biome-ignore lint/style/useNamingConvention: package-internal field requires _ prefix per AGENTS.md lint:internal rule (R-internal-C)
  private readonly _cache = new Map<string, ReplayCacheEntry>();
  /** @internal */
  // biome-ignore lint/style/useNamingConvention: package-internal field requires _ prefix per AGENTS.md lint:internal rule (R-internal-C)
  private readonly _inFlight = new Map<string, Set<number>>();

  get size(): number {
    return this._cache.size;
  }

  /**
   * Get or create a ReplayCacheEntry for the given tapePath.
   * If the entry doesn't exist, it is created and inserted into the cache.
   * If inserting would exceed LRU_MAX_SIZE, the oldest entry is evicted.
   */
  getOrCreate(tapePath: string, factory: () => Replay): ReplayCacheEntry {
    const existing = this._cache.get(tapePath);
    if (existing !== undefined) {
      existing.lastAccessTs = Date.now();
      return existing;
    }

    // Evict oldest if at capacity
    if (this._cache.size >= LRU_MAX_SIZE) {
      this._evictOldest();
    }

    const replay = factory();
    const entry: ReplayCacheEntry = {
      replay,
      currentEventIdx: 0,
      lastAccessTs: Date.now(),
    };
    this._cache.set(tapePath, entry);
    return entry;
  }

  /**
   * Mark a drawIdx as in-flight for the given tapePath.
   */
  markInFlight(tapePath: string, drawIdx: number): void {
    let inflight = this._inFlight.get(tapePath);
    if (inflight === undefined) {
      inflight = new Set();
      this._inFlight.set(tapePath, inflight);
    }
    inflight.add(drawIdx);
  }

  /**
   * Clear a drawIdx from in-flight tracking.
   */
  clearInFlight(tapePath: string, drawIdx: number): void {
    const inflight = this._inFlight.get(tapePath);
    if (inflight !== undefined) {
      inflight.delete(drawIdx);
      if (inflight.size === 0) {
        this._inFlight.delete(tapePath);
      }
    }
  }

  /**
   * Get the set of in-flight draw indices for a tapePath.
   */
  getInFlight(tapePath: string): Set<number> {
    return this._inFlight.get(tapePath) ?? new Set();
  }

  /**
   * Dispose and remove the cache entry for a tapePath.
   *
   * If there are in-flight inspectAt calls for this tape, reject with
   * 'replay-dispose-busy' containing the in-flight draw indices.
   */
  dispose(tapePath: string): Result<void, DebugError> {
    const inflight = this._inFlight.get(tapePath);
    if (inflight !== undefined && inflight.size > 0) {
      return err(
        new DebugError({
          code: 'replay-dispose-busy',
          expected: 'no in-flight inspectAt calls for this tape',
          hint: `await the in-flight inspectAt calls for draw indices [${Array.from(inflight).join(', ')}] before calling dispose`,
          detail: {
            inFlightDrawIndices: Array.from(inflight),
          },
        }),
      );
    }

    const entry = this._cache.get(tapePath);
    if (entry !== undefined) {
      entry.replay.dispose();
      this._cache.delete(tapePath);
    }

    return ok(undefined);
  }

  /**
   * Evict the least-recently-used entry from the cache.
   * @internal
   */
  // biome-ignore lint/style/useNamingConvention: package-internal method requires _ prefix per AGENTS.md lint:internal rule (R-internal-C); @internal JSDoc above
  private _evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;

    for (const [key, entry] of this._cache) {
      if (entry.lastAccessTs < oldestTs) {
        oldestTs = entry.lastAccessTs;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      // Skip busy check on eviction -- eviction is cache-internal,
      // not a user-requested dispose. Just dispose and remove.
      const entry = this._cache.get(oldestKey);
      if (entry !== undefined) {
        entry.replay.dispose();
      }
      this._cache.delete(oldestKey);
    }
  }
}

// ============================================================================
// inspectAt (m6-1 + m6-3)
// ============================================================================

/**
 * Result of extractDrawInfo -- information about a draw at a given index.
 */
interface DrawInfo {
  frameIdx: number;
  passIdx: number;
  bindings: InspectBindingEntry[];
  drawCall: InspectDrawCall;
  colorAttachmentHandleId: string | undefined;
}

/**
 * Inspect a specific drawIdx within a replay session.
 *
 * @param replay - The Replay session that has been stepped to at least drawIdx.
 * @param drawIdx - The global draw event index to inspect.
 * @param events - The tape events array (for extracting frame/pass info).
 * @param fields - Which fields to compute and include in the report.
 *   - ['bindings']: only bind group info, no RT readback.
 *   - ['drawCall']: only draw call metadata.
 *   - ['rt']: triggers copyTextureToBuffer + PNG encode.
 *   - undefined: full report with all fields including RT.
 * @param device - The RhiDevice used for RT readback (needed for copyTextureToBuffer).
 * @param outputDir - The output directory for PNG files (inspect/ subfolder).
 * @returns InspectReport with the requested fields populated.
 */
export async function inspectAt(
  replay: Replay,
  drawIdx: number,
  events: readonly RhiCallEvent[],
  fields: readonly InspectFields[] | undefined,
  device: RhiDevice,
  outputDir: string,
): Promise<Result<InspectReport, DebugError>> {
  // Compute draw info from events up to drawIdx
  const drawInfo = extractDrawInfo(events, drawIdx);

  // Get passIdx for this draw
  const passIdx = findPassIdx(events, drawIdx);

  // Determine which fields to include
  const fieldSet = fields !== undefined ? new Set(fields) : undefined;
  const wantBindings = fieldSet === undefined || fieldSet.has('bindings');
  const wantDrawCall = fieldSet === undefined || fieldSet.has('drawCall');
  const wantRt = fieldSet === undefined || fieldSet.has('rt');

  // Build report with only requested fields
  let rtPath: string | undefined;
  if (wantRt) {
    const pngResult = await readbackAndEncodePng(replay, drawIdx, device, outputDir);
    if (!pngResult.ok) {
      return err(pngResult.error);
    }
    rtPath = pngResult.value;
  }

  // Build the report object via a mutable record to allow field cropping
  const result: Record<string, unknown> = {
    frameIdx: drawInfo.frameIdx,
    drawIdx,
    passIdx,
  };
  if (wantBindings) {
    result.bindings = drawInfo.bindings;
  }
  if (wantDrawCall) {
    result.drawCall = drawInfo.drawCall;
  }
  if (rtPath !== undefined) {
    result.rt = rtPath;
  }

  // biome-ignore lint/suspicious/noExplicitAny: structural compatible with InspectReport
  return ok(result as any);
}

/**
 * Project the recorder-side `RhiBindResourceKind` (closed 4 union, mirrors
 * the RHI BindResource kind discriminant) onto the inspector-facing
 * `InspectBindingEntry.kind` set ('buffer' | 'texture' | 'sampler' |
 * 'textureView'). cubemap / 2D / 3D / array textures all flow through
 * `textureView` — the recorder cannot distinguish dimension at this
 * boundary, so AI users discriminate texture dimension via the
 * `createTextureView`/`createTexture` event chain rather than this enum.
 */
function mapResourceKindToInspectKind(
  k: 'sampler' | 'buffer' | 'textureView' | 'externalTexture',
): 'buffer' | 'texture' | 'sampler' | 'textureView' {
  switch (k) {
    case 'sampler':
      return 'sampler';
    case 'buffer':
      return 'buffer';
    case 'textureView':
      return 'textureView';
    case 'externalTexture':
      return 'texture';
  }
}

/**
 * Extract draw information from tape events up to a given draw index.
 *
 * Walks events from start, tracking frameMark boundaries, bind group state,
 * and the current render pass setup to produce the InspectReport fields.
 */
function extractDrawInfo(events: readonly RhiCallEvent[], targetDrawIdx: number): DrawInfo {
  let frameIdx = 0;
  let currentGlobalDrawIdx = 0;
  let foundDraw = false;

  // Track bind group state per index (most recent setBindGroup)
  const bindGroups = new Map<number, InspectBindingEntry[]>();

  // I-8 fix (round 1 implement-review): index createBindGroup events by
  // handleId so setBindGroup can resolve to the real per-entry kind +
  // resourceHandleId list (covers cubemap, sampler, multi-buffer mixes;
  // AC-29 requires Sponza skylight cubemap to surface as a texture/
  // textureView entry, not a collapsed dummy 'buffer').
  const bindGroupDefs = new Map<
    string,
    {
      readonly entries: readonly {
        readonly binding: number;
        readonly resourceKind: 'sampler' | 'buffer' | 'textureView' | 'externalTexture';
      }[];
      readonly resourceHandleIds: readonly string[];
    }
  >();

  // Track the last color attachment from beginRenderPass
  let lastColorAttachmentHandleId: string | undefined;
  // Track whether we saw a setPipeline event (for draw call kind)
  const lastSeenPerPass: Map<
    string,
    { pipelineKind: 'render' | 'compute'; pipelineHandleId: string }
  > = new Map();
  let currentPassHandleId: string | undefined;

  let drawBindings: InspectBindingEntry[] = [];
  let drawCall: InspectDrawCall | null = null;
  let drawPassHandleId: string | undefined;

  for (const event of events) {
    if (event.kind === 'frameMark') {
      frameIdx = event.frameIdx;
    }

    // Track pass boundaries
    if (event.kind === 'beginRenderPass') {
      currentPassHandleId = event.passHandleId;
      lastColorAttachmentHandleId = event.colorAttachmentViewHandleIds[0] ?? undefined;
    } else if (event.kind === 'endRenderPass') {
      currentPassHandleId = undefined;
    }

    if (event.kind === 'setPipeline') {
      if (currentPassHandleId !== undefined) {
        lastSeenPerPass.set(currentPassHandleId, {
          pipelineKind: 'render',
          pipelineHandleId: event.pipelineHandleId,
        });
      }
    } else if (event.kind === 'setComputePipeline') {
      if (currentPassHandleId !== undefined) {
        lastSeenPerPass.set(currentPassHandleId, {
          pipelineKind: 'compute',
          pipelineHandleId: event.pipelineHandleId,
        });
      }
    }

    // I-8: stash createBindGroup definitions so setBindGroup can resolve
    // back to the per-entry shape.
    if (event.kind === 'createBindGroup') {
      bindGroupDefs.set(event.handleId, {
        entries: event.entries,
        resourceHandleIds: event.resourceHandleIds,
      });
    }

    if (event.kind === 'setBindGroup') {
      // I-8: resolve setBindGroup -> createBindGroup definition. Each
      // tracked entry uses its real resourceKind (cubemap/sampler/buffer)
      // and the resourceHandleId from the createBindGroup event. If no
      // matching definition is found (e.g. tape truncation), fall back
      // to a single placeholder entry pointing at the bindGroup itself
      // so the contract `bindings[].handleId` stays non-empty.
      const def = bindGroupDefs.get(event.bindGroupHandleId);
      if (def !== undefined) {
        const resolved: InspectBindingEntry[] = def.entries.map((e, idx) => ({
          groupIndex: event.index,
          entryIndex: e.binding,
          handleId: def.resourceHandleIds[idx] ?? event.bindGroupHandleId,
          kind: mapResourceKindToInspectKind(e.resourceKind),
        }));
        bindGroups.set(event.index, resolved);
      } else {
        bindGroups.set(event.index, [
          {
            groupIndex: event.index,
            entryIndex: 0,
            handleId: event.bindGroupHandleId,
            kind: 'buffer',
          },
        ]);
      }
    }

    // Check for draw calls
    if (
      event.kind === 'draw' ||
      event.kind === 'drawIndexed' ||
      event.kind === 'dispatchWorkgroups'
    ) {
      if (currentGlobalDrawIdx === targetDrawIdx) {
        foundDraw = true;
        drawPassHandleId = currentPassHandleId;

        // Collect all current bind group entries
        const entries: InspectBindingEntry[] = [];
        for (const bgEntry of bindGroups.values()) {
          entries.push(...bgEntry);
        }
        drawBindings = entries;

        // Build draw call
        const pipelineInfo =
          drawPassHandleId !== undefined ? lastSeenPerPass.get(drawPassHandleId) : undefined;

        if (event.kind === 'draw') {
          drawCall = {
            pipelineKind: pipelineInfo?.pipelineKind ?? 'render',
            pipelineHandleId: pipelineInfo?.pipelineHandleId ?? 'unknown',
            vertexCount: event.vertexCount,
            instanceCount: event.instanceCount,
          };
        } else if (event.kind === 'drawIndexed') {
          drawCall = {
            pipelineKind: pipelineInfo?.pipelineKind ?? 'render',
            pipelineHandleId: pipelineInfo?.pipelineHandleId ?? 'unknown',
            indexCount: event.indexCount,
            instanceCount: event.instanceCount,
          };
        } else {
          drawCall = {
            pipelineKind: pipelineInfo?.pipelineKind ?? 'compute',
            pipelineHandleId: pipelineInfo?.pipelineHandleId ?? 'unknown',
            dispatchX: event.x,
            dispatchY: event.y,
            dispatchZ: event.z,
          };
        }
        break;
      }
      currentGlobalDrawIdx++;
    }
  }

  if (!foundDraw || drawCall === null) {
    return {
      frameIdx,
      passIdx: -1,
      bindings: [],
      drawCall: {
        pipelineKind: 'render',
        pipelineHandleId: 'unknown',
      },
      colorAttachmentHandleId: undefined,
    };
  }

  return {
    frameIdx,
    passIdx: -1, // Will be computed by findPassIdx
    bindings: drawBindings,
    drawCall,
    colorAttachmentHandleId: lastColorAttachmentHandleId,
  };
}

/**
 * Find the pass index for a given draw index.
 *
 * Uses computePassOffsets to find which pass contains the draw.
 */
function findPassIdx(events: readonly RhiCallEvent[], drawIdx: number): number {
  const offsets = computePassOffsets(events);
  for (const offset of offsets) {
    if (drawIdx >= offset.startDrawIdx && drawIdx <= offset.endDrawIdx) {
      return offset.passIdx;
    }
  }
  return -1;
}

// ============================================================================
// RT readback + PNG encode (m6-3)
// ============================================================================

/**
 * Read back the color attachment RT from a replay after stepping to drawIdx,
 * and encode it as PNG.
 *
 * Steps:
 * 1. reset() replay to start
 * 2. Find the last beginRenderPass before drawIdx -> get color attachment handle
 * 3. stepTo the event index just after the draw call
 * 4. Create a readback buffer
 * 5. Create a command encoder, copyTextureToBuffer, submit
 * 6. await onSubmittedWorkDone
 * 7. mapAsync readback buffer
 * 8. getMappedRange, encode PNG, write file
 * 9. unmap buffer, destroy temp resources
 *
 * @returns Ok(pngFilePath) or Err(DebugError) on readback/encode failure.
 */
async function readbackAndEncodePng(
  replay: Replay,
  drawIdx: number,
  device: RhiDevice,
  outputDir: string,
): Promise<Result<string, DebugError>> {
  // Ensure output directory exists
  const inspectDir = path.join(outputDir, 'inspect');
  try {
    await fs.promises.mkdir(inspectDir, { recursive: true });
  } catch {
    // Directory may already exist -- that's fine
  }

  // We need to replay up to the draw, then read back.
  // The caller should have already stepped the replay to the right position.
  // For now: create a fresh replay from the tape and step to it.

  // Replay step: need to get events and step to the draw
  // Since we don't have events here, this function relies on the caller
  // having arranged the replay to be at the right state.

  // Access the replay's internal handle map to get the color attachment texture.
  // The Replay interface exposes _resolveHandle for the inspector.
  const events = (replay as unknown as { _events: readonly RhiCallEvent[] })._events as
    | readonly RhiCallEvent[]
    | undefined;
  if (events === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'replay to expose internal _events for RT readback',
        hint: 'the Replay implementation must provide _events accessor for the inspector',
      }),
    );
  }

  // Find the color attachment texture handle at drawIdx
  const drawInfo = extractDrawInfo(events, drawIdx);
  if (drawInfo.colorAttachmentHandleId === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'a color attachment exists at the given drawIdx',
        hint: `no color attachment found at drawIdx ${drawIdx}; the draw may be in a compute pass or the tape may have no render pass`,
      }),
    );
  }

  // Resolve the texture handle from the replay
  const resolveHandle = (replay as unknown as { _resolveHandle(id: string): unknown })
    ._resolveHandle;
  if (typeof resolveHandle !== 'function') {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'replay to expose _resolveHandle method for RT readback',
        hint: 'the Replay implementation must provide _resolveHandle accessor for the inspector',
      }),
    );
  }

  const texture = resolveHandle(drawInfo.colorAttachmentHandleId);
  // biome-ignore lint/suspicious/noExplicitAny: texture is an opaque branded type from RHI
  const tex = texture as any;
  if (tex === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'color attachment texture was recreated by replay',
        hint: `handleId '${drawInfo.colorAttachmentHandleId}' not found in replay handle map`,
      }),
    );
  }

  // Shared utility (round 2 m5b-1): resolve real texture dimensions by walking
  // events to find the createTexture/createTextureView chain that produced the
  // colorAttachment handleId. Avoids hard-coding 512x512.
  const texSize = resolveAttachmentSize(events, drawInfo.colorAttachmentHandleId);
  const texWidth = texSize.width;
  const texHeight = texSize.height;

  // Shared utility (round 2 m5b-1): read back tight-packed RGBA8 pixels from the
  // GPU texture. This replaces the previous inline copyTextureToBuffer + mapAsync
  // chain with the shared readbackTexturePixels helper.
  let pixels: Uint8Array;
  try {
    pixels = await readbackTexturePixels(device, tex, texWidth, texHeight);
  } catch (e) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: 'readbackTexturePixels to succeed',
        hint: `GPU readback failed: ${String(e)}`,
      }),
    );
  }

  // Encode PNG (use lazy import of pngjs for tree-shake friendliness)
  const pngFilePath = path.join(inspectDir, `d${String(drawIdx).padStart(4, '0')}-rt0.png`);

  try {
    // Use eval-based import to prevent static analysis by esbuild/tsup
    // when rhi-debug is bundled by downstream packages (e.g., the app).
    // pngjs is a Node.js library that uses 'util'/'stream' builtins
    // which are unavailable in browser/neutral platform builds.
    const { PNG } = (await new Function('specifier', 'return import(specifier)')(
      'pngjs',
    )) as typeof import('pngjs');
    const png = new PNG({ width: texWidth, height: texHeight });
    // pixels is tight-packed RGBA (readbackTexturePixels already strips alignment padding)
    png.data.set(pixels);
    const pngBuffer = PNG.sync.write(png);
    await fs.promises.writeFile(pngFilePath, pngBuffer);
  } catch (e) {
    return err(
      new DebugError({
        code: 'png-encode-failed',
        expected: 'PNG encoding to succeed',
        hint: `pngjs encoding failed: ${String(e)}; the RT was successfully read back but could not be encoded as PNG`,
      }),
    );
  }

  return ok(pngFilePath);
}

// ============================================================================
// Pass PNG on-demand generation (m6-3)
// ============================================================================

/**
 * Generate a pass PNG file for the given pass index.
 *
 * Steps:
 * 1. Compute pass offsets from events
 * 2. Step replay to the end of the pass
 * 3. Read back the RT at the end of the pass
 * 4. Encode PNG to passes/{passIdx:04d}.png
 *
 * @param replay - The Replay session to step.
 * @param passIdx - The pass index to generate PNG for.
 * @param events - The tape events array.
 * @param device - The RhiDevice for RT readback.
 * @param outputDir - The output directory for PNG files.
 * @returns Ok(pngFilePath) if generated, or Ok(path) if already exists.
 */
export async function generatePassPng(
  replay: Replay,
  passIdx: number,
  events: readonly RhiCallEvent[],
  device: RhiDevice,
  outputDir: string,
): Promise<Result<string, DebugError>> {
  const passesDir = path.join(outputDir, 'passes');
  const pngFilePath = path.join(passesDir, `${String(passIdx).padStart(4, '0')}.png`);

  // Check if already exists
  try {
    await fs.promises.access(pngFilePath);
    return ok(pngFilePath);
  } catch {
    // File doesn't exist, need to generate
  }

  // Ensure directory exists
  try {
    await fs.promises.mkdir(passesDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  // Find the drawIdx at the end of the pass
  const offsets = computePassOffsets(events);
  const passOffsets = offsets.filter((o) => o.passIdx === passIdx);
  if (passOffsets.length === 0) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: `pass index ${passIdx} to exist in tape pass offsets`,
        hint: `no pass found at index ${passIdx}; available pass indices: ${offsets.map((o) => o.passIdx).join(', ')}`,
      }),
    );
  }

  const passOffset = passOffsets[0];
  if (passOffset === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: `pass index ${passIdx} to exist in tape pass offsets`,
        hint: `no pass found at index ${passIdx}; available pass indices: ${offsets.map((o) => o.passIdx).join(', ')}`,
      }),
    );
  }
  const drawIdx = passOffset.endDrawIdx;

  // Step replay to end of pass
  const stepResult = await replay.stepTo(drawIdx);
  if (!stepResult.ok) {
    return err(stepResult.error);
  }

  // Read back and encode PNG
  const pngResult = await readbackAndEncodePng(replay, drawIdx, device, outputDir);
  if (!pngResult.ok) {
    return err(pngResult.error);
  }

  // Rename from inspect/ path to passes/ path
  try {
    await fs.promises.rename(pngResult.value, pngFilePath);
  } catch {
    // If rename fails (e.g., cross-device), copy then unlink
    await fs.promises.copyFile(pngResult.value, pngFilePath);
    try {
      await fs.promises.unlink(pngResult.value);
    } catch {
      // best effort cleanup
    }
  }

  return ok(pngFilePath);
}
