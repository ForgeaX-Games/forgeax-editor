import { afterEach, describe, expect, it } from 'bun:test';
import { EditGateway } from '../gateway';
import { sessionAppliers } from '../appliers';
import '../project-validation-ops';
import {
  normalizeProjectValidationResult,
  projectValidationDiagnostics,
  registerProjectValidationProvider,
} from '../project-validation';
import { createEditSession } from '../../session/document';

const stats = { bytes: 12, entities: 2, packs: 1, sidecars: 0 };

function blocking(file: string, code = 'missing-reference') {
  return { file, code, message: `broken ${file}`, detail: { ref: 'missing-guid' } };
}

afterEach(() => {
  const existing = sessionAppliers.get('validateGameProject');
  if (existing === undefined) sessionAppliers.delete('validateGameProject');
});

describe('project validation contract', () => {
  it('normalizes producer rows into bounded, stable file locations', () => {
    const raw = {
      ok: false,
      blocking: Array.from({ length: 130 }, (_, index) => blocking(`assets/${index}.pack.json`)),
      warnings: [{ file: 'forge.json', code: 'budget-zero', message: 'zero budget', detail: {} }],
      stats,
    };
    const normalized = normalizeProjectValidationResult(raw);
    expect(normalized).toMatchObject({ ok: true, result: {
      schemaVersion: 'project-validation/v1',
      ok: false,
      issueCount: 131,
      blockingCount: 130,
      warningCount: 1,
      truncated: true,
    } });
    if (!normalized.ok) return;
    expect(normalized.result.issues).toHaveLength(128);
    expect(normalized.result.issues[0]).toMatchObject({
      id: 'project-validation:error:missing-reference:assets/0.pack.json:1',
      severity: 'error',
      location: { kind: 'file', id: 'assets/0.pack.json' },
    });
    expect(normalized.result.issues.at(-1)?.location.id).toBe('assets/127.pack.json');
  });

  it('uses one correlated run for accepted, running, terminal validation facts', async () => {
    let invalid = true;
    const restore = registerProjectValidationProvider({
      validate: async () => invalid
        ? { ok: false, blocking: [blocking('assets/scene.pack.json')], warnings: [], stats }
        : { ok: true, blocking: [], warnings: [], stats },
    });
    try {
      const gateway = new EditGateway(createEditSession());
      const missingRequestId = gateway.dispatch({ kind: 'validateGameProject' }, 'ai');
      expect(missingRequestId).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });

      const accepted = gateway.dispatch({ kind: 'validateGameProject', requestId: 'validate-1' }, 'ai');
      expect(accepted).toMatchObject({ ok: true, result: { operationRun: {
        requestId: 'validate-1', operationId: 'validateGameProject', status: 'running',
      } } });
      const terminal = await gateway.waitOperationRun('validate-1');
      expect(terminal).toMatchObject({ ok: true, value: {
        requestId: 'validate-1', status: 'succeeded', result: {
          ok: false,
          issues: [{ location: { kind: 'file', id: 'assets/scene.pack.json' } }],
        },
      } });
      if (!terminal.ok) return;
      const diagnostics = projectValidationDiagnostics([terminal.value]);
      expect(diagnostics).toMatchObject([{
        id: expect.stringContaining('project-validation:error:missing-reference'),
        severity: 'error',
        path: 'assets/scene.pack.json',
        requestId: 'validate-1',
        detail: { issue: { location: { id: 'assets/scene.pack.json' } } },
      }]);

      invalid = false;
      const cleanAccepted = gateway.dispatch({ kind: 'validateGameProject', requestId: 'validate-2' }, 'ai');
      expect(cleanAccepted).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
      const cleanTerminal = await gateway.waitOperationRun('validate-2');
      expect(cleanTerminal).toMatchObject({ ok: true, value: { status: 'succeeded', result: { ok: true, issues: [] } } });
      if (!cleanTerminal.ok) return;
      expect(projectValidationDiagnostics([terminal.value, cleanTerminal.value])).toEqual([]);
    } finally {
      restore();
    }
  });
});
