import type { CommandError } from '../contracts/error';
import {
  TRANSPORT_PROTOCOL_VERSION,
  type TransportRequest,
  type TransportResponse,
} from '../contracts/transport';

export { TRANSPORT_PROTOCOL_VERSION } from '../contracts/transport';
export type { TransportRequest, TransportResponse } from '../contracts/transport';

export interface TransportSchema<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false; readonly error: { readonly issues: readonly string[] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schema<T>(parse: (value: unknown) => T | undefined, issue: string): TransportSchema<T> {
  return { safeParse(value) {
    const data = parse(value);
    return data === undefined ? { success: false, error: { issues: [issue] } } : { success: true, data };
  } };
}

function parseRequest(value: unknown): TransportRequest | undefined {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.version !== TRANSPORT_PROTOCOL_VERSION) return undefined;
  if (
    typeof value.id !== 'string'
    || typeof value.correlationId !== 'string'
    || typeof value.scope !== 'string'
    || value.scope.length === 0
    || typeof value.method !== 'string'
    || !('params' in value)
  ) return undefined;
  return value as unknown as TransportRequest;
}

function parseResponse(value: unknown): TransportResponse | undefined {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || value.version !== TRANSPORT_PROTOCOL_VERSION) return undefined;
  if (typeof value.id !== 'string' || typeof value.correlationId !== 'string') return undefined;
  const hasResult = 'result' in value;
  const hasError = 'error' in value;
  if (hasResult === hasError) return undefined;
  if (hasError && (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.hint !== 'string' || typeof value.error.retryable !== 'boolean' || !Array.isArray(value.error.recoveryActions))) return undefined;
  return value as unknown as TransportResponse;
}

export const TransportRequestSchema: TransportSchema<TransportRequest> = schema(parseRequest, 'invalid transport request');
export const TransportResponseSchema: TransportSchema<TransportResponse> = schema(parseResponse, 'invalid transport response');

export function createProtocolError(kind: 'bad-version' | 'invalid-message', hint: string): CommandError {
  return Object.freeze({
    code: kind === 'bad-version' ? 'protocol-bad-version' : 'protocol-invalid-message',
    hint,
    expected: kind === 'bad-version' ? { version: TRANSPORT_PROTOCOL_VERSION } : { jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION },
    retryable: false,
    recoveryActions: ['transport.describe'],
  });
}

export type ParsedTransportMessage =
  | { readonly ok: true; readonly value: TransportRequest | TransportResponse }
  | { readonly ok: false; readonly error: CommandError };

export function parseTransportMessage(value: unknown): ParsedTransportMessage {
  let candidate = value;
  if (typeof value === 'string') {
    try { candidate = JSON.parse(value) as unknown; } catch { return { ok: false, error: createProtocolError('invalid-message', 'transport line must contain one JSON object') }; }
  }
  const request = TransportRequestSchema.safeParse(candidate);
  if (request.success) return { ok: true, value: request.data };
  const response = TransportResponseSchema.safeParse(candidate);
  if (response.success) return { ok: true, value: response.data };
  if (isRecord(candidate) && candidate.version !== TRANSPORT_PROTOCOL_VERSION) return { ok: false, error: createProtocolError('bad-version', 'use the current transport protocol version') };
  return { ok: false, error: createProtocolError('invalid-message', 'transport message does not match the typed wire schema') };
}

export function encodeNdjson(message: TransportRequest | TransportResponse): string {
  return JSON.stringify(message) + '\n';
}

export function decodeNdjson(input: string): readonly ParsedTransportMessage[] {
  return Object.freeze(input.split(/\r?\n/).filter((line) => line.trim() !== '').map(parseTransportMessage));
}
