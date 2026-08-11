import {
  registerTransientApplier,
  type SessionApplier,
  type SessionApplierMeta,
} from '@forgeax/editor-core';
import type { EditorOp } from '@forgeax/editor-core';
import {
  type PreviewExecutorClient,
  type PreviewExecutorLeaseIdentity,
} from '../runtime/preview-executor-lease';

export const VFX_PREVIEW_LEASE_KIND = 'vfx-preview/v1' as const;

export const VFX_PREVIEW_OPERATION_IDS = Object.freeze({
  play: 'vfx.preview.play',
  pause: 'vfx.preview.pause',
  reset: 'vfx.preview.reset',
  seek: 'vfx.preview.seek',
  setEmitterMask: 'vfx.preview.setEmitterMask',
  frameBounds: 'vfx.preview.frameBounds',
  setBoundsVisible: 'vfx.preview.setBoundsVisible',
});

const operationRun = Object.freeze({
  acceptedStatuses: ['accepted', 'running'] as const,
  terminalStatuses: ['succeeded', 'failed'] as const,
  read: {
    get: 'getOperationRun',
    wait: 'waitOperationRun',
    subscribe: 'subscribeOperationRun',
  },
  retry: { requiresNewRequestId: true },
  retention: { kind: 'terminal-only' as const, maxTerminalRuns: 64 },
  cancellable: false,
});

function meta(
  identity: PreviewExecutorLeaseIdentity,
  title: string,
  properties: Record<string, unknown> = {},
  required: readonly string[] = [],
): SessionApplierMeta {
  return {
    title,
    argsSchema: {
      type: 'object',
      properties: {
        assetGuid: { type: 'string', enum: [identity.assetGuid] },
        previewGeneration: { type: 'number', enum: [identity.generation] },
        requestId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
        },
        ...properties,
      },
      required: ['assetGuid', 'previewGeneration', 'requestId', ...required],
      additionalProperties: false,
    },
    operationRun,
  };
}

function invalid(
  hint: string,
  current?: unknown,
): ReturnType<SessionApplier> {
  return {
    ok: false,
    error: {
      code: 'preview-executor-stale-generation',
      owner: 'host',
      category: 'state',
      hint,
      retryable: true,
      recoveryActions: ['editor.discover'],
      ...(current === undefined ? {} : { current }),
    } as never,
  };
}

function bind(
  identity: PreviewExecutorLeaseIdentity,
  client: PreviewExecutorClient,
  command: (op: EditorOp) => unknown,
): SessionApplier {
  return (op) => {
    const input = op as EditorOp & {
      readonly assetGuid?: unknown;
      readonly previewGeneration?: unknown;
      readonly requestId?: unknown;
    };
    if (input.assetGuid !== identity.assetGuid || input.previewGeneration !== identity.generation) {
      return invalid('The VFX preview operation targets a stale asset generation.', {
        assetGuid: identity.assetGuid,
        previewGeneration: identity.generation,
      });
    }
    if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
      return invalid('The VFX preview operation requires a caller-minted requestId.');
    }
    const completion = client.execute(command(op)).then((result) => (
      result.ok
        ? { ok: true as const, result: result.value }
        : { ok: false as const, error: result.error }
    ));
    return { ok: true, completion };
  };
}

/** Runtime-owned VFX operation definitions over a generic reverse executor.
 * Disposing the lease removes every capability from Gateway discovery. */
export function bindVfxPreviewExecutorLease(
  identity: PreviewExecutorLeaseIdentity,
  client: PreviewExecutorClient,
): () => void {
  if (identity.kind !== VFX_PREVIEW_LEASE_KIND) {
    throw new Error(`unsupported preview executor kind: ${identity.kind}`);
  }
  const disposers: Array<() => void> = [];
  try {
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.play,
      bind(identity, client, () => ({ kind: 'play' })),
      meta(identity, 'Play VFX Preview'),
    ));
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.pause,
      bind(identity, client, () => ({ kind: 'pause' })),
      meta(identity, 'Pause VFX Preview'),
    ));
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.reset,
      bind(identity, client, () => ({ kind: 'reset' })),
      meta(identity, 'Reset VFX Preview'),
    ));
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.seek,
      bind(identity, client, (op) => ({
        kind: 'seek',
        phaseTick: (op as EditorOp & { readonly phaseTick: number }).phaseTick,
      })),
      meta(identity, 'Seek VFX Preview', {
        phaseTick: { type: 'number', minimum: 0, maximum: 3_600 },
      }, ['phaseTick']),
    ));
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.setEmitterMask,
      bind(identity, client, (op) => ({
        kind: 'setEmitterMask',
        emitterIds: (op as EditorOp & { readonly emitterIds: readonly string[] }).emitterIds,
      })),
      meta(identity, 'Set VFX Preview Emitter Mask', {
        emitterIds: { type: 'array', items: { type: 'string' } },
      }, ['emitterIds']),
    ));
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.frameBounds,
      bind(identity, client, () => ({ kind: 'frameBounds' })),
      meta(identity, 'Frame VFX Preview Bounds'),
    ));
    disposers.push(registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.setBoundsVisible,
      bind(identity, client, (op) => ({
        kind: 'setBoundsVisible',
        visible: (op as EditorOp & { readonly visible: boolean }).visible,
      })),
      meta(identity, 'Set VFX Preview Bounds Visibility', {
        visible: { type: 'boolean' },
      }, ['visible']),
    ));
  } catch (cause) {
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]!();
    throw cause;
  }
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]!();
  };
}
