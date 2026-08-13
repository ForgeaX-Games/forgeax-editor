export declare const EDITOR_CI_REPORT_SCHEMA_VERSION: 'forgeax-editor-ci-report/v1';

export type EditorCiPrerequisiteValidation = {
  readonly status: 'pass' | 'failure';
  readonly consumer: string;
  readonly payloadClasses?: readonly string[];
  readonly code?: string;
  readonly failedField?: string;
  readonly expected?: unknown;
  readonly observed?: unknown;
  readonly affectedConsumer?: string;
  readonly artifactId?: string | null;
  readonly hint?: string;
};

export type EditorCiPrerequisiteRelease = {
  readonly artifactId: string;
  readonly releaseDigest: string;
  readonly schemaVersion: string;
  readonly producerRunId: string;
  readonly producerAttempt: number;
  readonly sourceSha: string;
  readonly recursivePins: readonly { readonly path: string; readonly pin: string }[];
  readonly producerSuccess: boolean;
  readonly compatibility: { readonly status: string; readonly expected?: unknown; readonly observed?: unknown };
  readonly validation: EditorCiPrerequisiteValidation;
};

export type EditorCiReport = {
  readonly $schema: typeof EDITOR_CI_REPORT_SCHEMA_VERSION;
  readonly prerequisiteRelease: EditorCiPrerequisiteRelease | null;
  readonly [key: string]: unknown;
};

export declare function projectEditorCiReport(envelope: unknown): EditorCiReport;

export declare function validateEditorCiReport(
  report: unknown,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly expected: unknown;
        readonly observed: unknown;
        readonly hint: string;
      };
    };
