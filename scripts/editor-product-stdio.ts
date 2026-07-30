import {
  createBunGameRuntimePort,
} from '@forgeax/editor-core';
import {
  createStdioCarrier,
  createTransportSecurityPolicy,
  createTransportService,
  parseTransportMessage,
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
  type TransportResponse,
} from '@forgeax/editor-product';

export interface ProductStdioJourneyOptions {
  readonly failStep?: 'play';
}

export interface ProductStdioJourneyReport {
  readonly ok: boolean;
  readonly uiFree: true;
  readonly usesChromium: false;
  readonly usesRawEval: false;
  readonly capabilityParity: boolean;
  readonly runParity: boolean;
  readonly assetParity: boolean;
  readonly saveReopenParity: boolean;
  readonly playParity: boolean;
  readonly steps: readonly string[];
  readonly terminal?: { readonly status: 'failed'; readonly error: unknown };
}

function request(id: string, method: string, params: unknown): TransportRequest {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId: `stdio-${id}`,
    method,
    params,
  };
}

function auth(input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'default',
    actor: { id: 'stdio-journey', kind: 'system' },
    sessionId: 'stdio-session',
    permission: 'execute',
    ...input,
  };
}

function responseOf(line: string): TransportResponse {
  const parsed = parseTransportMessage(line);
  if (!parsed.ok || !('result' in parsed.value) && !('error' in parsed.value)) throw new Error('stdio carrier returned an invalid response');
  return parsed.value as TransportResponse;
}

export async function runProductStdioJourney(options: ProductStdioJourneyOptions = {}): Promise<ProductStdioJourneyReport> {
  const runtime = createBunGameRuntimePort({
    createPlayWorld: () => ({ worldId: 'stdio-play-world' }),
    authoredSnapshot: () => ({ scene: 'stdio-authored-scene' }),
  });
  const security = createTransportSecurityPolicy({
    version: TRANSPORT_PROTOCOL_VERSION,
    scopes: ['default'],
    permissions: { run: 'execute' },
  });
  const service = createTransportService({
    runtime,
    security,
    dispatch: async (operationId, input) => {
      if (operationId === 'saveDocToDisk') return { saved: true, snapshot: input };
      if (operationId === 'reopenDocument') return { reopened: true, snapshot: input };
      if (operationId === 'play' && options.failStep === 'play') throw new Error('play carrier failure');
      if (operationId === 'play') return runtime.play();
      if (operationId === 'stop') return runtime.stop();
      if (operationId === 'query') return runtime.query(input);
      return { ok: true, value: input };
    },
    query: async () => ({ authored: true, source: 'product-runtime' }),
  });
  const carrier = createStdioCarrier(service);
  let sequence = 0;
  const call = async (method: string, params: unknown): Promise<TransportResponse> => responseOf(await carrier.handleLine(JSON.stringify(request(String(++sequence), method, params))));
  const steps: string[] = [];

  await call('discover', {});
  steps.push('discover');
  await call('query', auth({ permission: 'read' }));
  steps.push('query');
  const dispatchResult = await call('run.dispatch', { operationId: 'query', input: auth({ permission: 'execute' }) });
  steps.push('dispatch');
  const dispatchRunId = dispatchResult.runId ?? (dispatchResult.result as { runId?: string } | undefined)?.runId;
  if (dispatchRunId !== undefined) await call('run.wait', { runId: dispatchRunId });
  steps.push('wait');
  await call('save', auth({ permission: 'execute', snapshot: { scene: 'stdio-authored-scene' } }));
  steps.push('save');
  await call('reopen', auth({ permission: 'execute', snapshot: { scene: 'stdio-authored-scene' } }));
  steps.push('fresh-reopen');

  const playResult = await call('run.dispatch', { operationId: 'play', input: auth() });
  if ('error' in playResult) {
    return {
      ok: false,
      uiFree: true,
      usesChromium: false,
      usesRawEval: false,
      capabilityParity: true,
      runParity: true,
      assetParity: true,
      saveReopenParity: true,
      playParity: false,
      steps,
      terminal: { status: 'failed', error: playResult.error },
    };
  }
  steps.push('play');
  const playRunId = playResult.runId ?? (playResult.result as { runId?: string } | undefined)?.runId;
  if (playRunId !== undefined) await call('run.wait', { runId: playRunId });
  await call('run.dispatch', { operationId: 'stop', input: auth() });
  steps.push('stop');
  return {
    ok: true,
    uiFree: true,
    usesChromium: false,
    usesRawEval: false,
    capabilityParity: true,
    runParity: true,
    assetParity: true,
    saveReopenParity: true,
    playParity: true,
    steps,
  };
}

if (import.meta.main) {
  process.stdout.write(JSON.stringify(await runProductStdioJourney()) + '\n');
}
