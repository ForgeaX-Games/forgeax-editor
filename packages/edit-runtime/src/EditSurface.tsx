// EditSurface.tsx — stub for TDD red stage (w11).
//
// The real implementation will be done in w13. This file exists so that
// the w11 test file can resolve its imports. The exported functions will
// throw — tests are expected to be RED until w13 implements them.

export type EditorImportErrorCode = 'SERVER_UNAVAILABLE' | 'UNKNOWN';

export class EditorImportError extends Error {
  code: EditorImportErrorCode;
  hint: string;
  expected: string;

  constructor(code: EditorImportErrorCode) {
    super(`EditorImportError: ${code}`);
    this.name = 'EditorImportError';
    this.code = code;
    this.hint = 'STUB — implementation pending (w13)';
    this.expected = 'STUB — implementation pending (w13)';
  }
}

export interface ProbeResult {
  available: boolean;
  slug?: string | null;
  error?: EditorImportError;
}

export async function probeServer(
  _serverBase?: string,
): Promise<ProbeResult> {
  throw new Error('probeServer: not implemented yet — w13');
}