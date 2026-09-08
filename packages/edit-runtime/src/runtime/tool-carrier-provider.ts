import type {
  CarrierError,
  CarrierErrorCode,
  CarrierLease,
  CarrierLeaseRequest,
  CarrierOffer,
  CarrierPhase,
  CarrierResult,
  CarrierState,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';

/**
 * Carrier contracts are Engine-owned. These aliases keep the Editor public
 * names source-compatible while preventing a second offer/result schema from
 * growing in the UI package.
 */
export type ToolCarrierPhase = CarrierPhase;
export type ToolCarrierOffer = CarrierOffer;
export type ToolCarrierError = CarrierError;
export type ToolCarrierResult<T> = CarrierResult<T>;

export interface ToolCarrierProvider {
  readonly offer: CarrierOffer;
  readonly lease: (request: CarrierLeaseRequest) => Promise<CarrierResult<CarrierLease>>;
  readonly started: (request: { readonly leaseId: string }) => Promise<CarrierResult<CarrierState>>;
  readonly execute: (request: {
    readonly leaseId: string;
    readonly descriptorDigest: string;
    readonly recipeDigest: string;
    readonly args: unknown;
  }) => Promise<CarrierResult<ToolTerminal<unknown>>>;
  readonly exit: (request: { readonly leaseId: string }) => Promise<CarrierResult<CarrierState>>;
  readonly close: () => void;
}

function failed(code: CarrierErrorCode, expected: string, hint: string, detail: Readonly<Record<string, unknown>> = {}): CarrierResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

export function createToolCarrierProvider(
  offer: CarrierOffer,
  request: (path: string, body: unknown, bearerToken: string) => Promise<unknown>,
): ToolCarrierProvider {
  let closed = false;
  let phase: CarrierPhase = offer.state;
  const call = async <T>(path: string, body: unknown): Promise<CarrierResult<T>> => {
    if (closed || phase === 'exited') {
      return failed('carrier-exited', 'an active carrier offer', 'Request a fresh visible offer after provider exit.');
    }
    try {
      const value = await request(path, body, offer.bearerToken);
      if (typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean') {
        return value as CarrierResult<T>;
      }
      return failed('carrier-provider-exit', 'an Engine CarrierResult response', 'Offer a fresh carrier and retry from a serialized snapshot.');
    } catch (cause) {
      return failed(
        'carrier-provider-exit',
        'the authenticated carrier provider to remain reachable',
        'Offer a fresh carrier; do not fallback after started.',
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
  };
  const phaseFailure = (expected: string): CarrierResult<never> => {
    if (phase === 'exited') return failed('carrier-exited', expected, 'Offer a fresh carrier after the provider exits.');
    return failed('carrier-lease-required', expected, `Carrier is in state '${phase}'.`);
  };
  return {
    offer,
    async lease(input) {
      if (phase !== 'offered') return phaseFailure('an offered carrier before lease');
      const result = await call<CarrierLease>('/lease', {
        ...input,
        bearerToken: offer.bearerToken,
        ...(offer.descriptorDigest === undefined ? {} : { descriptorDigest: offer.descriptorDigest }),
        ...(offer.recipeDigest === undefined ? {} : { recipeDigest: offer.recipeDigest }),
      });
      if (result.ok) phase = result.state;
      return result;
    },
    async started(input) {
      if (phase !== 'leased') return phaseFailure('a leased carrier before start');
      const result = await call<CarrierState>('/start', input);
      if (result.ok) phase = result.state;
      return result;
    },
    async execute(input) {
      if (phase !== 'started') return phaseFailure('a started carrier before execute');
      const result = await call<ToolTerminal<unknown>>('/execute', input);
      if (result.ok) phase = result.state;
      return result;
    },
    async exit(input) {
      if (phase !== 'leased' && phase !== 'started') return phaseFailure('a leased or started carrier before exit');
      const result = await call<CarrierState>('/exit', input);
      if (result.ok) phase = result.state;
      return result;
    },
    close() {
      closed = true;
      phase = 'exited';
    },
  };
}
