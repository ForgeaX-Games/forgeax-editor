import { describe, expect, test } from 'bun:test';
import { TRANSPORT_PROTOCOL_VERSION, type TransportRequest } from '../../contracts/transport';
import { createTransportService } from '../service';
import {
  MessagePortTransportError,
  createMessagePortCarrier,
  createMessagePortTransportClient,
} from '../message-port-carrier';

function request(id: string, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    jsonrpc: '2.0',
    version: TRANSPORT_PROTOCOL_VERSION,
    id,
    correlationId: `correlation-${id}`,
    scope: 'default',
    method: 'transport.describe',
    params: {},
    ...overrides,
  };
}

describe('MessagePort product transport', () => {
  test('serves the canonical typed transport over a transferred port', async () => {
    const channel = new MessageChannel();
    const carrier = createMessagePortCarrier(channel.port1, createTransportService());
    const client = createMessagePortTransportClient(channel.port2);

    const response = await client.request(request('describe-1'));

    expect(response.id).toBe('describe-1');
    expect(response.correlationId).toBe('correlation-describe-1');
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ protocolVersion: TRANSPORT_PROTOCOL_VERSION });

    client.dispose();
    carrier.dispose();
  });

  test('rejects duplicate in-flight ids instead of cross-wiring responses', async () => {
    const channel = new MessageChannel();
    const client = createMessagePortTransportClient(channel.port1, { defaultTimeoutMs: 20 });
    const first = client.request(request('same-id'));

    await expect(client.request(request('same-id', { correlationId: 'other-correlation' })))
      .rejects.toMatchObject({ code: 'transport-port-duplicate-request' });
    await expect(first).rejects.toMatchObject({ code: 'transport-port-timeout' });

    client.dispose();
    channel.port2.close();
  });

  test('rejects every pending request when the runtime generation disconnects', async () => {
    const channel = new MessageChannel();
    const client = createMessagePortTransportClient(channel.port1);
    const pending = client.request(request('disconnect-1'));

    client.dispose();

    await expect(pending).rejects.toMatchObject({
      code: 'transport-port-disposed',
      retryable: true,
      recoveryActions: ['transport.reconnect', 'transport.describe'],
    });
    channel.port2.close();
  });

  test('rejects a response with the wrong correlation id', async () => {
    const channel = new MessageChannel();
    const client = createMessagePortTransportClient(channel.port1);
    channel.port2.addEventListener('message', (event) => {
      const sent = event.data as TransportRequest;
      channel.port2.postMessage({
        jsonrpc: '2.0',
        version: TRANSPORT_PROTOCOL_VERSION,
        id: sent.id,
        correlationId: 'wrong-correlation',
        result: {},
      });
    });
    channel.port2.start();

    const response = client.request(request('mismatch-1'));

    await expect(response).rejects.toBeInstanceOf(MessagePortTransportError);
    await expect(response).rejects.toMatchObject({ code: 'transport-port-correlation-mismatch' });

    client.dispose();
    channel.port2.close();
  });

  test('reports malformed inbound values without invoking the service', async () => {
    const channel = new MessageChannel();
    let rejected: unknown;
    const carrier = createMessagePortCarrier(channel.port1, createTransportService(), {
      onReject: (value) => { rejected = value; },
    });

    channel.port2.postMessage({ version: 'not-the-editor-protocol' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rejected).toMatchObject({ error: { code: 'protocol-invalid-message' } });

    channel.port2.close();
    carrier.dispose();
  });
});
