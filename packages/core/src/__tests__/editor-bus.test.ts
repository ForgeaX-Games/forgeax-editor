// editor-bus.test.ts — unit tests for the typed event bus (editorBus) and the
// postMessage compatibility bridge (installEditorBusCompat).
//
// Covers:
//   1. TypedEmitter core: on/emit, multiple listeners, void events, unsubscribe,
//      disposal idempotency, emit-with-no-listeners (no-throw).
//   2. editorBus singleton: all EditorBusEvents channels fire correctly.
//   3. installEditorBusCompat: bus events re-emitted as window.postMessage with
//      the correct legacy type/payload shape; disposer removes all listeners.

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { editorBus } from '../io/editor-bus';
import type { EditorBusEvents } from '../io/editor-bus';
import { installEditorBusCompat } from '../io/editor-bus-compat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all calls to a typed bus event. Returns [payloads[], disposer]. */
function collect<K extends keyof EditorBusEvents>(event: K) {
  const payloads: EditorBusEvents[K][] = [];
  const off = editorBus.on(event, ((p: EditorBusEvents[K]) => { payloads.push(p); }) as never);
  return [payloads, off] as const;
}

// ---------------------------------------------------------------------------
// 1. TypedEmitter core behaviour
// ---------------------------------------------------------------------------

describe('TypedEmitter (via editorBus)', () => {
  it('delivers payload to a registered listener', () => {
    const [payloads, off] = collect('focusPanel');
    editorBus.emit('focusPanel', { panel: 'mesh' });
    expect(payloads).toEqual([{ panel: 'mesh' }]);
    off();
  });

  it('delivers to multiple listeners on the same event', () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = editorBus.on('focusPanel', (p) => a.push(p.panel));
    const offB = editorBus.on('focusPanel', (p) => b.push(p.panel));
    editorBus.emit('focusPanel', { panel: 'timeline' });
    expect(a).toEqual(['timeline']);
    expect(b).toEqual(['timeline']);
    offA(); offB();
  });

  it('does not deliver after unsubscribe', () => {
    const [payloads, off] = collect('focusPanel');
    off();
    editorBus.emit('focusPanel', { panel: 'mesh' });
    expect(payloads).toHaveLength(0);
  });

  it('double-dispose is safe (no throw)', () => {
    const [, off] = collect('focusPanel');
    off();
    expect(() => off()).not.toThrow();
  });

  it('emitting with no listeners does not throw', () => {
    expect(() => editorBus.emit('focusPanel', { panel: 'x' })).not.toThrow();
  });

  it('handles void-payload events (dragAssetEnd)', () => {
    let called = false;
    const off = editorBus.on('dragAssetEnd', () => { called = true; });
    editorBus.emit('dragAssetEnd');
    expect(called).toBe(true);
    off();
  });

  it('isolates different event channels', () => {
    const focus: unknown[] = [];
    const open: unknown[] = [];
    const offF = editorBus.on('focusPanel', (p) => focus.push(p));
    const offO = editorBus.on('openSource', (p) => open.push(p));
    editorBus.emit('focusPanel', { panel: 'mesh' });
    expect(focus).toHaveLength(1);
    expect(open).toHaveLength(0);
    offF(); offO();
  });

  it('delivers multiple sequential emits', () => {
    const [payloads, off] = collect('focusPanel');
    editorBus.emit('focusPanel', { panel: 'a' });
    editorBus.emit('focusPanel', { panel: 'b' });
    editorBus.emit('focusPanel', { panel: 'c' });
    expect(payloads).toEqual([{ panel: 'a' }, { panel: 'b' }, { panel: 'c' }]);
    off();
  });
});

// ---------------------------------------------------------------------------
// 2. editorBus — all event channels
// ---------------------------------------------------------------------------

