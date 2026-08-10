export declare const EDITOR_CI_REPORT_SCHEMA_VERSION: 'forgeax-editor-ci-report/v1';

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
