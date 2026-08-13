// Render-input diagnostics for the in-process editor viewport.
//
// Camera.fov is an engine value in radians. Keep this contract check small and
// structural: it catches projection inputs that can produce a visibly invalid
// frame without turning a visual preference into a smoke assertion.

import type {
  RuntimeDiagnosticFact,
  RuntimeDiagnosticsProvider,
} from '@forgeax/editor-core';
import type {
  RenderFeatureDiagnostics,
  RenderFeatureErrorDescriptor,
} from '@forgeax/engine-render';

export const INFINITE_GRID_DIAGNOSTICS_PROVIDER_ID = 'editor-infinite-grid';
const INFINITE_GRID_FEATURE_ID = 'editor.infinite-grid';

export interface InfiniteGridDiagnosticsSource {
  readonly readFeatureDiagnostics: () => readonly RenderFeatureDiagnostics[];
  readonly readGeneration?: () => number | null;
}

export interface InfiniteGridDiagnosticsProvider extends RuntimeDiagnosticsProvider {
  readonly notify: () => void;
}

function readErrorDetail(error: RenderFeatureErrorDescriptor | undefined): Readonly<Record<string, unknown>> {
  if (error === undefined) return {};
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  };
}

function readDetailString(
  error: RenderFeatureErrorDescriptor | undefined,
  key: string,
): string | undefined {
  const detail = error?.detail as Readonly<Record<string, unknown>> | undefined;
  const value = detail?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readDetailNumber(
  error: RenderFeatureErrorDescriptor | undefined,
  key: string,
): number | undefined {
  const detail = error?.detail as Readonly<Record<string, unknown>> | undefined;
  const value = detail?.[key];
  return typeof value === 'number' ? value : undefined;
}

function recoveryActions(recovery: string | undefined): readonly string[] {
  if (recovery === 'renderer-recover') {
    return ['renderer.recover', 'run.wait', 'run.retry'];
  }
  if (recovery === 'registration') {
    return ['renderer.reconnect', 'run.wait'];
  }
  return ['run.wait', 'run.retry'];
}

function projectInfiniteGridFact(
  source: InfiniteGridDiagnosticsSource,
): RuntimeDiagnosticFact {
  const feature = source.readFeatureDiagnostics().find(
    (candidate) => candidate.identity === INFINITE_GRID_FEATURE_ID,
  );
  const error = feature?.latestError;
  const generation = source.readGeneration?.() ?? readDetailNumber(error, 'actualGeneration');
  const stage = readDetailString(error, 'stage');
  const target = readDetailString(error, 'resourceName');
  const recovery = readDetailString(error, 'recovery');
  const failed = feature === undefined || feature.status !== 'active' || error !== undefined;
  const status = feature?.status ?? 'unavailable';

  return Object.freeze({
    id: INFINITE_GRID_DIAGNOSTICS_PROVIDER_ID,
    severity: failed ? 'warn' : 'info',
    code: error?.code ?? (failed ? 'infinite-grid-unavailable' : 'infinite-grid-ready'),
    title: 'Infinite grid render feature',
    message: error?.hint ?? `Infinite grid is ${status}.`,
    retryable: failed,
    recoveryActions: Object.freeze(failed ? recoveryActions(recovery) : []),
    ...(stage === undefined ? {} : { stage }),
    ...(generation === undefined ? {} : { generation }),
    ...(target === undefined ? {} : { target }),
    ...(recovery === undefined ? {} : { recovery }),
    detail: Object.freeze({
      featureIdentity: INFINITE_GRID_FEATURE_ID,
      status,
      order: feature?.order ?? null,
      generation: generation ?? null,
      target: target ?? null,
      recovery: recovery ?? null,
      error: readErrorDetail(error),
    }),
  });
}

export function createInfiniteGridDiagnosticsProvider(
  source: InfiniteGridDiagnosticsSource,
): InfiniteGridDiagnosticsProvider {
  const listeners = new Set<() => void>();
  return {
    id: INFINITE_GRID_DIAGNOSTICS_PROVIDER_ID,
    snapshot: () => Object.freeze([projectInfiniteGridFact(source)]),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
}

export interface InvalidPerspectiveFov {
  readonly code: 'render-camera-invalid-projection';
  readonly field: 'fov';
  readonly actual: number;
  readonly expected: 'finite perspective fov in (0, π) radians';
  readonly hint: 'Camera.fov is stored in radians; use Math.PI / 3 for 60°.';
}

export function validatePerspectiveFov(fov: number): InvalidPerspectiveFov | undefined {
  if (Number.isFinite(fov) && fov > 0 && fov < Math.PI) return undefined;
  return {
    code: 'render-camera-invalid-projection',
    field: 'fov',
    actual: fov,
    expected: 'finite perspective fov in (0, π) radians',
    hint: 'Camera.fov is stored in radians; use Math.PI / 3 for 60°.',
  };
}
