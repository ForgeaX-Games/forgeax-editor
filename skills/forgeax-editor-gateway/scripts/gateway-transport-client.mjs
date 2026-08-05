// Product-neutral typed-transport client for projected Gateway operations.
//
// This module owns the discover -> resolve -> run.dispatch protocol shared by
// product compositions such as forgeax-build-game. It deliberately does not own
// HTTP, scope selection, or output formatting; callers inject those concerns.

export class GatewayTransportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'GatewayTransportError';
    this.code = code;
    this.details = details;
  }
}

export function createGatewayTransportClient(options) {
  const actor = options.actor ?? { id: 'forgeax-editor-gateway-cli', kind: 'ai' };
  const sessionId = options.sessionId ?? `forgeax-editor-gateway-cli:${options.scope}`;
  const makeIdempotencyKey = options.makeIdempotencyKey
    ?? ((operation) => `gateway.${operation}:${options.scope}:${Date.now()}`);

  async function discover() {
    const response = await options.request('discover', {});
    const result = unwrapResponse(response, 'discover');
    const manifest = isRecord(result) && isRecord(result.capabilityManifest)
      ? result.capabilityManifest
      : undefined;
    if (!Array.isArray(manifest?.capabilities)) {
      throw new GatewayTransportError(
        'INVALID_DISCOVERY',
        'Gateway discovery did not publish a capability manifest.',
        { response },
      );
    }
    return { result, capabilities: manifest.capabilities };
  }

  async function list() {
    const found = await discover();
    return {
      scope: options.scope,
      capabilities: found.capabilities.map(projectGatewayCapability),
    };
  }

  async function describe(operation) {
    const found = await discover();
    const capability = resolveGatewayCapability(found.capabilities, operation);
    if (capability === undefined) {
      throw new GatewayTransportError(
        'OPERATION_NOT_REGISTERED',
        `Gateway operation '${operation}' is not registered.`,
        { operation, scope: options.scope },
      );
    }
    return { scope: options.scope, capability: projectGatewayCapability(capability) };
  }

  async function dispatch(operation, input = {}, dispatchOptions = {}) {
    const found = await discover();
    const capability = resolveGatewayCapability(found.capabilities, operation);
    if (capability === undefined) {
      throw new GatewayTransportError(
        'OPERATION_NOT_REGISTERED',
        `Gateway operation '${operation}' is not registered.`,
        { operation, scope: options.scope },
      );
    }
    let response = await options.request('run.dispatch', {
      operationId: capability.id,
      input,
      scope: options.scope,
      actor,
      sessionId,
      permission: 'execute',
      idempotencyKey: dispatchOptions.idempotencyKey ?? makeIdempotencyKey(operation),
    });
    let result = unwrapResponse(response, 'run.dispatch');
    // A fresh execution failure is a transport error and unwrapResponse throws it.
    // A terminal failed result can therefore only be an idempotently reused run
    // whose external precondition may have been repaired since the first attempt.
    if (isRecord(result) && result.status === 'failed' && result.retryable === true) {
      const runId = typeof result.runId === 'string'
        ? result.runId
        : isRecord(response) && typeof response.runId === 'string' ? response.runId : undefined;
      if (runId !== undefined) {
        response = await options.request('run.retry', { runId });
        result = unwrapResponse(response, 'run.retry');
      }
    }
    if (!isRecord(result) || result.status !== 'succeeded') {
      throw new GatewayTransportError(
        'RUN_NOT_SUCCEEDED',
        `Gateway operation '${operation}' did not reach terminal succeeded status.`,
        { operation, scope: options.scope, response },
      );
    }
    return response;
  }

  async function query(input = {}) {
    const response = await options.request('query', { input });
    return unwrapResponse(response, 'query');
  }

  async function evaluate(code, evaluateOptions = {}) {
    const response = await options.request('script.execute', {
      code,
      scope: options.scope,
      actor,
      sessionId,
      permission: 'execute',
      idempotencyKey: evaluateOptions.idempotencyKey ?? makeIdempotencyKey('script.execute'),
    });
    const result = unwrapResponse(response, 'script.execute');
    if (!isRecord(result) || result.status !== 'succeeded') {
      throw new GatewayTransportError(
        'RUN_NOT_SUCCEEDED',
        'Gateway script did not reach terminal succeeded status.',
        { scope: options.scope, response },
      );
    }
    return response;
  }

  async function gameplay(input) {
    const response = await options.request('gameplay', input);
    return unwrapResponse(response, 'gameplay');
  }

  return Object.freeze({ discover, list, describe, dispatch, query, evaluate, gameplay });
}

export function resolveGatewayCapability(capabilities, operation) {
  return capabilities.find((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return false;
    return entry.id === operation
      || entry.id === `editor.${operation}`
      || entry.verb === operation;
  });
}

function projectGatewayCapability(value) {
  if (!isRecord(value)) return value;
  const operation = typeof value.verb === 'string'
    ? value.verb
    : typeof value.id === 'string' && value.id.startsWith('editor.')
      ? value.id.slice('editor.'.length)
      : value.id;
  return { ...value, operation };
}

function unwrapResponse(response, method) {
  if (!isRecord(response)) {
    throw new GatewayTransportError('INVALID_RESPONSE', `${method} returned a non-object response.`, { response });
  }
  if (isRecord(response.error)) {
    throw new GatewayTransportError('TRANSPORT_REJECTED', `Editor Gateway transport rejected ${method}.`, { response });
  }
  if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
    throw new GatewayTransportError('INVALID_RESPONSE', `${method} returned neither result nor error.`, { response });
  }
  return response.result;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
