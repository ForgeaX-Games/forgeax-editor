import { describe, expect, it } from 'bun:test';
import {
  createDefaultInputMapPayload,
  getInputMapStaging,
  isInputMapStagingDirty,
  updateInputMapStaging,
} from '@forgeax/editor-core';
import { broadcastAssetsChanged } from '../packages/core/src/store/assets-changed';
import { createInputMapPageController } from './input-map-page-controller';

describe('Input Map page controller lifecycle', () => {
  it('updates its live title after rename and clears staging on dispose', async () => {
    const guid = '22222222-2222-4222-8222-222222222222';
    const payload = createDefaultInputMapPayload();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      content: JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{
          guid,
          kind: 'input-map',
          name: 'IM_Test',
          payload,
          refs: [],
        }],
      }),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const controller = createInputMapPageController({
      key: {
        cardinality: 'resource',
        typeId: '@forgeax/editor#page/input-map',
        resourceId: guid,
      },
      context: {},
      resource: {
        canonicalId: guid,
        uri: `forgeax-asset://${guid}`,
        displayPath: 'IM_Test',
        kind: 'input-map',
        metadata: {
          asset: {
            guid,
            kind: 'input-map',
            name: 'IM_Test',
            payload,
            packPath: 'assets/IM_Test.pack.json',
          },
        },
      },
    });
    let titleChanges = 0;
    const unsubscribeTitle = controller.subscribeTitle?.(() => {
      titleChanges += 1;
    });

    try {
      broadcastAssetsChanged('pack-changed', 'local-op', {
        kind: 'renamed',
        guid,
        name: 'IM_Player',
      });

      expect(controller.getTitle?.()).toBe('IM_Player');
      expect(getInputMapStaging(guid)?.name).toBe('IM_Player');
      expect(titleChanges).toBe(1);
    } finally {
      unsubscribeTitle?.();
      await controller.dispose();
      globalThis.fetch = originalFetch;
    }

    expect(getInputMapStaging(guid)).toBeUndefined();
  });

  it('keeps the dirty page openable when semantic errors block close-save', async () => {
    const guid = '33333333-3333-4333-8333-333333333333';
    const payload = createDefaultInputMapPayload([{
      action: 'jump',
      bindings: [{ type: 'key', key: ' ' }],
    }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      content: JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{
          guid,
          kind: 'input-map',
          name: 'IM_Invalid_Close',
          payload,
          refs: [],
        }],
      }),
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const controller = createInputMapPageController({
      key: {
        cardinality: 'resource',
        typeId: '@forgeax/editor#page/input-map',
        resourceId: guid,
      },
      context: {},
      resource: {
        canonicalId: guid,
        uri: `forgeax-asset://${guid}`,
        displayPath: 'IM_Invalid_Close',
        kind: 'input-map',
        metadata: {
          asset: {
            guid,
            kind: 'input-map',
            name: 'IM_Invalid_Close',
            payload,
            packPath: 'assets/IM_Invalid_Close.pack.json',
          },
        },
      },
    });

    try {
      updateInputMapStaging(guid, (current) => ({
        ...current,
        actions: [{ ...current.actions[0]!, action: '' }],
      }));

      await expect(controller.save?.()).rejects.toThrow('fix 1 Input Map error first');
      expect(isInputMapStagingDirty(guid)).toBe(true);
      expect(getInputMapStaging(guid)?.saveStatus).toBe('idle');
    } finally {
      await controller.dispose();
      globalThis.fetch = originalFetch;
    }
  });
});
