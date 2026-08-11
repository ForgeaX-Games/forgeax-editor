// Regression gate for the Studio "editor Page navigation is not configured by
// the host" red overlay (2026-08-06). Two AppHosts boot concurrently (React
// StrictMode double-effect / HMR / game switch) and their async `setup()` phases
// interleave; the discarded host could finish setup AFTER the surviving one,
// overwrite the single navigation slot, and then wipe it on teardown — leaving
// every later openAssetEditor dispatch throwing an unhandled rejection.

import { expect, test } from 'bun:test';
import {
  configureEditorPageNavigation,
  getActiveEditorAsset,
  type EditorPageNavigation,
} from '../store/page-navigation';
import type { SelectedAsset } from '../store/asset-selection';
import { applierFor } from '../io/appliers';
import type { EditorOp } from '../types';

function asset(guid: string): SelectedAsset {
  return { guid, kind: 'material-instance', name: guid, payload: {}, packPath: 'Content/Materials.pack.json' };
}

function host(id: string, opened: string[]): EditorPageNavigation {
  return {
    async openAsset(target) { opened.push(`${id}:${target.guid}`); },
    getActiveAsset: () => asset(id),
    subscribe: () => () => {},
  };
}

function openAssetEditor(target: SelectedAsset):
  | { ok: true; completion?: Promise<unknown> }
  | { ok: false; error: { code: string; hint: string } } {
  const applier = applierFor('openAssetEditor', 'session');
  if (!applier) throw new Error('openAssetEditor applier is not registered');
  return applier({ kind: 'openAssetEditor', asset: target } as unknown as EditorOp);
}

test('openAssetEditor refuses structurally when no host installed navigation', () => {
  const result = openAssetEditor(asset('mi-unhosted'));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('page-navigation-unavailable');
});

test('a stale host teardown cannot strand the surviving registration', async () => {
  const opened: string[] = [];
  // The observed Studio interleave: the surviving host registers first, the
  // discarded host registers second, then the discarded host tears down.
  const releaseLive = configureEditorPageNavigation(host('live', opened));
  const releaseStale = configureEditorPageNavigation(host('stale', opened));
  releaseStale();

  expect(getActiveEditorAsset()?.guid).toBe('live');
  const result = openAssetEditor(asset('mi-1'));
  expect(result.ok).toBe(true);
  if (result.ok) await result.completion;
  expect(opened).toEqual(['live:mi-1']);

  releaseLive();
});

test('teardown is idempotent and falls back to the previous registration', () => {
  const opened: string[] = [];
  const releaseFirst = configureEditorPageNavigation(host('first', opened));
  const releaseSecond = configureEditorPageNavigation(host('second', opened));

  expect(getActiveEditorAsset()?.guid).toBe('second');
  releaseSecond();
  releaseSecond();
  expect(getActiveEditorAsset()?.guid).toBe('first');

  releaseFirst();
  expect(getActiveEditorAsset()).toBeNull();
});

test('a registration wakes readers subscribed through the stable fan-out', () => {
  const opened: string[] = [];
  const upstream = new Set<() => void>();
  const release = configureEditorPageNavigation({
    async openAsset(target) { opened.push(`fanout:${target.guid}`); },
    getActiveAsset: () => asset('fanout'),
    subscribe: (listener) => { upstream.add(listener); return () => { upstream.delete(listener); }; },
  });

  // The seam subscribes to the host once and republishes to its own readers, so
  // host-side change notifications keep flowing no matter when readers mounted.
  expect(upstream.size).toBe(1);
  release();
  expect(upstream.size).toBe(0);
  expect(getActiveEditorAsset()).toBeNull();
});
