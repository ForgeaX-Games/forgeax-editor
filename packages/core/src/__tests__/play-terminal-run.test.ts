import { expect, test } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { registerSessionApplier } from '../io/appliers';
import { createEditSession } from '../session/document';
import { createGatewayCapabilityAdapter } from '../product/gateway-executor';
import '../index';

test('public Play waits for the real asynchronous terminal failure', async () => {
  let finish!: (value: unknown) => void;
  const completion = new Promise<unknown>((resolve) => { finish = resolve; });
  const dispose = registerSessionApplier('play', () => ({ ok: true, completion }));
  const gateway = new EditGateway(createEditSession());
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => gateway.listOps(),
    dispatch: (op, origin) => gateway.dispatch(op as Parameters<typeof gateway.dispatch>[0], origin as 'ai'),
    operationRuns: {
      get: (id) => gateway.getOperationRunResult(id),
      wait: (id) => gateway.waitOperationRun(id),
      cancel: (id) => gateway.cancelOperationRun(id),
      retry: () => { throw new Error('unused'); },
    },
  });
  try {
    let settled = false;
    const request = adapter.product().capabilityRegistry.execute('editor.play', {}, { host: 'bun' });
    void request.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish({ ok: false, error: { code: 'play-assemble-failed', hint: 'bad scene', retryable: true, recoveryActions: [] } });
    expect(await request).toMatchObject({ ok: true, result: { ok: false, error: { code: 'play-assemble-failed', hint: 'bad scene' } } });
  } finally { dispose(); }
});


test('public Play cancellation reaches the Gateway effect owner', async () => {
  let cancelled = 0;
  const dispose = registerSessionApplier('play', (_op, ctx) => {
    ctx?.operationRun?.registerCancelHandler?.(() => { cancelled++; return { ok: true }; });
    return { ok: true, completion: new Promise(() => {}) };
  });
  const gateway = new EditGateway(createEditSession());
  const adapter = createGatewayCapabilityAdapter({
    listOps: () => gateway.listOps(),
    dispatch: (op) => gateway.dispatch(op as Parameters<typeof gateway.dispatch>[0], 'ai'),
    operationRuns: {
      get: (id) => gateway.getOperationRunResult(id), wait: (id) => gateway.waitOperationRun(id),
      cancel: (id) => gateway.cancelOperationRun(id), retry: () => { throw new Error('unused'); },
    },
  });
  try {
    const controller = new AbortController();
    const request = adapter.product().capabilityRegistry.execute('editor.play', { requestId: 'abort-play' }, { host: 'bun', signal: controller.signal });
    controller.abort();
    await request;
    expect(cancelled).toBe(1);
    expect(gateway.getOperationRunResult('abort-play')).toMatchObject({ ok: true, value: { status: 'cancelled' } });
  } finally { dispose(); }
});
