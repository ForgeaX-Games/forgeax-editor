import { describe, expect, it } from 'bun:test';
import { parseRuntimeUiDiagnostics } from '../public/runtime-ui-diagnostics';

const provenance = { worldGeneration: 2, source: 'editor-core', evidenceId: 'error-contract' };

describe('runtime UI diagnostics facade error contract', () => {
  it.each(['success', 'unbound', 'stale'] as const)('consumes %s without a business payload', (status) => {
    expect(parseRuntimeUiDiagnostics({ schemaVersion: 1, status, provenance })).toMatchObject({ ok: true });
  });

  it.each(['unsupported', 'read-failed'] as const)('consumes executable %s errors', (status) => {
    expect(parseRuntimeUiDiagnostics({ schemaVersion: 1, status, provenance, code: status, hint: 'retry the read', expected: 'number', actual: 'string', retryable: true })).toMatchObject({ ok: true });
  });

  it('rejects missing error fields and selector business values', () => {
    expect(parseRuntimeUiDiagnostics({ schemaVersion: 1, status: 'unsupported', provenance })).toMatchObject({ ok: false });
    expect(parseRuntimeUiDiagnostics({ schemaVersion: 1, status: 'read-failed', provenance, code: 'read-failed', hint: 'retry', expected: 'number', actual: 'string', retryable: true, selectorValue: { health: 3 } })).toMatchObject({ ok: false });
  });
});
