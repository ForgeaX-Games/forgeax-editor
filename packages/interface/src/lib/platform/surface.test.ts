import { describe, expect, test } from 'bun:test';
import {
  decodeSurfaceFromLocation,
  encodeSurfaceQuery,
  encodeSurfaceWindowQuery,
  surfaceKey,
  surfaceWindowLabel,
  surfaceWindowUrl,
} from './surface';

function decodeWindowLabel(label: string): string {
  const encoded = label.slice('fx-surface-'.length).replace(/-/g, '+').replace(/_/g, '/');
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
}

describe('detached surface carrier query', () => {
  test('fences the Viewport Runtime generation for browser popup and Tauri WebView', () => {
    for (const carrierKind of ['browser-page', 'tauri-webview'] as const) {
      const params = new URLSearchParams(encodeSurfaceWindowQuery(
        { kind: 'panel', id: 'viewport' },
        carrierKind,
        42,
        'https://shell.test',
      ));
      expect(Object.fromEntries(params)).toEqual({
        surface: 'panel',
        id: 'viewport',
        runtimeId: 'edit-runtime',
        runtimeGeneration: '42',
        carrierId: `${carrierKind}-42`,
        carrierKind,
        hostOrigin: 'https://shell.test',
      });
    }
  });

  test('does not turn an ordinary business panel into a Runtime carrier', () => {
    expect(encodeSurfaceWindowQuery(
      { kind: 'panel', id: 'chat' },
      'browser-page',
      42,
      'https://shell.test',
    )).toBe('surface=panel&id=chat');
  });

  test('keeps a Tauri carrier on the current sidecar origin and path', () => {
    expect(surfaceWindowUrl(
      { kind: 'panel', id: 'viewport' },
      'tauri-webview',
      'http://127.0.0.1:41017/editor/index.html?stale=1#shell',
      42,
    )).toBe(
      'http://127.0.0.1:41017/editor/index.html?surface=panel&id=viewport&runtimeId=edit-runtime&runtimeGeneration=42&carrierId=tauri-webview-42&carrierKind=tauri-webview&hostOrigin=http%3A%2F%2F127.0.0.1%3A41017',
    );
  });

  test('round-trips stable instance identity through the detached URL', () => {
    const surface = {
      kind: 'plugin' as const,
      id: '@demo/tool',
      pane: 'left' as const,
      instance: 'page:v1:s:%40demo%2Ftool%23page%2Fmain::preview',
    };
    expect(decodeSurfaceFromLocation(`?${encodeSurfaceQuery(surface)}`)).toEqual(surface);
  });

  test('isolates otherwise-identical surfaces by instance identity', () => {
    const base = { kind: 'plugin' as const, id: '@demo/tool', pane: 'left' as const };
    expect(surfaceKey({ ...base, instance: 'page-a::main' }))
      .not.toBe(surfaceKey({ ...base, instance: 'page-b::main' }));
  });

  test('encodes labels injectively with stable Tauri-safe base64url', () => {
    const colon = { kind: 'plugin' as const, id: '@demo/tool', instance: 'a:b' };
    const escapedLookalike = { kind: 'plugin' as const, id: '@demo/tool', instance: 'a_3Ab' };
    const colonLabel = surfaceWindowLabel(colon);

    expect(colonLabel).toBe(surfaceWindowLabel(colon));
    expect(colonLabel).not.toBe(surfaceWindowLabel(escapedLookalike));
    expect(colonLabel).toMatch(/^fx-surface-[A-Za-z0-9_-]+$/);
    expect(surfaceWindowLabel({ kind: 'panel', id: 'chat' }))
      .toBe('fx-surface-cGFuZWw6Y2hhdA');
    const unicode = { kind: 'plugin' as const, id: '@demo/工具', instance: '页面：一' };
    expect(decodeWindowLabel(surfaceWindowLabel(unicode))).toBe(surfaceKey(unicode));
  });
});
