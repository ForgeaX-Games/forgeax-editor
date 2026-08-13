import {
  buildProfileModel,
  type ProfileCapture,
  type ProfileModel,
  type ProfilePhaseModel,
} from '@forgeax/engine-profiler';
import { OperationRunSchema, type OperationRun } from '@forgeax/editor-product';

export interface ProfileComparisonPhaseIdentity {
  readonly source: ProfilePhaseModel['source'];
  readonly phase: string;
  readonly parentSource?: ProfilePhaseModel['parentSource'];
  readonly parentPhase?: string;
}

export interface ProfileComparisonPhaseFact {
  readonly count: number;
  readonly skipCount: number;
  readonly p95DurationMicros: number | null;
}

export interface ProfileComparisonPhaseDelta {
  readonly count?: number;
  readonly skipCount?: number;
  readonly p95DurationMicros?: number;
}

export interface ProfileComparisonPhaseRow {
  readonly identity: ProfileComparisonPhaseIdentity;
  readonly left?: ProfileComparisonPhaseFact;
  readonly right?: ProfileComparisonPhaseFact;
  readonly delta?: ProfileComparisonPhaseDelta;
}

export interface ProfileComparisonSummary {
  readonly runId: string;
  readonly requestId?: string;
  readonly operationId: string;
  readonly captureId: string;
  readonly timeUnit: ProfileCapture['timeUnit'];
  readonly completeness: ProfileCapture['completeness'];
  readonly frameCount: number;
  readonly recordCount: number;
  readonly phaseCount: number;
  readonly skipCount: number;
  readonly p95DurationMicros: number | null;
}

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

export interface ProfileComparisonEngineError {
  readonly code: 'profile-artifact-invalid' | 'profile-artifact-incompatible';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly message: string };
}

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
  readonly model?: ProfileModel;
}

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

function projectSide(input: unknown): ProjectedSide {
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
      side: Object.freeze({ run, error: Object.freeze({ ...modeled.error }) }),
    };
  }

  const summary = modeled.value.summary;
  return {
    side: Object.freeze({
      run,
      summary: Object.freeze({
        runId: run.runId,
        ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
        operationId: run.operationId,
        captureId: summary.captureId,
        timeUnit: summary.timeUnit,
        completeness: Object.freeze({ ...summary.completeness }),
        frameCount: summary.frameCount,
        recordCount: summary.recordCount,
        phaseCount: summary.phaseCount,
        skipCount: summary.skipCount,
        p95DurationMicros: summary.p95DurationMicros,
      }),
    }),
    model: modeled.value,
  };
}

function phaseKey(phase: ProfilePhaseModel): string {
  return JSON.stringify([
    phase.source,
    phase.parentSource ?? null,
    phase.parentPhase ?? null,
    phase.phase,
  ]);
}

function phaseIdentity(phase: ProfilePhaseModel): ProfileComparisonPhaseIdentity {
  return Object.freeze({
    source: phase.source,
    phase: phase.phase,
    ...(phase.parentSource === undefined ? {} : { parentSource: phase.parentSource }),
    ...(phase.parentPhase === undefined ? {} : { parentPhase: phase.parentPhase }),
  });
}

function phaseFact(phase: ProfilePhaseModel): ProfileComparisonPhaseFact {
  return Object.freeze({
    count: phase.count,
    skipCount: phase.skipCount,
    p95DurationMicros: phase.p95DurationMicros,
  });
}

function phaseDelta(
  left: ProfileComparisonPhaseFact | undefined,
  right: ProfileComparisonPhaseFact | undefined,
  comparableTimeUnit: boolean,
): ProfileComparisonPhaseDelta | undefined {
  if (left === undefined || right === undefined) return undefined;
  const delta: {
    count?: number;
    skipCount?: number;
    p95DurationMicros?: number;
  } = {
    count: right.count - left.count,
    skipCount: right.skipCount - left.skipCount,
  };
  if (
    comparableTimeUnit
    && left.p95DurationMicros !== null
    && right.p95DurationMicros !== null
  ) {
    delta.p95DurationMicros = right.p95DurationMicros - left.p95DurationMicros;
  }
  return Object.freeze(delta);
}

function projectPhases(left: ProjectedSide, right: ProjectedSide): readonly ProfileComparisonPhaseRow[] {
  const leftByKey = new Map((left.model?.phases ?? []).map((phase) => [phaseKey(phase), phase]));
  const rightByKey = new Map((right.model?.phases ?? []).map((phase) => [phaseKey(phase), phase]));
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const comparableTimeUnit = left.side.summary?.timeUnit !== undefined
    && left.side.summary.timeUnit === right.side.summary?.timeUnit;

  return Object.freeze(keys.map((key) => {
    const leftPhase = leftByKey.get(key);
    const rightPhase = rightByKey.get(key);
    const leftFact = leftPhase === undefined ? undefined : phaseFact(leftPhase);
    const rightFact = rightPhase === undefined ? undefined : phaseFact(rightPhase);
    const identity = phaseIdentity(leftPhase ?? rightPhase as ProfilePhaseModel);
    const delta = phaseDelta(leftFact, rightFact, comparableTimeUnit);
    return Object.freeze({
      identity,
      ...(leftFact === undefined ? {} : { left: leftFact }),
      ...(rightFact === undefined ? {} : { right: rightFact }),
      ...(delta === undefined ? {} : { delta }),
    });
  }));
}

/** Purely compares two imported OperationRun artifacts without mutating or reserializing them. */
export function projectProfileComparison(
  left: unknown,
  right: unknown,
): ProfileComparisonProjection {
  const leftProjection = projectSide(left);
  const rightProjection = projectSide(right);
  return Object.freeze({
    left: leftProjection.side,
    right: rightProjection.side,
    phases: projectPhases(leftProjection, rightProjection),
  });
}
