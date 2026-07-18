// discoverer-errors.ts — structured error objects for module discovery (M4 w22).
//
// Fail-fast + partial-success errors with .code / .expected / .hint for
// property-access consumption (charter P3, plan-strategy D-4).
//
// Anchors:
//   plan-strategy D-4: structured errors aligned with engine GameProjectError / PackError
//   charter P3: explicit failure — .code machine-branch, .expected/.hint for humans/AI

/** Structured error from module discovery — property-access consumption, not string parsing. */
export interface DiscoverError extends Error {
  /** Machine-readable error code (e.g. 'DUPLICATE_COMPONENT'). */
  readonly code: string;
  /** Human-friendly description of what was expected. */
  readonly expected: string;
  /** Actionable repair hint for humans/AI agents. */
  readonly hint: string;
  /** Source file (pack-relative) the error came from; set for import failures. */
  readonly relPath?: string;
}

/** Error codes produced by the discoverer. */
export const DiscoverErrorCode = {
  DUPLICATE_COMPONENT: 'DUPLICATE_COMPONENT',
  DUPLICATE_SYSTEM: 'DUPLICATE_SYSTEM',
  MODULE_IMPORT_FAILED: 'MODULE_IMPORT_FAILED',
} as const;
