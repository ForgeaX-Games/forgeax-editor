import { describe, expect, it } from 'bun:test';
import type { EditorOp } from '../../types';
import {
  createDiagnosticsReadModel,
  DIAGNOSTICS_DEDUPE,
  DIAGNOSTICS_RETENTION,
} from '../diagnostics';
import type { OperationRun, OperationRunSnapshot } from '../operation-runs';
import type { AssetsErrorPayload } from '../../store/assets-error-bus';
import type { SpanNode } from '../trace';
import { createEditSession } from '../../session/document';
import { EditGateway } from '../gateway';
import '../../scan/scan-ops';
import { createRuntimeReadiness } from '../vfx-runtime-readiness';
import { runtimeReadinessDiagnostic } from '../diagnostics';

function span(traceId: string, name: string): SpanNode {
  return {
    traceId,
    spanId: `${traceId}-span`,
    parentSpanId: null,
    name,
    start: 1,
    end: 2,
    attributes: { engineCalls: [], sideEffects: [] },
    status: 'OK',
    children: [],
  };
}

function run(runId: string): OperationRun {
  return {
    schemaVersion: 'operation-run/v1',
    runId,
    requestId: `${runId}-request`,
    operationId: 'saveDocToDisk',
    status: 'failed',
    actor: { id: 'ai', kind: 'ai' },
    sessionId: 'editor',
    scope: 'editor',
    traceId: `${runId}-trace`,
    attempt: 1,
    cancellable: false,
    retryable: true,
    progress: { fraction: 1, stage: 'failed' },
    error: { code: 'save-failed', hint: 'save failed', retryable: true, recoveryActions: ['run.retry'] },
    recoveryActions: ['run.retry'],
    effectResults: {},
    acceptedAt: 1,
    completedAt: 2,
    sequence: 3,
  };
}

const scanDiagnostic = {
  file: 'assets/broken.glb',
  severity: 'error' as const,
  code: 'invalid-glb-header',
  message: 'invalid header',
  suggestion: 'replace the source',
};

const assetError: AssetsErrorPayload = {
  op: 'writePackEntry',
  path: 'scenes/main.pack',
  hint: 'disk full',
  ts: 10,
};

