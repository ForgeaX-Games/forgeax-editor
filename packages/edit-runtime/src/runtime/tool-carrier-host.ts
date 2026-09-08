import type { CarrierOffer } from '@forgeax/engine-tool-runtime';
import { createToolCarrierProvider, type ToolCarrierProvider } from './tool-carrier-provider';

export interface ToolCarrierHostOptions {
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly offerPath?: string;
  readonly releasePath?: string;
}

export interface ToolCarrierHost {
  readonly offer: (input: Pick<CarrierOffer, 'descriptorDigest' | 'recipeDigest'>) => Promise<{ readonly ok: true; readonly provider: ToolCarrierProvider } | { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly expected?: string; readonly detail?: Readonly<Record<string, unknown>> } }>;
  readonly release: (offerId: string) => Promise<void>;
}

function unavailable(code: string, hint: string, expected?: string, detail?: Readonly<Record<string, unknown>>): { readonly ok: false; readonly error: { readonly code: string; readonly hint: string; readonly expected?: string; readonly detail?: Readonly<Record<string, unknown>> } } {
  return { ok: false, error: { code, hint, ...(expected === undefined ? {} : { expected }), ...(detail === undefined ? {} : { detail }) } };
}

function isCarrierOffer(value: unknown): value is CarrierOffer {
  if (typeof value !== 'object' || value === null) return false;
  const offer = value as Partial<CarrierOffer>;
  return offer.schemaVersion === '1.0.0'
    && typeof offer.projectId === 'string'
    && typeof offer.consumerId === 'string'
    && typeof offer.offerId === 'string'
    && typeof offer.endpoint === 'string'
    && typeof offer.bearerToken === 'string'
    && typeof offer.livenessToken === 'string'
    && typeof offer.expiresAt === 'number'
    && offer.state === 'offered';
}

export function createToolCarrierHost(options: ToolCarrierHostOptions = {}): ToolCarrierHost {
  const requestFetch = options.fetch ?? globalThis.fetch;
  const offerPath = options.offerPath ?? '/api/carrier/offer';
  const releasePath = options.releasePath ?? '/api/carrier/release';
  const request = async (path: string, body: unknown, bearerToken?: string): Promise<unknown> => {
    const response = await requestFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }) },
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok && (typeof value !== 'object' || value === null || !('ok' in value))) {
      throw new Error(`carrier host returned HTTP ${response.status}`);
    }
    return value;
  };
  return {
    async offer(input) {
      try {
        const value = await request(offerPath, input);
        if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true || !('offer' in value) || !isCarrierOffer(value.offer)) return unavailable('carrier-unavailable', 'The Node host did not publish an Engine-authenticated visible offer; keep the private path explicit.', 'an Engine CarrierOffer with schemaVersion 1.0.0');
        return { ok: true, provider: createToolCarrierProvider(value.offer, request) };
      } catch (cause) {
        return unavailable('carrier-provider-unavailable', cause instanceof Error ? cause.message : 'The Node host could not publish a visible provider offer.');
      }
    },
    async release(offerId) {
      await request(releasePath, { offerId }).catch(() => undefined);
    },
  };
}
