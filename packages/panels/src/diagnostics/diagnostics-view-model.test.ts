import { describe, expect, it } from 'bun:test';
import {
  buildDiagnosticsRows,
  filterDiagnosticsRows,
  formatDiagnosticsDetail,
} from './diagnostics-view-model';
import type { DiagnosticsSnapshot } from '@forgeax/editor-core';

function snapshot(): DiagnosticsSnapshot {
  return {
    schemaVersion: 'diagnostics/v1',
    revision: 7,
    trace: {
      roots: [{
        traceId: 'trace-1', spanId: 'span-1', parentSpanId: null, name: 'saveDocToDisk',
        start: 1, end: 2, attributes: { engineCalls: [], sideEffects: [] }, status: 'ERROR', children: [],
      }],
      dropped: 0,
      deduplicated: 0,
    },
    scan: {
      diagnostics: [{
        file: 'assets/hero.glb', severity: 'error', code: 'invalid-glb-header',
        message: 'The source is not a GLB.', suggestion: 'replace the source',
      }],
      dropped: 0,
      deduplicated: 0,
    },
    assets: {
      errors: [{ op: 'renameSourceFile', path: 'assets/hero.glb', hint: 'rename failed', ts: 4 }],
      dropped: 0,
      deduplicated: 0,
    },
    operationRuns: {
      runs: [{
        runId: 'run-1', requestId: 'request-1', operationId: 'importAsset',
        actor: { kind: 'human', id: 'test' }, sessionId: 'editor', scope: 'editor', traceId: 'trace-2',
        attempt: 1, sequence: 1, status: 'failed', progress: { stage: 'failed', fraction: 1 },
        cancellable: false, retryable: true, recoveryActions: ['operation.retry'],
        input: { destPath: 'assets/hero.glb' },
        error: {
          code: 'IMPORT_COOK_FAILED', hint: 'Cook failed', retryable: true, recoveryActions: ['operation.retry'],
          objectRefs: { file: { kind: 'source-file', id: 'assets/hero.glb' } },
        },
      } as never],
      registryRevision: 2,
      dropped: 0,
      deduplicated: 0,
    },
    runtime: {
      facts: [],
      dropped: 0,
      deduplicated: 0,
    },
    policy: {
      retention: { traceRoots: 64, scanDiagnostics: 128, assetErrors: 64, operationRuns: 64, runtimeFacts: 128 },
      dedupe: {
        traceRoots: 'traceId',
        scanDiagnostics: 'file+severity+code+message+suggestion',
        assetErrors: 'op+path+hint',
        operationRuns: 'runId',
        runtimeFacts: 'providerId+id',
      },
    },
  };
}

describe('diagnostics panel projection', () => {
  it('projects existing facts into one action-bearing list', () => {
    const rows = buildDiagnosticsRows(snapshot());
    expect(rows.map((row) => row.source)).toEqual(['trace', 'scan', 'assets', 'operationRuns']);
    expect(rows.find((row) => row.source === 'scan')?.actions).toEqual(['locate', 'copy', 'open-source']);
    expect(rows.find((row) => row.source === 'operationRuns')?.actions).toEqual(['locate', 'copy', 'open-source', 'retry']);
    expect(rows.find((row) => row.source === 'operationRuns')?.requestId).toBe('request-1');
  });

  it('filters by source, severity, and searchable structured fields', () => {
    const rows = buildDiagnosticsRows(snapshot());
    expect(filterDiagnosticsRows(rows, { sources: ['scan'] }).map((row) => row.code)).toEqual(['invalid-glb-header']);
    expect(filterDiagnosticsRows(rows, { severities: ['info'] })).toEqual([]);
    expect(filterDiagnosticsRows(rows, { query: 'request-1' }).map((row) => row.runId)).toEqual(['run-1']);
  });

  it('formats source facts for copy without making text a control signal', () => {
    const row = buildDiagnosticsRows(snapshot()).find((item) => item.source === 'scan');
    expect(row).toBeDefined();
    expect(formatDiagnosticsDetail(row!)).toContain('invalid-glb-header');
  });
});
