import type { OperationRun } from '@forgeax/editor-product';

/** Serialize the authoritative terminal snapshot without projecting or reshaping it. */
export function serializeOperationRun(run: OperationRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

export function operationRunFilename(runId: string): string {
  const safeRunId = runId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
  return `operation-run-${safeRunId}.json`;
}

/** Trigger a browser download for one existing OperationRun snapshot. */
export function downloadOperationRun(run: OperationRun): void {
  const blob = new Blob([serializeOperationRun(run)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = operationRunFilename(run.runId);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(href), 0);
}
