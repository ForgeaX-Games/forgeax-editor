import { afterEach, describe, expect, it } from 'bun:test';
import { registerActivePageSaveHandler } from '@forgeax/editor-core';
import { buildKeyboardRouterDeps } from '../keyboard-router-deps';

describe('buildKeyboardRouterDeps — active page save (M4/B3)', () => {
  afterEach(() => {
    registerActivePageSaveHandler(null);
  });

  it('diverts Ctrl+S to the active-page handler when registered', () => {
    let handled = 0;
    registerActivePageSaveHandler(() => {
      handled += 1;
      return true;
    });
    const deps = buildKeyboardRouterDeps();
    deps.save();
    expect(handled).toBe(1);
  });

  it('falls through when the handler returns false', () => {
    registerActivePageSaveHandler(() => false);
    const deps = buildKeyboardRouterDeps();
    // Should not throw; scene save path still runs (may reject without a live doc).
    expect(() => deps.save()).not.toThrow();
  });
});
