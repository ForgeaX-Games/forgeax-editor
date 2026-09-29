import type { Renderer } from '@forgeax/engine-render';

/**
 * Play-realm completed-frame subscription. Kept local so preview boot does not
 * depend on editor-core/protocol re-export visibility in Vite's module graph.
 */
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