describe('R0-07C diagnostics read model', () => {
  it('projects bounded readiness with request, asset, and revision correlation', () => {
    const readiness = createRuntimeReadiness({
      state: 'render-unavailable',
      requestId: 'request-render-1',
      assetGuid: 'particle-guid',
      committedRevision: 4,
      residentRevision: 4,
      hint: 'Renderer is unavailable; retry after a render device is bound.',
    });
    expect(runtimeReadinessDiagnostic(readiness)).toEqual({
      source: 'operationRuns',
      severity: 'warn',
      code: 'runtime-readiness',
      requestId: 'request-render-1',
      assetGuid: 'particle-guid',
      revision: 4,
      state: 'render-unavailable',
      hint: 'Renderer is unavailable; retry after a render device is bound.',
      retryable: true,
    });
  });

  it('derives all four owned sources with latest-wins dedupe and explicit bounded retention', () => {
    const operationSnapshot: OperationRunSnapshot = {
      revision: 9,
      runs: [run('run-1'), run('run-1'), run('run-2')],
    };
    const model = createDiagnosticsReadModel({
      getRevision: () => 3,
      getLedger: () => [
        { kind: 'assetValidationFailed', diagnostics: [scanDiagnostic, scanDiagnostic] },
        { kind: 'assetValidationFailed', diagnostics: [{ file: 'assets/other.glb', severity: 'warn', code: 'empty-file', message: 'empty' }] },
      ] as EditorOp[],
      getTraceRoots: () => [span('trace-1', 'first'), span('trace-1', 'latest'), span('trace-2', 'second')],
      getDroppedTraceCount: () => 7,
      getAssetErrors: () => [assetError, assetError, { ...assetError, op: 'renameSourceFile' }],
      getAssetErrorRevision: () => 4,
      getOperationRunSnapshot: () => operationSnapshot,
    }, { retention: { traceRoots: 1, scanDiagnostics: 1, assetErrors: 1, operationRuns: 1, runtimeFacts: 1 } });

    const snapshot = model.snapshot();

    expect(snapshot.schemaVersion).toBe('diagnostics/v1');
    expect(snapshot.revision).toBe(9);
    expect(snapshot.trace.roots.map((root) => root.name)).toEqual(['second']);
    expect(snapshot.trace.deduplicated).toBe(1);
    expect(snapshot.trace.dropped).toBe(8);
    expect(snapshot.scan.diagnostics).toEqual([{ file: 'assets/other.glb', severity: 'warn', code: 'empty-file', message: 'empty' }]);
    expect(snapshot.scan.deduplicated).toBe(1);
    expect(snapshot.scan.dropped).toBe(1);
    expect(snapshot.assets.errors).toEqual([{ ...assetError, op: 'renameSourceFile' }]);
    expect(snapshot.assets.deduplicated).toBe(1);
    expect(snapshot.assets.dropped).toBe(1);
    expect(snapshot.operationRuns.runs.map((item) => item.runId)).toEqual(['run-2']);
    expect(snapshot.operationRuns.deduplicated).toBe(1);
    expect(snapshot.operationRuns.dropped).toBe(1);
    expect(snapshot.policy.retention).toEqual({ traceRoots: 1, scanDiagnostics: 1, assetErrors: 1, operationRuns: 1, runtimeFacts: 1 });
    expect(snapshot.policy.dedupe).toEqual(DIAGNOSTICS_DEDUPE);
  });

  it('uses the declared defaults and ignores malformed scan payloads', () => {
    const model = createDiagnosticsReadModel({
      getRevision: () => 0,
      getLedger: () => [
        { kind: 'assetValidationFailed', diagnostics: [null, { file: 'x', severity: 'fatal', code: 'bad', message: 'bad' }] },
      ] as EditorOp[],
      getTraceRoots: (limit) => Array.from({ length: limit + 1 }, (_, index) => span(`trace-${index}`, 'trace')),
      getDroppedTraceCount: () => 0,
      getAssetErrors: () => [],
      getOperationRunSnapshot: () => ({ revision: 0, runs: [] }),
    });

    const snapshot = model.snapshot();

    expect(snapshot.scan.diagnostics).toEqual([]);
    expect(snapshot.trace.roots).toHaveLength(DIAGNOSTICS_RETENTION.traceRoots);
    expect(snapshot.trace.roots[0]?.traceId).toBe('trace-1');
    expect(snapshot.policy.retention).toEqual(DIAGNOSTICS_RETENTION);
  });

  it('is reachable through the Gateway without making console output a source', () => {
    const gateway = new EditGateway(createEditSession());
    const dispatched = gateway.dispatch({
      kind: 'assetValidationFailed',
      diagnostics: [scanDiagnostic],
    });

    expect(dispatched.ok).toBe(true);
    expect(gateway.diagnostics.snapshot().scan.diagnostics).toEqual([scanDiagnostic]);
    expect(gateway.diagnostics.snapshot().operationRuns.runs).toEqual([]);
  });

  it('projects producer-owned runtime facts through the same Gateway query', () => {
    let listener: (() => void) | undefined;
    const gateway = new EditGateway(createEditSession());
    const unregister = gateway.registerRuntimeDiagnosticsProvider({
      id: 'editor-vfx',
      snapshot: () => [{
        id: 'particle-render-feature',
        severity: 'warn',
        code: 'particle-render-camera-unavailable',
        title: 'Particle renderer',
        message: 'The particle renderer has no active camera.',
        requestId: 'request-vfx-1',
        assetGuid: 'particle-guid',
        retryable: true,
        recoveryActions: ['runtime.vfx.retry'],
        detail: {
          readiness: 'unavailable',
          feature: 'forgeax.vfx-render.particles',
          provenance: { source: 'engine-vfx-render', host: 'VfxRuntimeHost' },
        },
      }],
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = undefined; };
      },
    });

    const projected = gateway.diagnostics.query({ sources: ['runtime'], query: 'particle-guid' });
    expect(projected.items).toHaveLength(1);
    expect(projected.items[0]).toMatchObject({
      source: 'runtime',
      providerId: 'editor-vfx',
      assetGuid: 'particle-guid',
      requestId: 'request-vfx-1',
      code: 'particle-render-camera-unavailable',
      retryable: true,
      recoveryActions: ['runtime.vfx.retry'],
    });
    expect(projected.items[0]?.detail).toMatchObject({
      providerId: 'editor-vfx',
      fact: { feature: 'forgeax.vfx-render.particles' },
    });

    const before = gateway.diagnostics.snapshot().revision;
    listener?.();
    expect(gateway.diagnostics.snapshot().revision).toBeGreaterThan(before);
    unregister();
    expect(gateway.diagnostics.query({ sources: ['runtime'] }).items).toEqual([]);
  });

  it('advances the composite revision when a non-max source changes', () => {
    let runtimeRevision = 1;
    const model = createDiagnosticsReadModel({
      getRevision: () => 0,
      getLedger: () => [],
      getTraceRoots: () => [],
      getDroppedTraceCount: () => 0,
      getAssetErrors: () => [],
      getAssetErrorRevision: () => 9,
      getOperationRunSnapshot: () => ({ revision: 0, runs: [] }),
      getRuntimeDiagnosticsProviders: () => [{
        id: 'editor-vfx',
        snapshot: () => [{
          id: 'particle-render-feature',
          severity: 'info' as const,
          code: 'particle-render-ready',
          title: 'Particle renderer',
          message: 'ready',
          retryable: false,
          recoveryActions: [],
          detail: {},
        }],
      }],
      getRuntimeDiagnosticsRevision: () => runtimeRevision,
    });

    expect(model.snapshot().revision).toBe(9);
    runtimeRevision = 2;
    expect(model.snapshot().revision).toBe(10);
    runtimeRevision = 3;
    expect(model.snapshot().revision).toBe(11);
  });

  it('notifies diagnostics subscribers for ledger-only facts', () => {
    const gateway = new EditGateway(createEditSession());
    let notifications = 0;
    const unsubscribe = gateway.subscribeDiagnostics(() => { notifications += 1; });

    const dispatched = gateway.dispatch({
      kind: 'assetValidationFailed',
      diagnostics: [scanDiagnostic],
    }, 'ai');

    expect(dispatched.ok).toBe(true);
    expect(notifications).toBe(1);
    unsubscribe();

    gateway.dispatch({
      kind: 'assetValidationFailed',
      diagnostics: [{ ...scanDiagnostic, file: 'assets/second.glb' }],
    }, 'ai');
    expect(notifications).toBe(1);
  });

  it('provides one bounded query across the four snapshot sources', () => {
    const model = createDiagnosticsReadModel({
      getRevision: () => 8,
      getLedger: () => [{ kind: 'assetValidationFailed', diagnostics: [scanDiagnostic] }] as EditorOp[],
      getTraceRoots: () => [{ ...span('trace-query', 'query trace'), status: 'ERROR' }],
      getDroppedTraceCount: () => 0,
      getAssetErrors: () => [assetError],
      getOperationRunSnapshot: () => ({ revision: 8, runs: [run('run-query')] }),
    });

    const bounded = model.query({ limit: 2 });
    expect(bounded.schemaVersion).toBe('diagnostics-query/v1');
    expect(bounded.revision).toBe(8);
    expect(bounded.items.map((item) => item.source)).toEqual(['trace', 'scan']);
    expect(bounded.matched).toBe(4);
    expect(bounded.truncated).toBe(true);

    const scan = model.query({ query: 'invalid-glb-header', sources: ['scan'] });
    expect(scan.items).toHaveLength(1);
    expect(scan.items[0]?.subjectRef).toEqual({ kind: 'source-file', id: 'assets/broken.glb' });
    expect(scan.items[0]?.recoveryActions).toEqual([]);
  });
});
