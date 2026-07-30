import { describe, expect, it } from 'bun:test';
import schema from '../runtime-ui-diagnostics.schema.json';
import { parseRuntimeUiDiagnostics, type RuntimeUiDiagnostics } from '../runtime-ui-diagnostics';

const provenance = { worldGeneration: 3, source: 'editor-core', evidenceId: 'test-1' };

describe('runtime UI diagnostics schema', () => {
  it('keeps the canonical status and provenance vocabulary machine-readable', () => {
    expect(schema.properties.status.enum).toEqual(['success', 'unbound', 'stale', 'unsupported', 'read-failed']);
    expect(schema.properties.provenance.required).toEqual(['worldGeneration', 'source', 'evidenceId']);
  });

  it.each(['success', 'unbound', 'stale'] as const)('accepts %s diagnostics', (status) => {
    const result = parseRuntimeUiDiagnostics({ schemaVersion: 1, status, provenance } as RuntimeUiDiagnostics);
    expect(result.ok).toBe(true);
  });

  it.each(['unsupported', 'read-failed'] as const)('requires recovery fields for %s diagnostics', (status) => {
    const result = parseRuntimeUiDiagnostics({ schemaVersion: 1, status, provenance, code: status, hint: 'retry', expected: 'number', actual: 'string', retryable: true } as RuntimeUiDiagnostics);
    expect(result.ok).toBe(true);
  });

  it('rejects missing executable error fields and business payloads', () => {
    expect(parseRuntimeUiDiagnostics({ schemaVersion: 1, status: 'unsupported', provenance })).toMatchObject({ ok: false });
    expect(parseRuntimeUiDiagnostics({
      schemaVersion: 1,
      status: 'read-failed',
      provenance,
      code: 'read-failed',
      hint: 'retry the mounted selector',
      expected: 'number',
      actual: 'string',
      retryable: true,
      businessValue: { secret: 'must not cross diagnostics' },
    } as never)).toMatchObject({ ok: false });
  });
});
