import { describe, expect, test } from 'bun:test';
import { VIEWPORT_RUNTIME_CONTRACT_VERSION } from '@forgeax/editor-product';
import { buildViewportRuntimeUrl } from './ViewportRuntimeFrame';

describe('ViewportRuntimeFrame URL', () => {
  test('threads authority and host-origin facts into the replaceable carrier', () => {
    const url = new URL(buildViewportRuntimeUrl('/editor/', {
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtimeId: 'edit-a',
      runtimeGeneration: 9,
      carrierId: 'dock-a',
      carrierKind: 'iframe',
    }, 'https://shell.test', 'https://runtime.test/workbench'));

    expect(url.origin).toBe('https://runtime.test');
    expect(url.pathname).toBe('/editor/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      runtimeId: 'edit-a',
      runtimeGeneration: '9',
      carrierId: 'dock-a',
      carrierKind: 'iframe',
      hostOrigin: 'https://shell.test',
    });
  });
});
