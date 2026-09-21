import { VagRuntimeDiagnosticSchema, type VagRuntimeDiagnostic } from '@forgeax/editor-core/protocol';

/** Only named producer fields cross the carrier boundary; order retains the cause chain. */
export function bootDiagnostics(value: unknown): VagRuntimeDiagnostic[] {
  const result: VagRuntimeDiagnostic[] = [];
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value) || result.length >= 16) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const entry of value.slice(0, 16)) visit(entry, depth + 1); return; }
    const node = value as Record<string, unknown>;
    const detail = node.detail && typeof node.detail === 'object' ? node.detail as Record<string, unknown> : undefined;
    const parsed = VagRuntimeDiagnosticSchema.safeParse({
      diagnostic: node.diagnostic ?? detail?.diagnostic,
      phase: node.phase ?? detail?.phase,
      code: node.code, hint: node.hint, expected: node.expected ?? detail?.expected,
      actual: node.actual ?? detail?.actual,
      propertyPath: node.propertyPath ?? detail?.propertyPath,
      unexpectedSourceKeys: node.unexpectedSourceKeys ?? detail?.unexpectedSourceKeys,
      kindMismatches: node.kindMismatches ?? detail?.kindMismatches,
      sourceKey: node.sourceKey ?? detail?.sourceKey,
      missingGuids: node.missingGuids ?? detail?.missingGuids,
      undeclaredReferencedGuids: node.undeclaredReferencedGuids ?? detail?.undeclaredReferencedGuids,
      undeclaredReadGuids: node.undeclaredReadGuids ?? detail?.undeclaredReadGuids,
      sourcePath: node.sourcePath ?? detail?.sourcePath,
      unusedDeclaredGuids: node.unusedDeclaredGuids ?? detail?.unusedDeclaredGuids,
    });
    if (parsed.success) result.push(parsed.data);
    visit(node.cause, depth + 1);
    visit(detail?.cause, depth + 1);
    for (const entries of [node.diagnostics, detail?.diagnostics]) {
      if (Array.isArray(entries)) for (const entry of entries.slice(0, 16)) visit(entry, depth + 1);
    }
  }
  visit(value, 0);
  return result;
}

export class PlayBindingFailure extends Error {
  readonly retryable = false;
  readonly diagnostics: VagRuntimeDiagnostic[];
  readonly code: string;
  constructor(diagnostic: unknown) {
    const diagnostics = bootDiagnostics(diagnostic);
    const cause = diagnostics.at(-1);
    super(cause?.diagnostic || cause?.hint || cause?.code || 'The runtime catalog has a blocking diagnostic.');
    this.code = cause?.code ?? 'play-runtime-binding-failed';
    this.diagnostics = diagnostics;
  }
}
