export declare const EDITOR_CI_REPORT_SCHEMA_VERSION: 'forgeax-editor-ci-report/v1';

export type EditorCiPortabilityStage =
  | 'checkout'
  | 'install'
  | 'setup'
  | 'wasm'
  | 'zero-binary'
  | 'type-static'
  | 'capability-probe'
  | 'smoke';

export type EditorCiPortabilityPlatform = {
  /** Target operating system: linux, windows, or macos. */
  readonly os: 'linux' | 'windows' | 'macos';
  /** Target runner architecture recorded by the native producer. */
  readonly architecture: string;
  /** Hosted image or self-hosted runner identity. */
  readonly runnerImage: string;
  /** Observed identities from the canonical native toolchain commands. */
  readonly toolchain: EditorCiToolchain;
};

export type EditorCiRequiredPortabilityStage = Exclude<EditorCiPortabilityStage, 'capability-probe' | 'smoke'>;

type EditorCiCapabilityFacts = {
  /** Actual headed/headless/browser mode selected for smoke. */
  readonly browserMode?: string;
  /** Actual browser channel used by the probe. */
  readonly browserChannel?: string;
  /** Actual graphics backend observed by the probe. */
  readonly backend: string | null;
  /** Explicit navigator.gpu, adapter, and device observations. */
  readonly navigatorGpu: boolean;
  readonly adapter: boolean;
  readonly device: boolean;
  /** Observed adapter feature list, including an empty list. */
  readonly features: readonly string[];
};

export type EditorCiCapability =
  | (EditorCiCapabilityFacts & {
      /** Capability facts authorize the supported smoke path. */
      readonly result: 'supported';
      /** Supported smoke has concrete browser and backend identities. */
      readonly browserMode: string;
      readonly browserChannel: string;
      readonly backend: string;
    })
  | (EditorCiCapabilityFacts & {
      /** Capability is unavailable, but the bounded skip is fact-backed. */
      readonly result: 'bounded-non-applicable';
      /** Bounded capability boundary when the smoke path is unavailable. */
      readonly boundary: string;
      /** Executable recovery action for an unavailable capability. */
      readonly hint: string;
    })
  | {
      /** A required portability stage failed before capability facts existed. */
      readonly result: 'not-applicable';
      /** Required stage that produced this failure projection. */
      readonly stage: EditorCiRequiredPortabilityStage;
    };

export type EditorCiMatrixTerminalResult = {
  /** Native platform that produced this terminal unit. */
  readonly platform: EditorCiPortabilityPlatform['os'];
  /** Logical portability stage represented by this unit. */
  readonly stage: EditorCiPortabilityStage;
  /** Terminal status from the shared report vocabulary. */
  readonly terminalStatus: 'pass' | 'failure' | 'skipped';
  /** Source SHA observed by the native producer for this terminal unit. */
  readonly sourceSha: string;
};

export type EditorCiProvenance = {
  readonly kind: string;
  readonly timingDomain: string;
  readonly recursivePins?: readonly { readonly path: string; readonly pin: string }[];
  readonly [key: string]: unknown;
};

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

export type EditorCiToolchain = Readonly<{
  readonly bun: string;
  readonly bunRevision: string;
  readonly node: string;
  readonly pnpm: string;
  readonly rust: string;
  readonly wasmPack: string;
  readonly emscripten: string;
}>;

export declare const EDITOR_CI_ORDINARY_CHECK_IDS: readonly [
  'b2-self-boot',
  'typecheck',
  'r0-hierarchy-ui-editability',
  'r0-sample-vfx-skill',
  'r0-engine-dogfood-diagnostics',
  'submodule-pin',
  'smoke-play',
];

export type EditorCiOrdinaryCheckId = (typeof EDITOR_CI_ORDINARY_CHECK_IDS)[number];

/** Local aggregate report discriminator; it is not an additional contract check. */
export declare const EDITOR_CI_LOCAL_PROFILE_CHECK_ID: 'ci-profile';

export type EditorCiLocalProfileCheckId = typeof EDITOR_CI_LOCAL_PROFILE_CHECK_ID;
export type EditorCiReportCheckId = EditorCiOrdinaryCheckId | EditorCiLocalProfileCheckId;

export type EditorCiReportBase = {
  readonly $schema: typeof EDITOR_CI_REPORT_SCHEMA_VERSION;
  readonly prerequisiteRelease: EditorCiPrerequisiteRelease | null;
  readonly contractVersion: string;
  readonly checkId: EditorCiReportCheckId;
  readonly owner: string;
  readonly profile: string;
  readonly executionHome: string;
  readonly provenance: EditorCiProvenance;
  /** Shared terminal classification used by every report consumer. */
  readonly terminalStatus: 'pass' | 'failure' | 'skipped';
  /** Shared failure class; structured recovery fields accompany failures. */
  readonly failureClass: 'admission' | 'environment' | 'source' | 'external-transport' | null;
  /** Stable machine-readable first failure record. */
  readonly firstFailure: unknown;
  /** Ordered attempt records, including the first failed attempt. */
  readonly attempts: readonly unknown[];
  readonly code: string | null;
  readonly expected: unknown;
  readonly observed: unknown;
  readonly hint: string | null;
  readonly sloClaim: string | null;
  readonly [key: string]: unknown;
};

export type EditorCiPortabilityPlatformMatrix = {
  /** A single native platform's terminal stage projection. */
  readonly kind: 'platform';
  readonly sourceSha: string;
  readonly platforms: readonly EditorCiPortabilityPlatform['os'][];
  readonly terminalResults: readonly EditorCiMatrixTerminalResult[];
};

export type EditorCiPortabilityAggregateMatrix = {
  /** The same-run aggregate of all native platform terminal reports. */
  readonly kind: 'aggregate';
  readonly sourceSha: string;
  readonly platforms: readonly EditorCiPortabilityPlatform['os'][];
  readonly terminalResults: readonly EditorCiMatrixTerminalResult[];
  readonly workflowRunId: number;
  readonly workflowRunAttempt: number;
  readonly platformReports: readonly {
    readonly platform: EditorCiPortabilityPlatform['os'];
    readonly sourceSha: string;
    readonly reports: readonly EditorCiPortabilityStageReport[];
  }[];
};

export type EditorCiMatrix = EditorCiPortabilityPlatformMatrix | EditorCiPortabilityAggregateMatrix;

export type EditorCiPortabilityStageReport = Omit<EditorCiReportBase, 'checkId'> & {
  readonly checkId: 'editor-portability';
  /** Exact source checkout SHA for this native platform stage. */
  readonly sourceSha: string;
  /** Native platform and toolchain facts for this stage. */
  readonly platform: EditorCiPortabilityPlatform;
  /** Logical stage represented by this report. */
  readonly stage: EditorCiPortabilityStage;
  /** Runtime browser and graphics capability facts. */
  readonly capability: EditorCiCapability | null;
  /** Single-platform matrix projection for this stage. */
  readonly matrix: EditorCiPortabilityPlatformMatrix;
};

export type EditorCiPortabilityAggregateReport = Omit<EditorCiReportBase, 'checkId'> & {
  readonly checkId: 'editor-portability';
  /** Exact source checkout SHA shared by the native matrix. */
  readonly sourceSha: string;
  /** Same-run aggregate matrix projection. */
  readonly matrix: EditorCiPortabilityAggregateMatrix;
};

export type EditorCiPortabilityReport = EditorCiPortabilityStageReport | EditorCiPortabilityAggregateReport;

export type EditorCiReport = EditorCiReportBase | EditorCiPortabilityReport;

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
