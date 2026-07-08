/**
 * Compatibility bridge: re-emits editor bus events as window.postMessage so
 * that the interface package (which has zero editor-core imports) can continue
 * to listen via its existing message handlers.
 *
 * This is temporary — the interface package should eventually accept a bus
 * injection via PanelRenderers context, at which point this shim is deleted.
 *
 * Call `installEditorBusCompat()` once at host boot (standalone/main.tsx or
 * studio host) AFTER the React tree is mounted.
 */
import { editorBus } from './editor-bus';
import type { EditorRefPayload } from './editor-bus';

export function installEditorBusCompat(): () => void {
  const offs: (() => void)[] = [];

  offs.push(editorBus.on('editorRef', (payload: EditorRefPayload) => {
    window.postMessage({ type: 'VAG_EDITOR_REF', payload }, '*');
  }));

  offs.push(editorBus.on('addAssetToChat', (refs) => {
    window.postMessage({ type: 'FORGEAX_ADD_ASSET_TO_CHAT', refs }, '*');
  }));

  offs.push(editorBus.on('focusPanel', ({ panel }) => {
    window.postMessage({ type: 'FORGEAX_FOCUS_PANEL', panel }, '*');
  }));

  offs.push(editorBus.on('openSource', (payload) => {
    window.postMessage({ type: 'VAG_EDITOR_OPEN_SOURCE', payload }, '*');
  }));

  return () => { for (const off of offs) off(); };
}
