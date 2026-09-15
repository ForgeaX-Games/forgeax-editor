import { expect, test } from 'bun:test';
import { createDisposablePlayCarrier } from '../disposable-play-carrier';
import { loadRuntimeBinding } from '../../../../play-runtime/src/runtime-binding-loader';

test('a known pack failure reaches the pending Play result before timeout; stopped frames cannot report late', async () => {
  const source = {} as WindowProxy;
  const listeners = new Set<(event: MessageEvent) => void>();
  const forwarded: unknown[] = [];
  let restored = 0;
  const carrier = createDisposablePlayCarrier({
    container: {} as HTMLElement,
    url: () => '/preview/?runtimeId=runtime&runtimeGeneration=4&carrierId=child&carrierKind=iframe',
    releaseEditSurface: async () => ({ ok: true }),
    restoreEditSurface: async () => { restored++; return { ok: true }; },
    onCarrierEvent: event => forwarded.push(event),
    readyTimeoutMs: 1000,
    host: {
      create: generation => ({ generation, source, element: {} as HTMLIFrameElement }),
      mount: () => {}, remove: () => {},
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
  });
  const start = carrier.start('request');
  await Promise.resolve();
  const error = await loadRuntimeBinding('binding', async () => Response.json({
    gameId: 'kart', scopeId: 'scope', generation: 4, status: 'unavailable',
    diagnostic: { code: 'scan-failed', cause: [{ code: 'pack-source-external-closure-mismatch', detail: { sourcePath: './assets/scene.pack.ts', undeclaredReferencedGuids: ['guid'], undeclaredReadGuids: ['read-guid'], expected: 'declare referenced assets', missingGuids: ['missing'], sourceKey: 'scene/main' } }] },
  }, { status: 503 }), { expected: { gameId: 'kart', scopeId: 'scope', generation: 4 } }).catch(error => error);
  const message = { type: 'VAG_CARRIER_FAILURE', payload: {
    version: 1, runtimeId: 'runtime', runtimeGeneration: 4, carrierId: 'child', carrierKind: 'iframe',
    challengeResponse: null, scope: { projectId: '/project', gameId: 'kart' },
    pageNonce: 'nonce', pageIdentity: '/preview/', canvasIdentity: 'canvas', rendererGeneration: null,
    rendererIdentity: 'pending', sentinel: 0, liveness: 'alive', renderReadiness: 'unavailable',
    failure: { code: error.code, hint: error.message, retryable: false, stage: 'handshake', at: new Date().toISOString(), diagnostics: error.diagnostics },
  } };
  for (const listener of [...listeners]) listener({ source, data: message } as MessageEvent);
  const result = await start;
  expect(result).toMatchObject({ ok: false, error: { code: 'pack-source-external-closure-mismatch', carrierFailure: { payload: { failure: { diagnostics: error.diagnostics } } } } });
  expect(forwarded).toHaveLength(1);
  expect(restored).toBe(1);
  expect(carrier.state()).toBe('edit');
  const next = carrier.start('next'); await Promise.resolve(); await carrier.stop();
  expect(await next).toMatchObject({ ok: false });
  for (const listener of [...listeners]) listener({ source, data: message } as MessageEvent);
  expect(forwarded).toHaveLength(1);
});