describe('editorBus event channels', () => {
  it('dragAssetStart delivers DragAssetRef', () => {
    const ref = { type: 'asset' as const, guid: 'g1', kind: 'mesh', name: 'Cube', path: '/assets/cube.glb' };
    const [payloads, off] = collect('dragAssetStart');
    editorBus.emit('dragAssetStart', ref);
    expect(payloads[0]).toEqual(ref);
    off();
  });

  it('addAssetToScene delivers DragAssetRef', () => {
    const ref = { type: 'asset' as const, guid: 'g2', kind: 'scene', name: 'Level' };
    const [payloads, off] = collect('addAssetToScene');
    editorBus.emit('addAssetToScene', ref);
    expect(payloads[0]).toEqual(ref);
    off();
  });

  it('editorRef delivers entity payload', () => {
    const payload = { kind: 'entity' as const, id: 42, name: 'Player', components: ['Transform', 'MeshFilter'] };
    const [payloads, off] = collect('editorRef');
    editorBus.emit('editorRef', payload);
    expect(payloads[0]).toEqual(payload);
    off();
  });

  it('editorRef delivers component payload', () => {
    const payload = { kind: 'component' as const, entityId: 7, entityName: 'Light', comp: 'PointLight', value: { intensity: 2 } };
    const [payloads, off] = collect('editorRef');
    editorBus.emit('editorRef', payload);
    expect(payloads[0]).toEqual(payload);
    off();
  });

  it('editorRef delivers asset payload', () => {
    const payload = { kind: 'asset' as const, guid: 'mat-001', assetKind: 'material', name: 'Wood', packPath: '/assets' };
    const [payloads, off] = collect('editorRef');
    editorBus.emit('editorRef', payload);
    expect(payloads[0]).toEqual(payload);
    off();
  });

  it('addAssetToChat delivers AssetChatRef[]', () => {
    const refs = [
      { type: 'asset' as const, guid: 'a1', kind: 'texture', name: 'Brick', path: '/tex/brick.png' },
      { type: 'folder' as const, name: 'Models', path: '/models' },
    ];
    const [payloads, off] = collect('addAssetToChat');
    editorBus.emit('addAssetToChat', refs);
    expect(payloads[0]).toHaveLength(2);
    expect(payloads[0]![0]!.name).toBe('Brick');
    expect(payloads[0]![1]!.type).toBe('folder');
    off();
  });

  it('openSource delivers plugin + docId', () => {
    const [payloads, off] = collect('openSource');
    editorBus.emit('openSource', { plugin: 'material-editor', docId: 'doc-99' });
    expect(payloads[0]).toEqual({ plugin: 'material-editor', docId: 'doc-99' });
    off();
  });
});

// ---------------------------------------------------------------------------
// 3. installEditorBusCompat — bus→postMessage bridge
// ---------------------------------------------------------------------------

// bun test runs outside a browser — polyfill `window` + `postMessage` so the
// compat bridge can be exercised without a DOM.
const posted: { type: string; [k: string]: unknown }[] = [];
if (typeof globalThis.window === 'undefined') {
  (globalThis as Record<string, unknown>).window = globalThis;
}

describe('installEditorBusCompat', () => {
  let dispose: () => void;
  let origPostMessage: typeof globalThis.postMessage | undefined;

  beforeEach(() => {
    posted.length = 0;
    origPostMessage = globalThis.postMessage;
    globalThis.postMessage = ((data: unknown) => { posted.push(data as never); }) as never;
    dispose = installEditorBusCompat();
  });

  afterEach(() => {
    dispose();
    if (origPostMessage) globalThis.postMessage = origPostMessage;
  });

  it('bridges editorRef → VAG_EDITOR_REF postMessage', () => {
    const payload = { kind: 'entity' as const, id: 1, name: 'E', components: ['T'] };
    editorBus.emit('editorRef', payload);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('VAG_EDITOR_REF');
    expect(posted[0]!.payload).toEqual(payload);
  });

  it('bridges addAssetToChat → FORGEAX_ADD_ASSET_TO_CHAT postMessage', () => {
    const refs = [{ type: 'asset' as const, name: 'X', path: '/x', guid: 'g' }];
    editorBus.emit('addAssetToChat', refs);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('FORGEAX_ADD_ASSET_TO_CHAT');
    expect(posted[0]!.refs).toEqual(refs);
  });

  it('bridges focusPanel → FORGEAX_FOCUS_PANEL postMessage', () => {
    editorBus.emit('focusPanel', { panel: 'mesh' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('FORGEAX_FOCUS_PANEL');
    expect(posted[0]!.panel).toBe('mesh');
  });

  it('bridges openSource → VAG_EDITOR_OPEN_SOURCE postMessage', () => {
    editorBus.emit('openSource', { plugin: 'p', docId: 'd' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe('VAG_EDITOR_OPEN_SOURCE');
    expect(posted[0]!.payload).toEqual({ plugin: 'p', docId: 'd' });
  });

  it('does not bridge dragAssetStart/End (no postMessage for drag events)', () => {
    editorBus.emit('dragAssetStart', { type: 'asset', guid: 'g', kind: 'mesh' });
    editorBus.emit('dragAssetEnd');
    expect(posted).toHaveLength(0);
  });

  it('dispose stops all bridges', () => {
    dispose();
    editorBus.emit('editorRef', { kind: 'entity' as const, id: 1, name: 'E', components: [] });
    editorBus.emit('focusPanel', { panel: 'mesh' });
    expect(posted).toHaveLength(0);
  });
});
