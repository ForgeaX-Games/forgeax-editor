export interface SessionMeta {
  sid: string;
  displayName?: string;
  defaultDir?: string;
  autoStart?: boolean;
  lastActivityAt?: number;
}

export interface ForgeaXAgentNode {
  path: string;
  display: string;
  depth: number;
  fullId: string;
  parent: string | null;
  hasLedger: boolean;
  running: boolean;
}

export interface SessionEvent {
  type: 'session-event';
  sid: string;
  emitterId?: string;
  event: {
    source: string;
    type: string;
    payload: Record<string, unknown>;
    to?: string;
    ts: number;
  };
}

export type SessionEventHandler = (event: SessionEvent) => void;

export interface SessionClient {
  fetchSessionList: (game?: string) => Promise<SessionMeta[]>;
  createSession: (opts?: {
    displayName?: string;
    defaultDir?: string;
    autoStart?: boolean;
    bootstrapAgent?: string | false | null;
  }) => Promise<{ sid: string; bootstrappedAgent: string | null }>;
  deleteSession: (sid: string) => Promise<void>;
  emitForgeaXMessage: (
    sid: string,
    content: string,
    opts?: {
      to?: string;
      type?: string;
      payload?: Record<string, unknown>;
      handoff?: 'silent' | 'passive' | 'turn' | 'innerLoop' | 'steer';
    },
  ) => Promise<{ ok: boolean; to?: string; msgId?: string; error?: string }>;
  listSessionAgents: (sid: string) => Promise<ForgeaXAgentNode[]>;
  connectForgeaXWs: (sid: string | null) => void;
  disconnectForgeaXWs: () => void;
  onSessionEvent: (key: string, handler: SessionEventHandler) => () => void;
}

let configuredClient: SessionClient | null = null;

export function configureSessionClient(client: SessionClient): void {
  configuredClient = client;
}

/** True once the composition root injected a client. Lets optional consumers
 *  (session-client plugin) degrade gracefully instead of hitting the
 *  getSessionClient() throw — interface-alone / standalone-editor hosts have
 *  no forgeax-server and never configure one. */
export function hasSessionClient(): boolean {
  return configuredClient !== null;
}

export function getSessionClient(): SessionClient {
  if (!configuredClient) {
    throw new Error('No session client configured. The Studio composition root must inject one before booting interface.');
  }
  return configuredClient;
}
