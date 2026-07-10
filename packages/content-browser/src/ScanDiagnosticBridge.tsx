// ScanDiagnosticBridge.tsx — bridge scan diagnostics to Info Log panel (G5).
//
// After the startup scan completes, this component pushes accumulated
// diagnostics (validation errors, import warnings) to the existing health
// store that powers the Info Panel (Blender-INFO-editor-style log).
//
// Plan v2 H4-5: Registers as a diagnostics consumer on mount so that
// the scan-hmr-bridge can push diagnostics from Node-side scan directly
// to the healthStore without core depending on content-browser.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G5

import { useEffect, type FC } from 'react';
import type { ScanDiagnostic } from '@forgeax/editor-core';
import { registerScanDiagnosticsConsumer } from '@forgeax/editor-core';
import { pushHealth } from '@forgeax/interface/components/StatusBar/healthStore';

/** Map scan diagnostic severity to health level. */
function toHealthLevel(severity: ScanDiagnostic['severity']): 'warn' | 'error' {
  return severity === 'error' ? 'error' : 'warn';
}

/** Push a batch of scan diagnostics into the Info Log health store. */
export function pushScanDiagnostics(diagnostics: ScanDiagnostic[]): void {
  for (const diag of diagnostics) {
    pushHealth({
      level: toHealthLevel(diag.severity),
      source: 'edit' as const,
      code: diag.code,
      message: `${diag.file}: ${diag.message}${diag.suggestion ? ` (${diag.suggestion})` : ''}`,
    });
  }
}

/** React component that pushes diagnostics on mount AND registers as a consumer
 *  for WS-pushed diagnostics from the Node-side startup scan (Plan v2 H4-5).
 *  Must be rendered inside a component tree near the app root. */
export const ScanDiagnosticBridge: FC<{ diagnostics: ScanDiagnostic[] }> = ({ diagnostics }) => {
  useEffect(() => {
    if (diagnostics.length > 0) {
      pushScanDiagnostics(diagnostics);
    }
  }, [diagnostics]);

  // Plan v2 H4-5: Register as consumer so scan-hmr-bridge can push
  // diagnostics from the Node-side scan to healthStore without a reverse
  // dependency (core → content-browser).
  useEffect(() => {
    registerScanDiagnosticsConsumer(pushScanDiagnostics);
    // No cleanup — the consumer should persist for the lifetime of the app
  }, []);

  return null;
};
