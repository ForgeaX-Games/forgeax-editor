// Gateway project-validation contract.
//
// The Editor host owns the transport/provider that invokes the existing
// scripts/game-validation.mjs producer. Core owns only the public shape,
// bounded projection, and the provider seam; it never parses project files or
// recreates validator rules.

import type { OperationRun } from './operation-runs';
import type { RuntimeDiagnosticFact } from './diagnostics';
import type { CommandError } from '../types';

export const PROJECT_VALIDATION_OPERATION = 'validateGameProject' as const;
export const PROJECT_VALIDATION_SCHEMA_VERSION = 'project-validation/v1' as const;
export const PROJECT_VALIDATION_MAX_ISSUES = 128;

export interface ProjectValidationOptions {
  readonly maxBytes?: number;
  readonly maxEntities?: number;
}

export interface ProjectValidationIssue {
  readonly id: string;
  readonly severity: 'error' | 'warn';
  readonly code: string;
  readonly message: string;
  readonly location: { readonly kind: 'file'; readonly id: string };
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ProjectValidationStats {
  readonly bytes: number;
  readonly entities: number;
  readonly packs: number;
  readonly sidecars: number;
}

export interface ProjectValidationResult {
  readonly schemaVersion: typeof PROJECT_VALIDATION_SCHEMA_VERSION;
  /** True means the producer validator found no blocking issue. */
  readonly ok: boolean;
  /** The existing validator's blocking and warning rows, in producer order. */
  readonly issues: readonly ProjectValidationIssue[];
  readonly issueCount: number;
  readonly blockingCount: number;
  readonly warningCount: number;
  readonly truncated: boolean;
  readonly stats: ProjectValidationStats;
  readonly validator: 'scripts/game-validation.mjs';
}

export interface ProjectValidationProvider {
  /** Return the existing validator result; provider owns project access. */
  readonly validate: (options: ProjectValidationOptions) => Promise<unknown>;
}

export type ProjectValidationResultEnvelope =
  | { readonly ok: true; readonly result: ProjectValidationResult }
  | { readonly ok: false; readonly error: CommandError };

let activeProvider: ProjectValidationProvider | undefined;

export function registerProjectValidationProvider(provider: ProjectValidationProvider): () => void {
  const previous = activeProvider;
  activeProvider = provider;
  return () => {
    if (activeProvider === provider) activeProvider = previous;
  };
}

export function getProjectValidationProvider(): ProjectValidationProvider | undefined {
  return activeProvider;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function providerFailure(value: unknown): value is { readonly ok: false; readonly error: CommandError } {
  const candidate = record(value);
  const error = record(candidate?.error);
  return candidate?.ok === false && typeof error?.code === 'string' && typeof error?.hint === 'string';
}

function issueRow(value: unknown): { readonly file: string; readonly code: string; readonly message: string; readonly detail: Record<string, unknown> } | undefined {
  const candidate = record(value);
  if (typeof candidate?.file !== 'string' || typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return undefined;
  return {
    file: candidate.file,
    code: candidate.code,
    message: candidate.message,
    detail: record(candidate.detail) ?? {},
  };
}

function numberStat(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Normalize only the existing validator envelope; validation rules stay producer-owned. */
export function normalizeProjectValidationResult(value: unknown): ProjectValidationResultEnvelope {
  if (providerFailure(value)) return value;
  const raw = record(value);
  const blocking = raw?.blocking;
  const warnings = raw?.warnings;
  const stats = record(raw?.stats);
  if (typeof raw?.ok !== 'boolean' || !Array.isArray(blocking) || !Array.isArray(warnings) || stats === undefined) {
    return {
      ok: false,
      error: {
        code: 'project-validation-invalid-result',
        hint: 'The project validator returned an invalid result envelope.',
        retryable: false,
        recoveryActions: ['editor.discover'],
      },
    };
  }

  const rows: Array<{ readonly severity: 'error' | 'warn'; readonly row: NonNullable<ReturnType<typeof issueRow>> }> = [];
  for (const value of blocking) {
    const row = issueRow(value);
    if (row !== undefined) rows.push({ severity: 'error', row });
  }
  for (const value of warnings) {
    const row = issueRow(value);
    if (row !== undefined) rows.push({ severity: 'warn', row });
  }

  const occurrences = new Map<string, number>();
  const issues = rows.slice(0, PROJECT_VALIDATION_MAX_ISSUES).map(({ severity, row }) => {
    const key = `${severity}:${row.code}:${row.file}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return Object.freeze({
      id: `project-validation:${key}:${occurrence}`,
      severity,
      code: row.code,
      message: row.message,
      location: Object.freeze({ kind: 'file' as const, id: row.file }),
      detail: Object.freeze({ ...row.detail }),
    });
  });

  const bytes = numberStat(stats.bytes);
  const entities = numberStat(stats.entities);
  const packs = numberStat(stats.packs);
  const sidecars = numberStat(stats.sidecars);
  if (bytes === undefined || entities === undefined || packs === undefined || sidecars === undefined) {
    return {
      ok: false,
      error: {
        code: 'project-validation-invalid-result',
        hint: 'The project validator returned invalid project statistics.',
        retryable: false,
        recoveryActions: ['editor.discover'],
      },
    };
  }

  return {
    ok: true,
    result: Object.freeze({
      schemaVersion: PROJECT_VALIDATION_SCHEMA_VERSION,
      ok: raw.ok,
      issues: Object.freeze(issues),
      issueCount: rows.length,
      blockingCount: blocking.length,
      warningCount: warnings.length,
      truncated: rows.length > PROJECT_VALIDATION_MAX_ISSUES,
      stats: Object.freeze({ bytes, entities, packs, sidecars }),
      validator: 'scripts/game-validation.mjs' as const,
    }),
  };
}

/** Derive human diagnostics from the same terminal run result exposed to AI callers. */
export function projectValidationDiagnostics(runs: readonly OperationRun[]): readonly RuntimeDiagnosticFact[] {
  const facts: RuntimeDiagnosticFact[] = [];
  // OperationRun.sequence is local to each run, so recency is the terminal
  // completion time; the input order breaks same-clock-tick ties.
  const latestTerminal = runs
    .filter((run) => run.operationId === PROJECT_VALIDATION_OPERATION
      && (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'))
    .reduce<OperationRun | undefined>((latest, run) => {
      if (latest === undefined) return run;
      const runAt = run.completedAt ?? run.acceptedAt;
      const latestAt = latest.completedAt ?? latest.acceptedAt;
      return runAt >= latestAt ? run : latest;
    }, undefined);
  if (latestTerminal?.status !== 'succeeded') return Object.freeze(facts);
  const result = record(latestTerminal.result);
  if (result?.schemaVersion !== PROJECT_VALIDATION_SCHEMA_VERSION || result.ok !== false) return Object.freeze(facts);
  const issues = result.issues;
  if (!Array.isArray(issues)) return Object.freeze(facts);
  for (const issueValue of issues) {
    const issue = record(issueValue);
    const location = record(issue?.location);
    if (typeof issue?.id !== 'string' || (issue?.severity !== 'error' && issue?.severity !== 'warn')
      || typeof issue.code !== 'string' || typeof issue.message !== 'string'
      || location?.kind !== 'file' || typeof location.id !== 'string') continue;
    facts.push(Object.freeze({
      id: `${latestTerminal.runId}:${issue.id}`,
      severity: issue.severity,
      code: issue.code,
      title: location.id,
      message: issue.message,
      path: location.id,
      ...(latestTerminal.requestId === undefined ? {} : { requestId: latestTerminal.requestId }),
      subjectRef: Object.freeze({ kind: 'source-file', id: location.id }),
      retryable: false,
      recoveryActions: Object.freeze(['run.get']),
      detail: Object.freeze({ runId: latestTerminal.runId, operationId: latestTerminal.operationId, issue: issueValue }),
    }));
  }
  return Object.freeze(facts);
}
