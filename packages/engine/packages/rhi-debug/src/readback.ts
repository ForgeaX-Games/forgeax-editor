// @forgeax/engine-rhi-debug/src/readback — shared GPU texture→host readback utilities.
//
// Extracted from inspector.ts (round 1 fix-up 34be40d6, I-7) for reuse by
// replayer.readbackRt() (m5b-1) and e2e.dawn.test.ts (m5b-3).
//
// Related: plan-strategy §5.3.1; m5b-1 / m5b-3.

/// <reference types="@webgpu/types" />

import type { RhiDevice, RhiQueue } from '@forgeax/engine-rhi';
import type { RhiCallEvent } from './types';

// ============================================================================
// resolveAttachmentSize — walk tape events to find texture dimensions
// ============================================================================

/**
 * Walk the tape events to find the real texture dimensions for a given
 * color attachment view/target handleId. Avoids hard-coding 512×512.
 *
 * Returns { width: 512, height: 512 } as a conservative fallback when no
 * createTexture event is found (should not happen for a real frame).
 */
export function resolveAttachmentSize(
  events: readonly RhiCallEvent[],
  attachmentViewHandleId: string,
): { readonly width: number; readonly height: number } {
  // Find the createTextureView whose resultHandleId matches.
  let sourceTextureHandleId: string | undefined;
  for (const ev of events) {
    if (ev.kind === 'createTextureView' && ev.resultHandleId === attachmentViewHandleId) {
      sourceTextureHandleId = ev.sourceHandleId;
      break;
    }
  }
  // Some attachments are texture handles directly (no view event).
  const targetHandleId = sourceTextureHandleId ?? attachmentViewHandleId;

  // Find the createTexture event for the resolved texture handleId.
  for (const ev of events) {
    if (ev.kind === 'createTexture' && ev.handleId === targetHandleId) {
      const sz = ev.desc.size;
      // GPUExtent3DStrict: { width, height? } or [w, h?, d?]
      if (Array.isArray(sz)) {
        const w = typeof sz[0] === 'number' ? sz[0] : 512;
        const h = typeof sz[1] === 'number' ? sz[1] : w;
        return { width: w, height: h };
      }
      const obj = sz as { width: number; height?: number };
      const w = typeof obj.width === 'number' ? obj.width : 512;
      const h = typeof obj.height === 'number' ? obj.height : w;
      return { width: w, height: h };
    }
  }

  return { width: 512, height: 512 };
}

// ============================================================================
// readbackTexturePixels — copyTextureToBuffer + mapAsync + getMappedRange
// ============================================================================

/**
 * Read back raw RGBA8 pixels from a GPU texture into a host-side Uint8Array.
 *
 * Steps:
 * 1. Create a staging buffer (COPY_DST | MAP_READ) sized to aligned rows.
 * 2. Create a command encoder + copyTextureToBuffer.
 * 3. Finish + submit + await onSubmittedWorkDone.
 * 4. mapAsync(READ) + getMappedRange() → new Uint8Array(slice).
 * 5. Unmap + destroy staging buffer.
 *
 * The returned Uint8Array has length = texWidth * texHeight * 4 (tight;
 * alignment padding is stripped). The buffer alignment is WebGPU 256-byte
 * row requirement.
 *
 * @param device - The RHI device that owns the texture.
 * @param texture - The texture to read back (opaque branded handle cast as any).
 * @param texWidth - Texture width in pixels.
 * @param texHeight - Texture height in pixels.
 */
export async function readbackTexturePixels(
  device: RhiDevice,
  texture: unknown,
  texWidth: number,
  texHeight: number,
): Promise<Uint8Array> {
  const bytesPerPixel = 4;
  const rowBytes = texWidth * bytesPerPixel;
  const alignedRowBytes = Math.ceil(rowBytes / 256) * 256; // WebGPU alignment
  const bufferSize = alignedRowBytes * texHeight;

  // GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ = 8 | 1 = 9
  const COPY_DST_MAP_READ = 9;

  const readbackBufferResult = device.createBuffer({
    size: bufferSize,
    usage: COPY_DST_MAP_READ,
  });
  if (!readbackBufferResult.ok) {
    throw new Error(`createBuffer for readback failed: ${readbackBufferResult.error.code}`);
  }
  const readbackBuffer = readbackBufferResult.value;

  const encoderResult = device.createCommandEncoder({});
  if (!encoderResult.ok) {
    device.destroyBuffer(readbackBuffer);
    throw new Error(`createCommandEncoder for readback failed: ${encoderResult.error.code}`);
  }
  const encoder = encoderResult.value;

  try {
    encoder.copyTextureToBuffer(
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } } as unknown as never,
      {
        buffer: readbackBuffer,
        offset: 0,
        bytesPerRow: alignedRowBytes,
        rowsPerImage: texHeight,
      } as unknown as never,
      { width: texWidth, height: texHeight, depthOrArrayLayers: 1 },
    );
  } catch {
    device.destroyBuffer(readbackBuffer);
    throw new Error('copyTextureToBuffer failed');
  }

  const finishResult = encoder.finish();
  if (!finishResult.ok) {
    device.destroyBuffer(readbackBuffer);
    throw new Error(`encoder.finish failed: ${finishResult.error.code}`);
  }

  const queue: RhiQueue = device.queue;
  queue.submit([finishResult.value as unknown as never] as unknown as readonly never[]);
  await queue.onSubmittedWorkDone();

  // GPUMapMode.READ = 2
  await (readbackBuffer as unknown as { mapAsync(mode: number): Promise<void> }).mapAsync(2);

  const mappedRange = (
    readbackBuffer as unknown as { getMappedRange(offset?: number, size?: number): ArrayBuffer }
  ).getMappedRange();
  const fullPixels = new Uint8Array(mappedRange);

  // Extract tight pixels (strip alignment padding)
  const tightPixels = new Uint8Array(texWidth * texHeight * bytesPerPixel);
  for (let y = 0; y < texHeight; y++) {
    const srcOffset = y * alignedRowBytes;
    const dstOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      tightPixels[dstOffset + x] = fullPixels[srcOffset + x] ?? 0;
    }
  }

  // Cleanup
  (readbackBuffer as unknown as { unmap(): void }).unmap();
  device.destroyBuffer(readbackBuffer);

  return tightPixels;
}
