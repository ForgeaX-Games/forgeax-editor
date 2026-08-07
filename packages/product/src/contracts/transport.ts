import type { CommandError } from './error';

export const TRANSPORT_PROTOCOL_VERSION = 'editor-transport/v1' as const;

export interface TransportActor {
  readonly id: string;
  readonly kind: 'human' | 'ai' | 'system' | (string & {});
}

export interface TransportRequest {
  readonly jsonrpc: '2.0';
  readonly version: typeof TRANSPORT_PROTOCOL_VERSION;
  readonly id: string;
  readonly correlationId: string;
  /** Carrier routing identity; method params must not be inspected to choose a page. */
  readonly scope: string;
  /** Carrier deadline metadata; bounded by the server and ignored by the Editor service. */
  readonly timeoutMs?: number;
  readonly method: string;
  readonly params: unknown;
}

export interface TransportResponse {
  readonly jsonrpc: '2.0';
  readonly version: typeof TRANSPORT_PROTOCOL_VERSION;
  readonly id: string;
  readonly correlationId: string;
  readonly runId?: string;
  readonly result?: unknown;
  readonly error?: TransportError;
}

export interface TransportError extends CommandError {
  readonly outcome?: 'unknown';
  readonly operationMayStillBeRunning?: boolean;
  readonly compatibility?: { readonly supportedVersions: readonly string[] };
  readonly authorization?: { readonly requiredPermission: string; readonly actorId?: string };
  readonly scope?: { readonly requested: string; readonly allowed: readonly string[] };
}

export interface TransportEventCursor {
  readonly runId: string;
  readonly snapshotRevision: string;
  readonly sequence: number;
}

export interface TransportPage<T> {
  readonly ok: true;
  readonly items: readonly T[];
  readonly snapshotRevision: string;
  readonly nextCursor?: string;
}

export interface TransportPageError {
  readonly ok: false;
  readonly items: readonly [];
  readonly snapshotRevision: string;
  readonly nextCursor?: undefined;
  readonly error: CommandError;
}

export type TransportPageResult<T> = TransportPage<T> | TransportPageError;
