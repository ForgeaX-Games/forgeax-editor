import { expect, test } from 'bun:test';
import { createDisposablePlayCarrier } from '../disposable-play-carrier';
import { normalizePlayFailure, playFailureMessage } from '../play-failure-notice';
import { loadRuntimeBinding } from '../../../../play-runtime/src/runtime-binding-loader';

test.each(['closure', 'module'] as const)('a known %s failure reaches notice through the actual carrier before timeout', async (kind) => {
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
    diagnostic: { code: 'scan-failed', cause: [{ code: kind === 'module' ? 'pack-source-load-failed' : 'pack-source-external-closure-mismatch', detail: { ...(kind === 'module' ? { diagnostic: 'AssetGuidParser is not defined', phase: 'module-load' } : {}), sourcePath: './assets/scene.pack.ts', ...(kind === 'closure' ? { unusedDeclaredGuids: ['old-sphere'] } : {}), undeclaredReferencedGuids: ['guid'], undeclaredReadGuids: ['read-guid'], expected: 'declare referenced assets', missingGuids: ['missing'], sourceKey: 'scene/main' } }] },
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
  expect(result).toMatchObject({ ok: false, error: { code: kind === 'module' ? 'pack-source-load-failed' : 'pack-source-external-closure-mismatch', carrierFailure: { payload: { failure: { diagnostics: error.diagnostics } } } } });
  if (!result.ok) {
    const notice = playFailureMessage(normalizePlayFailure(result.error), 'en');
    expect(notice).toContain(kind === 'module' ? 'AssetGuidParser is not defined' : 'Unused asset declarations: old-sphere');
    expect(notice).toContain('assets/scene.pack.ts');
  }
  expect(forwarded).toHaveLength(1);
  expect(restored).toBe(1);
  expect(carrier.state()).toBe('edit');
  const next = carrier.start('next'); await Promise.resolve(); await carrier.stop();
  expect(await next).toMatchObject({ ok: false });
  for (const listener of [...listeners]) listener({ source, data: message } as MessageEvent);
  expect(forwarded).toHaveLength(1);
});
