/**
 * Stale-HMR compatibility shim — new code imports logImport from import-registry.
 * Do not add new exports here; keep this file as a re-export barrel only.
 */
import { logImport, getImportRegistrySnapshot } from './import-registry';

export { logImport, getImportRegistrySnapshot };

export function logAcceptSnapshot(step: string, accept: string, extra?: Record<string, unknown>): void {
  logImport(step, { ...extra, accept, hasFbx: accept.includes('.fbx') });
}
