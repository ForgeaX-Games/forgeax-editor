// source-publication-observer — a read-only barrier over the producer Catalog,
// edit preview, and runtime publication probes. It owns no current/LKG/run
// state; the caller supplies the immutable target and injected observations.

export interface SourcePublicationObservation {
  readonly runId: string;
  readonly guid: string;
  readonly desiredRevision: string;
  readonly current: SourcePublicationCurrent;
  readonly lastKnownGood?: SourcePublicationCurrent;
  readonly adoptLiveMeshMaterialSlots?: boolean;
}

export interface SourcePublicationCurrent {
  readonly identity: string;
  readonly revision: string;
}

export interface SourcePublicationProbes {
  readonly catalog: (target: SourcePublicationObservation) => Promise<SourcePublicationCurrent | false>;
  readonly preview: (target: SourcePublicationObservation) => Promise<SourcePublicationCurrent | false>;
  readonly runtime: (target: SourcePublicationObservation) => Promise<SourcePublicationCurrent | false>;
  readonly reconcile?: () => Promise<void> | void;
}

export type SourcePublicationObservationResult =
  | {
    readonly status: 'succeeded';
    readonly runId: string;
    readonly guid: string;
    readonly desiredRevision: string;
    readonly current: SourcePublicationCurrent;
    readonly observations: {
      readonly catalog: SourcePublicationCurrent;
      readonly preview: SourcePublicationCurrent;
      readonly runtime: SourcePublicationCurrent;
    };
  }
  | {
    readonly status: 'failed' | 'observation-timeout';
    readonly runId: string;
    readonly guid: string;
    readonly desiredRevision: string;
    readonly current: SourcePublicationCurrent;
    readonly lastKnownGood?: SourcePublicationCurrent;
    readonly error: {
      readonly code: 'asset-cook-failed' | 'asset-publish-observation-timeout';
      readonly recoveryActions: readonly string[];
    };
  };

export interface SourcePublicationObserver {
  observe(target: SourcePublicationObservation, signal?: AbortSignal): Promise<SourcePublicationObservationResult>;
  reconcile(target: SourcePublicationObservation, signal?: AbortSignal): Promise<SourcePublicationObservationResult>;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('observation-timeout')), timeoutMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error('observation-aborted'));
    };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    const settle = (kind: 'resolve' | 'reject', value: T | Error): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (kind === 'resolve') resolve(value as T);
      else reject(value);
    };
    work.then(
      (value) => settle('resolve', value),
      (error) => settle('reject', error),
    );
  });
}

function sameCurrent(left: SourcePublicationCurrent | false, right: SourcePublicationCurrent): left is SourcePublicationCurrent {
  return left !== false
    && typeof left === 'object'
    && left.identity.toLowerCase() === right.identity.toLowerCase()
    && left.revision === right.revision;
}

export function createSourcePublicationObserver(input: {
  readonly timeoutMs: number;
  readonly probes: SourcePublicationProbes;
}): SourcePublicationObserver {
  const observe = async (target: SourcePublicationObservation, signal?: AbortSignal): Promise<SourcePublicationObservationResult> => {
    const deadline = Date.now() + input.timeoutMs;
    try {
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const catalog = await withTimeout(input.probes.catalog(target), remaining, signal);
        if (sameCurrent(catalog, {
          identity: target.guid,
          revision: catalog === false ? target.desiredRevision : catalog.revision,
        })) {
          // Catalog owns the consumed revision. A cook can publish a new DDC
          // revision between probes while sidecar watchers settle. Treat that
          // mismatch as a transient publication state and retry the complete
          // barrier; reporting a hard cook failure here races a valid recook.
          const consumedTarget: SourcePublicationObservation = {
            ...target,
            desiredRevision: catalog.revision,
            current: catalog,
          };
          const preview = await withTimeout(
            input.probes.preview(consumedTarget),
            Math.max(1, deadline - Date.now()),
            signal,
          );
          const runtime = await withTimeout(
            input.probes.runtime(consumedTarget),
            Math.max(1, deadline - Date.now()),
            signal,
          );
          if (sameCurrent(preview, catalog) && sameCurrent(runtime, catalog)) {
            return {
              status: 'succeeded',
              runId: target.runId,
              guid: target.guid,
              desiredRevision: catalog.revision,
              current: catalog,
              observations: { catalog, preview, runtime },
            };
          }
        }
        const pauseMs = Math.min(20, deadline - Date.now());
        if (pauseMs > 0) {
          await withTimeout(new Promise<void>((resolve) => setTimeout(resolve, pauseMs)), pauseMs + 1, signal);
        }
      }
      return {
        status: 'failed',
        ...target,
        error: { code: 'asset-cook-failed', recoveryActions: ['run.retry', 'catalog.reconcile'] },
      };
    } catch (error) {
      if (error instanceof Error && (error.message === 'observation-timeout' || error.message === 'observation-aborted')) {
        return {
          status: 'observation-timeout',
          ...target,
          error: { code: 'asset-publish-observation-timeout', recoveryActions: ['catalog.reconcile', 'run.retry'] },
        };
      }
      return {
        status: 'failed',
        ...target,
        error: { code: 'asset-cook-failed', recoveryActions: ['run.retry', 'catalog.reconcile'] },
      };
    }
  };

  return {
    observe,
    async reconcile(target, signal) {
      await input.probes.reconcile?.();
      return observe(target, signal);
    },
  };
}
