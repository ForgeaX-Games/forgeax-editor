import type { Renderer } from '@forgeax/engine-render';

/** Completed-frame subscription; prefers host hook, always falls back to renderer.subscribe. */
export function subscribeRendererFrameEnd(
  renderer: Pick<Renderer, 'subscribe'>,
  host?: { subscribeFrameEnd?: (listener: () => void) => () => void } | null,
): (listener: () => void) => () => void {
  if (host !== undefined && host !== null && typeof host.subscribeFrameEnd === 'function') {
    return (listener) => host.subscribeFrameEnd!(listener);
  }
  return (listener) => renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') listener();
  });
}
