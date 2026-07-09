import { afterEach, describe, expect, it } from 'bun:test';
import { handleCrossInstanceDrop } from './crossInstanceDrop';
import { registerDockviewApi } from './dockviewRegistry';

function mkApi(id: string) {
  const closed: string[] = [];
  const added: Array<{ id: string; component: string; title?: string }> = [];
  const api = {
    id,
    getPanel: (pid: string) => ({ api: { close() { closed.push(pid); } } }),
    addPanel: (opts: { id: string; component: string; title?: string }) => added.push(opts),
  };
  return { api, closed, added };
}

describe('handleCrossInstanceDrop', () => {
  const unregisters: Array<() => void> = [];
  afterEach(() => { while (unregisters.length) unregisters.pop()!(); });

  it('is a no-op when transfer.viewId === target.api.id (same-instance)', () => {
    const target = mkApi('target');
    const moves: Array<[string, string]> = [];
    handleCrossInstanceDrop(
      { api: target.api, getData: () => ({ viewId: 'target', panelId: 'chat' }) },
      'AuxBar',
      (id, r) => moves.push([id, r]),
    );
    expect(moves).toEqual([]);
    expect(target.added).toEqual([]);
  });

  it('closes source panel + adds to target + calls moveTo on cross-instance drop', () => {
    const source = mkApi('source-vid');
    const target = mkApi('target-vid');
    unregisters.push(registerDockviewApi(source.api));
    const moves: Array<[string, string]> = [];
    handleCrossInstanceDrop(
      { api: target.api, getData: () => ({ viewId: 'source-vid', panelId: 'chat' }) },
      'AuxBar',
      (id, r) => moves.push([id, r]),
    );
    expect(source.closed).toEqual(['chat']);
    expect(target.added).toEqual([{ id: 'chat', component: 'chat', title: undefined }]);
    expect(moves).toEqual([['chat', 'AuxBar']]);
  });

  it('tolerates a missing source api (registry lookup returns undefined)', () => {
    const target = mkApi('target-vid');
    const moves: Array<[string, string]> = [];
    handleCrossInstanceDrop(
      { api: target.api, getData: () => ({ viewId: 'unknown', panelId: 'chat' }) },
      'AuxBar',
      (id, r) => moves.push([id, r]),
    );
    // Still adds to target and calls moveTo even without a source api.
    expect(target.added.length).toBe(1);
    expect(moves).toEqual([['chat', 'AuxBar']]);
  });

  it('does nothing when transfer.panelId is null', () => {
    const target = mkApi('target');
    const moves: Array<[string, string]> = [];
    handleCrossInstanceDrop(
      { api: target.api, getData: () => ({ viewId: 'source', panelId: null }) },
      'AuxBar',
      (id, r) => moves.push([id, r]),
    );
    expect(moves).toEqual([]);
    expect(target.added).toEqual([]);
  });
});
