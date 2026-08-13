import {
  buildProfileModel,
  compareProfileCaptures,
  type ProfileComparisonError as EngineProfileComparisonError,
  type ProfileComparisonPhaseDelta as EngineProfileComparisonPhaseDelta,
  type ProfileComparisonPhaseFact as EngineProfileComparisonPhaseFact,
  type ProfileComparisonPhaseIdentity as EngineProfileComparisonPhaseIdentity,
  type ProfileComparisonPhaseRow as EngineProfileComparisonPhaseRow,
  type ProfileComparisonSide as EngineProfileComparisonSide,
  type ProfileSummaryModel,
} from '@forgeax/engine-profiler';
import { OperationRunSchema, type OperationRun } from '@forgeax/editor-product';

export type ProfileComparisonPhaseIdentity = EngineProfileComparisonPhaseIdentity;
export type ProfileComparisonPhaseFact = EngineProfileComparisonPhaseFact;
export type ProfileComparisonPhaseDelta = EngineProfileComparisonPhaseDelta;
export type ProfileComparisonPhaseRow = EngineProfileComparisonPhaseRow;

export type ProfileComparisonSummary = ProfileSummaryModel & {
  readonly runId: string;
  readonly requestId?: string;
  readonly operationId: string;
};

export interface ProfileComparisonOperationRunError {
  readonly code:
    | 'operation-run-invalid'
    | 'operation-run-not-succeeded'
    | 'operation-run-result-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly issues?: readonly string[];
    readonly status?: OperationRun['status'];
  };
}

export type ProfileComparisonEngineError = EngineProfileComparisonError;

export type ProfileComparisonError =
  | ProfileComparisonOperationRunError
  | ProfileComparisonEngineError;

export interface ProfileComparisonSide {
  readonly run?: OperationRun;
  readonly summary?: ProfileComparisonSummary;
  readonly error?: ProfileComparisonError;
}

export interface ProfileComparisonProjection {
  readonly left: ProfileComparisonSide;
  readonly right: ProfileComparisonSide;
  readonly phases: readonly ProfileComparisonPhaseRow[];
}

interface ProjectedSide {
  readonly side: ProfileComparisonSide;
  readonly result?: unknown;
}

type ProfileArtifactError = Omit<EngineProfileComparisonError, 'detail'> & {
  readonly detail: Omit<EngineProfileComparisonError['detail'], 'side'>;
};

function operationRunError(
  code: ProfileComparisonOperationRunError['code'],
  expected: string,
  hint: string,
  detail: ProfileComparisonOperationRunError['detail'],
): ProfileComparisonOperationRunError {
  return Object.freeze({
    code,
    expected,
    hint,
    detail: Object.freeze({
      ...(detail.issues === undefined ? {} : { issues: Object.freeze([...detail.issues]) }),
      ...(detail.status === undefined ? {} : { status: detail.status }),
    }),
  });
}

function withEngineSide(
  side: 'left' | 'right',
  error: ProfileArtifactError,
): ProfileComparisonEngineError {
  return Object.freeze({
    ...error,
    detail: Object.freeze({ ...error.detail, side }),
  });
}

function summaryForRun(
  run: OperationRun,
  summary: ProfileSummaryModel,
): ProfileComparisonSummary {
  return Object.freeze({
    ...summary,
    runId: run.runId,
    ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
    operationId: run.operationId,
    completeness: Object.freeze({ ...summary.completeness }),
  });
}

function projectSide(side: 'left' | 'right', input: unknown): ProjectedSide {
  const parsed = OperationRunSchema.safeParse(input);
  if (!parsed.success) {
    return {
      side: Object.freeze({
        error: operationRunError(
          'operation-run-invalid',
          'a schema-valid OperationRun export',
          'Select an exported OperationRun JSON artifact before comparing.',
          { issues: parsed.error.issues },
        ),
      }),
    };
  }

  const run = parsed.data;
  if (run.status !== 'succeeded') {
    return {
      side: Object.freeze({
        run,
        error: operationRunError(
          'operation-run-not-succeeded',
          'a succeeded terminal OperationRun',
          'Select a succeeded terminal OperationRun export before comparing.',
          { status: run.status },
        ),
      }),
    };
  }
  if (run.result === undefined) {
    return {
      side: Object.freeze({
        run,
        error: operationRunError(
          'operation-run-result-missing',
          'a succeeded OperationRun with a result',
          'Select an OperationRun export that contains its terminal result.',
          {},
        ),
      }),
    };
  }

  const modeled = buildProfileModel(run.result);
  if (!modeled.ok) {
    return {
      side: Object.freeze({ run, error: withEngineSide(side, modeled.error) }),
    };
  }

  return {
    side: Object.freeze({ run, summary: summaryForRun(run, modeled.value.summary) }),
    result: run.result,
  };
}

function sideWithComparisonSummary(
  prepared: ProjectedSide,
  comparison: EngineProfileComparisonSide,
): ProfileComparisonSide {
  const run = prepared.side.run;
  if (run === undefined) return prepared.side;
  return Object.freeze({
    run,
    summary: summaryForRun(run, comparison.summary),
  });
}

function sideWithComparisonError(
  prepared: ProjectedSide,
  error: EngineProfileComparisonError,
): ProfileComparisonSide {
  return Object.freeze({
    ...prepared.side,
    error: Object.freeze({ ...error, detail: Object.freeze({ ...error.detail }) }),
  });
}

/** Purely compares two imported OperationRun artifacts without mutating or reserializing them. */
export function projectProfileComparison(
  left: unknown,
  right: unknown,
): ProfileComparisonProjection {
  const leftProjection = projectSide('left', left);
  const rightProjection = projectSide('right', right);

  if (leftProjection.result === undefined || rightProjection.result === undefined) {
    return Object.freeze({
      left: leftProjection.side,
      right: rightProjection.side,
      phases: Object.freeze([]),
    });
  }

  const compared = compareProfileCaptures(leftProjection.result, rightProjection.result);

  if (!compared.ok) {
    return Object.freeze({
      left: compared.error.detail.side === 'left'
        ? sideWithComparisonError(leftProjection, compared.error)
        : leftProjection.side,
      right: compared.error.detail.side === 'right'
        ? sideWithComparisonError(rightProjection, compared.error)
        : rightProjection.side,
      phases: Object.freeze([]),
    });
  }

  return Object.freeze({
    left: sideWithComparisonSummary(leftProjection, compared.value.left),
    right: sideWithComparisonSummary(rightProjection, compared.value.right),
    phases: compared.value.phases,
  });
}
