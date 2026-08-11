import { describe, expect, test } from 'bun:test';
import { EditGateway, createEditSession, registerTransientApplier } from '@forgeax/editor-core';
import type { PreviewExecutorClient, PreviewExecutorResult } from '../runtime/preview-executor-lease';
import {
  bindVfxPreviewExecutorLease,
  VFX_PREVIEW_LEASE_KIND,
  VFX_PREVIEW_OPERATION_IDS,
} from './vfx-preview-operations';

const identity = {
  version: 'preview-executor-lease/v1',
  leaseId: 'vfx-lease-a',
  kind: VFX_PREVIEW_LEASE_KIND,
  assetGuid: 'vfx-asset-a',
  generation: 7,
} as const;

function command(kind: string, requestId: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    assetGuid: identity.assetGuid,
    previewGeneration: identity.generation,
    requestId,
    ...extra,
  } as never;
}

describe('VFX preview operations', () => {
  test('projects one live capability set and gives human and AI the same executor', async () => {
    const executed: unknown[] = [];
    const client: PreviewExecutorClient = {
      identity,
      async execute(input) {
        executed.push(input);
        return { ok: true, value: { accepted: input } };
      },
      dispose() {},
    };
    const gateway = new EditGateway(createEditSession());
    const unbind = bindVfxPreviewExecutorLease(identity, client);
    try {
      expect(gateway.listOps().filter((entry) => entry.id.startsWith('vfx.preview.')))
        .toHaveLength(7);
      const human = gateway.dispatch(command(VFX_PREVIEW_OPERATION_IDS.play, 'preview-human'), 'human');
      const ai = gateway.dispatch(command(VFX_PREVIEW_OPERATION_IDS.play, 'preview-ai'), 'ai');
      const humanFrame = gateway.dispatch(command(
        VFX_PREVIEW_OPERATION_IDS.frameBounds,
        'preview-human-frame',
      ), 'human');
      const aiBounds = gateway.dispatch(command(
        VFX_PREVIEW_OPERATION_IDS.setBoundsVisible,
        'preview-ai-bounds',
        { visible: true },
      ), 'ai');
      expect(human).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      expect(ai).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      expect(humanFrame).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      expect(aiBounds).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      await expect(gateway.waitOperationRun('preview-human')).resolves.toMatchObject({
        ok: true,
        value: { status: 'succeeded' },
      });
      await expect(gateway.waitOperationRun('preview-ai')).resolves.toMatchObject({
        ok: true,
        value: { status: 'succeeded' },
      });
      await gateway.waitOperationRun('preview-human-frame');
      await gateway.waitOperationRun('preview-ai-bounds');
      expect(executed).toEqual([
        { kind: 'play' },
        { kind: 'play' },
        { kind: 'frameBounds' },
        { kind: 'setBoundsVisible', visible: true },
      ]);
    } finally {
      unbind();
    }
    expect(gateway.listOps().some((entry) => entry.id.startsWith('vfx.preview.'))).toBe(false);
  });

  test('turns a disconnected in-flight seek into one failed Gateway run', async () => {
    let finish!: (result: PreviewExecutorResult) => void;
    const pending = new Promise<PreviewExecutorResult>((resolve) => { finish = resolve; });
    const client: PreviewExecutorClient = {
      identity,
      execute: () => pending,
      dispose() {
        finish({
          ok: false,
          error: {
            code: 'preview-executor-disconnected',
            owner: 'host',
            category: 'transport',
            hint: 'preview disconnected',
            retryable: true,
            recoveryActions: ['editor.discover'],
          },
        });
      },
    };
    const gateway = new EditGateway(createEditSession());
    const unbind = bindVfxPreviewExecutorLease(identity, client);
    const accepted = gateway.dispatch(command(
      VFX_PREVIEW_OPERATION_IDS.seek,
      'preview-seek-stale',
      { phaseTick: 180 },
    ), 'human');
    expect(accepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });

    unbind();
    client.dispose();
    await expect(gateway.waitOperationRun('preview-seek-stale')).resolves.toMatchObject({
      ok: true,
      value: {
        status: 'failed',
        error: { code: 'preview-executor-disconnected', retryable: true },
      },
    });
  });

  test('rolls back earlier registrations when the lease cannot bind atomically', () => {
    const gateway = new EditGateway(createEditSession());
    const releaseConflict = registerTransientApplier(
      VFX_PREVIEW_OPERATION_IDS.pause,
      () => ({ ok: true }),
      { title: 'Conflicting Pause' },
    );
    const client: PreviewExecutorClient = {
      identity,
      execute: async () => ({ ok: true, value: null }),
      dispose() {},
    };
    try {
      expect(() => bindVfxPreviewExecutorLease(identity, client)).toThrow('already registered');
      expect(gateway.listOps().find((entry) => entry.id === VFX_PREVIEW_OPERATION_IDS.play)).toBeUndefined();
      expect(gateway.listOps().find((entry) => entry.id === VFX_PREVIEW_OPERATION_IDS.pause)?.title)
        .toBe('Conflicting Pause');
    } finally {
      releaseConflict();
    }
  });
});
