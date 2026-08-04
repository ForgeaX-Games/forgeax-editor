import { describe, expect, it } from 'bun:test';
import {
  configureSessionClient,
  getSessionClient,
  type SessionClient,
} from './session-client';

function makeClient(): SessionClient {
  return {
    fetchSessionList: async () => [],
    createSession: async () => ({ sid: 'sess-test', bootstrappedAgent: null }),
    ensureSession: async () => ({ sid: 'sess-test', bootstrappedAgent: null, created: false }),
    deleteSession: async () => {},
    emitForgeaXMessage: async () => ({ ok: true }),
    listSessionAgents: async () => [],
    connectForgeaXWs: () => {},
    disconnectForgeaXWs: () => {},
    onSessionEvent: () => () => {},
  };
}

describe('session-client injection', () => {
  it('returns the configured chat-owned session client', () => {
    const client = makeClient();
    configureSessionClient(client);
    expect(getSessionClient()).toBe(client);
  });
});
