// assets-error-bus.test.ts — broadcastAssetsError() helper contract.
//
// See:
//   store/assets-error-bus.ts
//   io/panel-bridge.ts PanelBridgeEvents.assetsError
//   feedbacks/2026-07-23-assets-create-folder-name-validation-illegal-chars.dev-plan.md §5 step 3

import { describe, expect, it } from 'bun:test';
import { panelBridge } from '../io/panel-bridge';
import { broadcastAssetsError } from '../store/assets-error-bus';

describe('broadcastAssetsError', () => {
  it('emits an assetsError event with op/path/hint and an auto-stamped ts', () => {
    const captured: Array<{ op: string; path?: string; hint: string; ts: number }> = [];
    const off = panelBridge.on('assetsError', (p) => captured.push(p));

    const before = Date.now();
    broadcastAssetsError({ op: 'createDirectory', path: 'assets/foo', hint: 'disk full' });
    const after = Date.now();

    off();
    expect(captured.length).toBe(1);
    expect(captured[0]!.op).toBe('createDirectory');
    expect(captured[0]!.path).toBe('assets/foo');
    expect(captured[0]!.hint).toBe('disk full');
    // ts is a wall-clock stamp for chronological ordering; check it falls
    // within the observed window (allows for clock resolution nudges).
    expect(captured[0]!.ts).toBeGreaterThanOrEqual(before);
    expect(captured[0]!.ts).toBeLessThanOrEqual(after);
  });

  it('accepts an omitted path (some ops only carry op-kind + hint)', () => {
    const captured: Array<{ op: string; path?: string; hint: string }> = [];
    const off = panelBridge.on('assetsError', ({ op, path, hint }) => captured.push({ op, path, hint }));

    broadcastAssetsError({ op: 'refreshCatalog', hint: 'bootstrap fetch failed' });

    off();
    expect(captured).toEqual([{ op: 'refreshCatalog', hint: 'bootstrap fetch failed' }]);
    // path is truly undefined (NOT null / '') so subscribers can use `path ?? '(no path)'`.
    expect(captured[0]!.path).toBeUndefined();
  });

  it('multiple subscribers all receive the same event', () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = panelBridge.on('assetsError', ({ hint }) => a.push(hint));
    const offB = panelBridge.on('assetsError', ({ hint }) => b.push(hint));

    broadcastAssetsError({ op: 'renameDirectory', hint: 'boom' });

    offA();
    offB();
    expect(a).toEqual(['boom']);
    expect(b).toEqual(['boom']);
  });

  it('disposer stops delivery (no zombie listeners across panel remount)', () => {
    const events: string[] = [];
    const off = panelBridge.on('assetsError', ({ hint }) => events.push(hint));
    broadcastAssetsError({ op: 'x', hint: 'first' });
    off();
    broadcastAssetsError({ op: 'x', hint: 'second' });
    expect(events).toEqual(['first']);
  });
});
