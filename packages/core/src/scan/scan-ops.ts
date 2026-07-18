// scan/scan-ops.ts — register scan pipeline session appliers (G4, revised).
//
// After review (2026-07-10): scan runs in Node side. Browser-side appliers
// only handle ledger entries and broadcast operations. The actual import/reimport
// work happens in vite-plugin-pack; these appliers reflect the results into
// the browser's ledger for AI/human observability.
//
// anchivers:
//   todo: 2026-07-09 startup-asset-scan-auto-import G4
//   north-star §6/§8: session domain, LEDGER ONLY, AI parity

import { sessionAppliers } from '../io/appliers';
import { broadcastAssetsChanged } from '../store/assets-changed';

sessionAppliers.set('assetCatalogRefreshed', () => {
  // Post-scan: refresh the asset catalog in the browser.
  broadcastAssetsChanged();
  return { ok: true };
});

sessionAppliers.set('assetReimported', () => {
  // Single-file reimport: mark catalog as changed so the browser re-fetches.
  broadcastAssetsChanged('pack-changed');
  return { ok: true };
});

sessionAppliers.set('assetOrphanDetected', () => {
  // Orphan detected: broadcast so UI can show warnings.
  broadcastAssetsChanged();
  return { ok: true };
});

// assetValidationFailed applier: diagnostics are written to the ledger for
// consumers that explicitly invoke this editor operation.
sessionAppliers.set('assetValidationFailed', () => {
  // Diagnostics are in the op payload — consumer layers (Info Log, AI) read
  // the ledger entry. No core→interface import needed.
  return { ok: true };
});

sessionAppliers.set('requestReimport', (op) => {
  const { paths } = op as { paths: string[] };
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: { code: 'INVALID_ARGS', hint: 'paths required' } };
  }
  // requestReimport is a session op that signals the dev server to reimport.
  // Send a POST to the dev server's /api/scan/reimport endpoint, which triggers
  // the vite-plugin-pack to reimport the specified files (Plan v2 H6).
  fetch('/api/scan/reimport', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  }).catch((err) => {
    console.warn('[scan-ops] requestReimport fetch failed:', err);
  });
  return { ok: true };
});
