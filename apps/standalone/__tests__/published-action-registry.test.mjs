import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { dispatchAction, registerAction } from '@forgeax/app-shell/application';
import { actionIntentPill } from '@forgeax/interface/lib/ai-intents';

describe('standalone Editor and Interface action registry identity', () => {
  test('resolves the same installed App Shell entry from the host and Interface', () => {
    // Published entries are import-only; use the same conditions as this ESM test.
    const productEntry = Bun.resolveSync('@forgeax/interface/application', import.meta.dir);
    const hostEntry = Bun.resolveSync('@forgeax/app-shell/application', import.meta.dir);
    const productRegistry = Bun.resolveSync('@forgeax/app-shell/application', dirname(productEntry));
    expect(realpathSync(productRegistry)).toBe(realpathSync(hostEntry));
  });

  test('Interface discovery sees host registration, dispatch, and disposal', async () => {
    const id = 'editor.contract.published-action-registry';
    const title = 'Host registered action';
    const target = { closest: () => ({ dataset: { fxAction: id, fxTitle: 'DOM fallback' } }) };
    const dispose = registerAction({
      id, title, capability: 'read',
      run: () => ({ status: 'completed', stateDigest: 'published-registry' }),
    });
    try {
      // Execute a real published Interface reader, not a second registry alias.
      expect(actionIntentPill(target)?.title).toBe(title);
      expect(await dispatchAction(id)).toEqual({ status: 'completed', stateDigest: 'published-registry' });
    } finally {
      dispose();
    }
    expect(actionIntentPill(target)?.title).toBe('DOM fallback');
    expect(await dispatchAction(id)).toEqual({
      status: 'rejected', reason: `unknown action "${id}" (not in the registry)`,
    });
  });
});
