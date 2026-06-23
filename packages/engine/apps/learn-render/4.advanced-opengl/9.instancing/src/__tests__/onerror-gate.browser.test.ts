import { afterEach, describe, expect, it } from 'vitest';

import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';

describe('learn-render 4.9 instancing onerror-gate (reverse expectation)', () => {
  let canvas: HTMLCanvasElement | undefined;

  afterEach(() => {
    if (canvas !== undefined && canvas.parentNode !== null) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = undefined;
    delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
  });

  // it.fails: this assertion is EXPECTED to fail. The 4.9 instancing demo's
  // bootstrap fires a SUT_ATTRIBUTABLE_CODES code (asset-not-imported or a
  // sibling) because the engine-side vite-plugin-pack mesh DDC import arm is
  // missing (OOS-1). Once the engine follow-up loop fixes that gap, this
  // test will pass — i.e. expected-fail flips to expected-pass and Vitest
  // turns the suite RED, forcing the next AI user to flip it.fails(...)
  // back to it(...).
  it.fails('SUT bootstrap fires no SUT-attributable error', async () => {
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[learn-render 4.9 instancing.onerror-gate] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags",
      );
    }
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    const errors: Array<{ code: string; hint?: string }> = [];
    (globalThis as unknown as { __learnRenderErrors: typeof errors }).__learnRenderErrors = errors;

    await import('../index.ts');

    let prev = -1;
    for (let elapsed = 0; elapsed < 5000; elapsed += 50) {
      await new Promise((r) => setTimeout(r, 50));
      if (errors.length === prev) {
        if (elapsed >= 500) break;
      } else {
        prev = errors.length;
      }
    }

    const sutErrors = errors.filter((e) => SUT_ATTRIBUTABLE_CODES.has(e.code));
    expect(sutErrors).toEqual([]);
  });
});
