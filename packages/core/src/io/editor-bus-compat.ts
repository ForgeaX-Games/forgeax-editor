/**
 * Compatibility bridge: re-emits panelBridge events as window.postMessage so
 * that the interface package (which has zero editor-core imports) can continue
 * to listen via its existing message handlers.
 *
 * This is temporary — the interface package should eventually accept a bus
 * injection via PanelRenderers context, at which point this shim is deleted.
 *
 * Call `installEditorBusCompat()` once at host boot (standalone/main.tsx or
 * studio host) AFTER the React tree is mounted.
 */
import { panelBridge } from './panel-bridge';
import type { EditorRefPayload } from './panel-bridge';

export function installEditorBusCompat(): () => void {
  const offs: (() => void)[] = [];

  offs.push(panelBridge.on('editorRef', (payload: EditorRefPayload) => {
    window.postMessage({ type: 'VAG_EDITOR_REF', payload }, '*');
  }));

  offs.push(panelBridge.on('addAssetToChat', (refs) => {
    window.postMessage({ type: 'FORGEAX_ADD_ASSET_TO_CHAT', refs }, '*');
  }));

  offs.push(panelBridge.on('focusPanel', ({ panel }) => {
    window.postMessage({ type: 'FORGEAX_FOCUS_PANEL', panel }, '*');
  }));

  offs.push(panelBridge.on('openSource', (payload) => {
    window.postMessage({ type: 'VAG_EDITOR_OPEN_SOURCE', payload }, '*');
  }));

  return () => { for (const off of offs) off(); };
}
