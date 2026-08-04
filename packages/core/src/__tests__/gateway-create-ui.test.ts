import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { listOps } from '../io/catalog';
import { createEditSession } from '../session/document';
import { setPathResolver } from '../util/path-resolver';
import type { EditSession } from '../types';
import '../index';

beforeEach(() => setPathResolver((relativePath) => relativePath));
afterEach(() => setPathResolver(null));

describe('writeUi Gateway contract', () => {
  it('is discoverable and declares the asset visibility barrier', () => {
    const op = listOps().find((candidate) => candidate.id === 'writeUi');
    expect(op).toMatchObject({
      domain: 'document',
      completion: { kind: 'asset-visible', guidField: 'guid' },
      argsSchema: { required: ['guid', 'name', 'html', 'css'] },
    });
  });

  it('rejects malformed authoring input through a structured error', () => {
    const session: EditSession = createEditSession();
    session.world = {} as never;
    const gateway = new EditGateway(session);
    const result = gateway.dispatch({
      kind: 'writeUi', guid: 'ui-guid', name: 'Broken', html: '<div><span></div>', css: '',
      sourcePath: 'src/ui/hud.html',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGS');
      expect(result.error.hint).toContain('src/ui/hud.html:1:');
    }
  });

  it('writes a validated UiAsset payload through the asset gate', async () => {
    const { applyWriteUi } = await import('../session/pack-ops');
    let captured: unknown;
    const result = applyWriteUi({
      assetIO: {
        upsertAssetInPack(input: unknown) {
          captured = input;
          return Promise.resolve({ ok: true, previous: null });
        },
      },
    } as never, {
      kind: 'writeUi', guid: 'ui-guid', name: '2048 HUD',
      html: '<main data-ui-part="root"><span data-score>0</span></main>',
      css: ':host{display:block} main{color:white}',
      packPath: 'assets/ui.pack.json',
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual({
      packPath: 'assets/ui.pack.json',
      asset: {
        guid: 'ui-guid', kind: 'ui', name: '2048 HUD', refs: [],
        payload: {
          guid: 'ui-guid',
          html: '<main data-ui-part="root"><span data-score>0</span></main>',
          css: ':host{display:block} main{color:white}',
        },
      },
    });
  });

  it('replaces an existing UiAsset and preserves it as the undo inverse', async () => {
    const { applyWriteUi } = await import('../session/pack-ops');
    const previous = {
      guid: 'ui-guid', kind: 'ui', name: 'Old HUD', refs: [],
      payload: { guid: 'ui-guid', html: '<main>old</main>', css: 'main{color:red}' },
    };
    let written: unknown;
    const result = applyWriteUi({
      assetIO: {
        upsertAssetInPack(input: { asset: unknown }) {
          written = input.asset;
          return Promise.resolve({ ok: true, previous });
        },
      },
    } as never, {
      kind: 'writeUi', guid: 'ui-guid', name: 'New HUD',
      html: '<main>new</main>', css: 'main{color:blue}',
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.hint);
    expect(written).toMatchObject({
      guid: 'ui-guid', name: 'New HUD', payload: { html: '<main>new</main>', css: 'main{color:blue}' },
    });
    expect(result.inverse).toMatchObject({
      kind: 'restoreWrittenAsset', guid: 'ui-guid',
    });
  });
});
