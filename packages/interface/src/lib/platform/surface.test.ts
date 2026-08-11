import { describe, expect, test } from 'bun:test';
import { encodeSurfaceWindowQuery } from './surface';

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
});
