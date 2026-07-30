// Producer-owned asset catalog adapter.
//
// This is a read-only seam. It does not infer asset identity or build another
// asset graph; the producer remains the owner of catalog rows and revisions.

import {
  createAssetLifecycleAdapter,
  createAssetWorkspace,
  reconcileImportedTopology,
} from '@forgeax/editor-product';
import type {
  AssetLifecycleAdapter,
  AssetMutationRequest,
  AssetMutationResult,
  AssetPreflightOptions,
  AssetPreflightResult,
  AssetWorkspaceObservation,
  ImportedOutputRecord,
  ImportedOutputReference,
  ReimportTopologyResult,
  AssetWorkspaceSnapshot,
} from '@forgeax/editor-product';

export interface AssetProducerSource<Row = unknown> {
  readonly listCatalog: () => readonly Row[];
  readonly commitCanonical?: (input: unknown) => Promise<{
    readonly revision: string;
    readonly result: unknown;
    readonly inverse?: unknown;
  }>;
}

export interface AssetProducerAvailability {
  readonly available: boolean;
  readonly code?: 'asset-producer-unavailable';
  readonly reason?: string;
  readonly resolution?: string;
}

export interface AssetProducerAdapter<Row = unknown> {
  readonly availability: AssetProducerAvailability;
  readCatalog(): readonly Row[];
  commitCanonical(input: unknown): Promise<{
    readonly revision: string;
    readonly result: unknown;
    readonly inverse?: unknown;
  }>;
}

export interface AssetMutationSafetyAdapterOptions {
  readonly snapshot: AssetWorkspaceSnapshot;
  readonly commit: (request: AssetMutationRequest) => Promise<{
    readonly revision: string;
    readonly snapshot?: AssetWorkspaceSnapshot;
  }>;
  readonly preflightOptions?: AssetPreflightOptions;
}

export interface AssetMutationSafetyAdapter extends AssetLifecycleAdapter {
  readonly run: (request: AssetMutationRequest) => Promise<AssetMutationResult>;
  readonly reimportTopology: (input: {
    readonly previous: readonly ImportedOutputRecord[];
    readonly next: readonly ImportedOutputRecord[];
    readonly references: readonly ImportedOutputReference[];
  }) => ReimportTopologyResult;
}

/**
 * Core-owned adapter for semantic asset mutations. The product layer owns
 * preflight and confirmation; this seam supplies the one canonical commit
 * callback, which is where gateway, AssetIO, and resource transactions attach.
 */
export function createAssetMutationSafetyAdapter(
  options: AssetMutationSafetyAdapterOptions,
): AssetMutationSafetyAdapter {
  const lifecycle = createAssetLifecycleAdapter({
    getSnapshot: () => options.snapshot,
    commit: options.commit,
    preflightOptions: options.preflightOptions,
  });
  return {
    preflight: (request: AssetMutationRequest): AssetPreflightResult => lifecycle.preflight(request),
    run: (request: AssetMutationRequest) => lifecycle.run(request),
    reimportTopology: reconcileImportedTopology,
  };
}

export interface AssetObserverAdapterOptions {
  readonly initialRevision?: string;
  readonly executeMutation?: () => unknown;
}

export interface AssetObserverAdapterResult {
  readonly status: string;
  readonly delta: { readonly revisionChanged: boolean; readonly fullScan: boolean };
  readonly fullScan: boolean;
  readonly recoveryIntent?: unknown;
  readonly workspaceSnapshot: unknown;
}

export interface AssetObserverAdapter {
  observe(observation: AssetWorkspaceObservation): AssetObserverAdapterResult;
  stats(): { readonly fullScans: number; readonly mutationCalls: number };
}

/**
 * Adapt platform observation facts into the product workspace. Observation is
 * intentionally one-way: it can produce a recovery intent, never a mutation.
 */
export function createAssetObserverAdapter(
  options: AssetObserverAdapterOptions = {},
): AssetObserverAdapter {
  const workspace = createAssetWorkspace();
  let fullScans = 0;
  let mutationCalls = 0;
  const observe = (observation: AssetWorkspaceObservation): AssetObserverAdapterResult => {
    const result = workspace.observe(observation);
    if (result.delta.fullScan) fullScans += 1;
    if (options.executeMutation) {
      // Keep this counter as an audit seam; observation never calls it.
      void options.executeMutation;
    }
    return {
      status: result.status,
      delta: { revisionChanged: result.delta.revisionChanged, fullScan: result.delta.fullScan },
      fullScan: result.delta.fullScan,
      ...(result.recoveryIntents[0] ? { recoveryIntent: result.recoveryIntents[0] } : {}),
      workspaceSnapshot: result.snapshot,
    };
  };
  return { observe, stats: () => ({ fullScans, mutationCalls }) };
}

export function createAssetProducerAdapter<Row = unknown>(
  source?: AssetProducerSource<Row>,
): AssetProducerAdapter<Row> {
  if (source === undefined) {
    return {
      availability: {
        available: false,
        code: 'asset-producer-unavailable',
        reason: 'No producer catalog adapter is connected.',
        resolution: 'Connect the engine producer public catalog adapter.',
      },
      readCatalog: () => [],
      commitCanonical: async () => { throw new Error('Asset producer adapter is unavailable.'); },
    };
  }
  return {
    availability: { available: true },
    readCatalog: () => source.listCatalog(),
    commitCanonical: async (input) => {
      if (source.commitCanonical === undefined) throw new Error('Asset producer commit seam is unavailable.');
      return source.commitCanonical(input);
    },
  };
}
