// Versioned capability manifest derived from CapabilityRegistry.

import type { CapabilityDescriptor } from './capability';

export const PRODUCT_CONTRACT_MANIFEST_VERSION = 'editor-product/v1' as const;
export const PRODUCT_CONTRACT_VERSION = '0.1.0' as const;

export interface ProductContractManifest {
  readonly manifestVersion: typeof PRODUCT_CONTRACT_MANIFEST_VERSION;
  readonly contractVersion: typeof PRODUCT_CONTRACT_VERSION;
  readonly productId: '@forgeax/editor-product';
  readonly uiFree: true;
  readonly capabilitySource: 'registered-ssot';
}

export const PRODUCT_CONTRACT_MANIFEST: ProductContractManifest = Object.freeze({
  manifestVersion: PRODUCT_CONTRACT_MANIFEST_VERSION,
  contractVersion: PRODUCT_CONTRACT_VERSION,
  productId: '@forgeax/editor-product',
  uiFree: true,
  capabilitySource: 'registered-ssot',
});

export const PRODUCT_CAPABILITY_MANIFEST_VERSION = 'editor-product/capabilities-v1' as const;

export interface CapabilityManifest {
  readonly manifestVersion: typeof PRODUCT_CAPABILITY_MANIFEST_VERSION;
  readonly contractVersion: string;
  readonly productId: '@forgeax/editor-product';
  readonly generatedFrom: 'capability-registry';
  readonly capabilities: readonly CapabilityDescriptor[];
}

export function createCapabilityManifest(
  capabilities: readonly CapabilityDescriptor[],
  contractVersion: string,
): CapabilityManifest {
  return Object.freeze({
    manifestVersion: PRODUCT_CAPABILITY_MANIFEST_VERSION,
    contractVersion,
    productId: '@forgeax/editor-product' as const,
    generatedFrom: 'capability-registry' as const,
    capabilities: Object.freeze([...capabilities]),
  });
}
