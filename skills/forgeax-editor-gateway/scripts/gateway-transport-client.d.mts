export interface GatewayTransportResponse {
  readonly result?: unknown;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface GatewayTransportClientOptions {
  readonly scope: string;
  readonly request: (method: string, params: Record<string, unknown>) => Promise<GatewayTransportResponse>;
  readonly actor?: { readonly id: string; readonly kind: 'human' | 'ai' | 'service' };
  readonly sessionId?: string;
  readonly makeIdempotencyKey?: (operation: string) => string;
}

export class GatewayTransportError extends Error {
  readonly code: string;
  readonly details?: unknown;
}

export function createGatewayTransportClient(options: GatewayTransportClientOptions): Readonly<{
  discover(): Promise<{ readonly result: unknown; readonly capabilities: readonly unknown[] }>;
  list(): Promise<Record<string, unknown>>;
  describe(operation: string): Promise<Record<string, unknown>>;
  dispatch(operation: string, input?: unknown, options?: { readonly idempotencyKey?: string }): Promise<GatewayTransportResponse>;
  query(input?: unknown): Promise<Record<string, unknown>>;
  gameplay(input: unknown): Promise<Record<string, unknown>>;
}>;

export function resolveGatewayCapability(
  capabilities: readonly unknown[],
  operation: string,
): Record<string, unknown> | undefined;
