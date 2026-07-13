// scan/scan-hmr-bridge.ts — browser-side HMR listener for scan WS signals (G4+G6).
//
// After review (2026-07-10 承重B): scan runs in Node-side vite-plugin-pack.
// The dev server emits WebSocket signals across three phases:
//   forgeax:scan-started  → browser locks gateway
//   forgeax:scan-progress → browser updates progress overlay
//   forgeax:scan-done     → browser unlocks gateway + refreshes catalog
//
// Additional runtime signals (G6):
//   forgeax:assetReimported  → single file reimported at runtime
//   forgeax:assetOrphanDetected → source file deleted during runtime
//
// Plan v2 additions:
//   forgeax:scan-validation      → dispatch assetValidationFailed op (H4)
//   complex-format paths delivered inside scan-done.needBrowserImport (H5)
//
// Race: Node may emit scan-done before the browser installs HMR listeners.
// GET /__pack/scan-done replays the last payload on bridge install.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G4+G6

import type { ScanDiagnostic } from './scan-diagnostic';
import { gateway, broadcastAssetsChanged } from '../store/store';
import { updateScanProgress, resetScanProgress } from './scan-progress';

// ── Diagnostics consumer (H4-5) ───────────────────────────────────────
// Content-browser's ScanDiagnosticBridge registers a callback here so
// that scan-validation diagnostics from the Node side get pushed into
// the Info Log healthStore. This avoids a core → content-browser import.

type DiagnosticsConsumer = (diagnostics: ScanDiagnostic[]) => void;
let _diagnosticsConsumer: DiagnosticsConsumer | null = null;

/** Register a consumer that receives scan diagnostics (called by ScanDiagnosticBridge). */
export function registerScanDiagnosticsConsumer(fn: DiagnosticsConsumer): void {
  _diagnosticsConsumer = fn;
}

function pushDiagnostics(diagnostics: ScanDiagnostic[]): void {
  if (_diagnosticsConsumer) {
    try { _diagnosticsConsumer(diagnostics); } catch { /* best-effort */ }
  }
}

// ── Browser-import consumer (H5) ──────────────────────────────────────
// Content-browser's useStartupScan registers a callback so that complex-
// format paths (glb/gltf/fbx needing WASM parse) from the Node-side scan
// get routed to the browser import pipeline AFTER gateway is unlocked.
// Without this indirection, the signal would arrive while scanLocked=true
// and be rejected by the gateway dispatch guard.

type BrowserImportConsumer = (paths: string[], basePath: string) => void;
let _browserImportConsumer: BrowserImportConsumer | null = null;
/** Queued when scan-done arrives before useStartupScan registers the consumer. */
let _pendingBrowserImport: string[] | null = null;

/** Register a consumer that imports complex-format files from disk (called by useStartupScan). */
export function registerBrowserImportConsumer(fn: BrowserImportConsumer): void {
  _browserImportConsumer = fn;
  console.info('[scan-hmr] registerBrowserImportConsumer OK');
  if (_pendingBrowserImport && _pendingBrowserImport.length > 0) {
    const paths = _pendingBrowserImport;
    _pendingBrowserImport = null;
    console.info(`[scan-hmr] flushing queued needBrowserImport paths=${paths.length}`);
    triggerBrowserImport(paths, '');
  }
}

function triggerBrowserImport(paths: string[], basePath: string): void {
  if (paths.length === 0) return;
  if (!_browserImportConsumer) {
    _pendingBrowserImport = paths;
    console.warn(
      `[scan-hmr] triggerBrowserImport: consumer NULL — queued paths=${paths.length} until registerBrowserImportConsumer`,
    );
    return;
  }
  console.info(`[scan-hmr] triggerBrowserImport paths=${paths.length} base=${basePath || '(per-dir)'}`, paths.slice(0, 8));
  try {
    _browserImportConsumer(paths, basePath);
  } catch (err) {
    console.warn('[scan-hmr] triggerBrowserImport consumer threw:', err);
  }
}

// ── Signal data shapes (from vite-plugin-pack) ───────────────────────────────

interface ScanStartedData {
  totalFiles: number;
}

interface ScanProgressData {
  phase: 'scanning' | 'generating-meta' | 'importing';
  current: number;
  total: number;
  currentFile: string;
}

interface ScanDoneData {
  added: string[];
  reimported: string[];
  removed: string[];
  errors: number;
  /** Complex-format files (glb/gltf/fbx) needing browser-side WASM import (H5). */
  needBrowserImport?: string[];
}

interface AssetReimportedData {
  path: string;
  reason: 'content-changed' | 'importer-upgraded' | 'ddc-missing';
}

interface AssetOrphanDetectedData {
  sourcePath: string;
  metaPath: string;
}

// ── Vite HMR type augmentation ───────────────────────────────────────────────

interface ViteHotContext {
  on(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
}

/** Dedup key so WS + GET /__pack/scan-done replay do not double-import. */
let _handledScanDoneKey: string | null = null;

function scanDoneKey(d: ScanDoneData): string {
  return JSON.stringify({
    added: d.added ?? [],
    need: d.needBrowserImport ?? [],
    errors: d.errors ?? 0,
  });
}

/**
 * Apply a scan-done payload (from WS or GET /__pack/scan-done race replay).
 * Idempotent for identical payloads within the session.
 */
export function applyScanDonePayload(data: unknown, source: 'ws' | 'http-replay' = 'ws'): void {
  const d = data as ScanDoneData | undefined;
  if (!d) {
    console.warn(`[scan-hmr] applyScanDonePayload(${source}): empty payload`);
    return;
  }
  const key = scanDoneKey(d);
  if (key === _handledScanDoneKey) {
    console.info(`[scan-hmr] applyScanDonePayload(${source}): skip duplicate`);
    return;
  }
  _handledScanDoneKey = key;

  const need = d.needBrowserImport?.length ?? 0;
  console.info(
    `[scan-hmr] ← scan-done via ${source} added=${d.added?.length ?? 0} reimported=${d.reimported?.length ?? 0} ` +
    `removed=${d.removed?.length ?? 0} errors=${d.errors ?? 0} needBrowserImport=${need}`,
    '_diag' in d ? (d as { _diag?: unknown })._diag : undefined,
  );

  gateway.unlockAfterScan();
  broadcastAssetsChanged();
  resetScanProgress();

  try {
    gateway.dispatch({
      kind: 'assetCatalogRefreshed',
      added: d.added ?? [],
      removed: d.removed ?? [],
      reimported: d.reimported ?? [],
    } as never, 'scan' as never);
  } catch (err) {
    console.warn('[scan-hmr] assetCatalogRefreshed dispatch failed:', err);
  }

  if (d.needBrowserImport && d.needBrowserImport.length > 0) {
    // Empty basePath → consumer groups by dirname(path) so meta lands next to source.
    triggerBrowserImport(d.needBrowserImport, '');
  } else {
    console.info('[scan-hmr] needBrowserImport empty — no browser WASM import this round');
  }
}

/** Fetch last scan-done from Node (covers WS race when browser mounts late). */
export async function replayLastScanDone(): Promise<void> {
  try {
    const res = await fetch('/__pack/scan-done');
    if (res.status === 204) {
      console.info('[scan-hmr] GET /__pack/scan-done → 204 (not ready)');
      return;
    }
    if (!res.ok) {
      console.warn(`[scan-hmr] GET /__pack/scan-done → ${res.status}`);
      return;
    }
    const data: unknown = await res.json();
    applyScanDonePayload(data, 'http-replay');
  } catch (err) {
    console.warn('[scan-hmr] GET /__pack/scan-done failed:', err);
  }
}

/** Install all scan HMR listeners. Returns a dispose function. */
export function installScanHmrBridge(): () => void {
  const hot = (import.meta as unknown as { hot?: ViteHotContext }).hot;
  if (!hot) {
    console.warn('[scan-hmr] installScanHmrBridge: import.meta.hot missing — WS signals will NOT be received');
    // Still try HTTP replay so startup import can proceed without HMR.
    void replayLastScanDone();
    return () => {};
  }
  console.info('[scan-hmr] installScanHmrBridge: listening for forgeax:scan-* / asset* events');

  const onScanStarted = (data: unknown): void => {
    const d = data as ScanStartedData;
    console.info('[scan-hmr] ← forgeax:scan-started', d);
    gateway.lockForScan();
    updateScanProgress({
      phase: 'scanning',
      current: 0,
      total: d?.totalFiles ?? 0,
      currentFile: 'Scan starting...',
      errors: [],
    });
  };

  const onScanProgress = (data: unknown): void => {
    const d = data as ScanProgressData;
    if (d) {
      console.info(`[scan-hmr] ← forgeax:scan-progress phase=${d.phase} ${d.current}/${d.total} file=${d.currentFile}`);
      updateScanProgress({
        phase: d.phase,
        current: d.current,
        total: d.total,
        currentFile: d.currentFile,
      });
    }
  };

  const onScanDone = (data: unknown): void => {
    applyScanDonePayload(data, 'ws');
  };

  const onAssetReimported = (data: unknown): void => {
    const d = data as AssetReimportedData;
    console.info('[scan-hmr] ← forgeax:assetReimported', d);
    if (d?.path) {
      broadcastAssetsChanged('pack-changed');
      try {
        gateway.dispatch({
          kind: 'assetReimported',
          path: d.path,
          guid: 'unknown',
          reason: d.reason ?? 'content-changed',
        } as never, 'scan' as never);
      } catch { /* ignore */ }
    }
  };

  const onAssetOrphan = (data: unknown): void => {
    const d = data as AssetOrphanDetectedData;
    console.info('[scan-hmr] ← forgeax:assetOrphanDetected', d);
    if (d?.sourcePath) {
      try {
        gateway.dispatch({
          kind: 'assetOrphanDetected',
          sourcePath: d.sourcePath,
          metaPath: d.metaPath ?? '',
        } as never, 'scan' as never);
      } catch { /* ignore */ }
    }
  };

  // Runtime asset-changed signal from vite-plugin-pack (sidecar meta.json write).
  // Replaces full-reload — Content Browser refreshes incrementally without page reload.
  const onAssetChanged = (data: unknown): void => {
    const d = data as { file?: string; event?: string; kind?: 'sidecar' | 'source' };
    console.info(`[scan-hmr] ← forgeax:asset-changed kind=${d?.kind} file=${d?.file}`);
    if (d?.kind === 'sidecar') {
      broadcastAssetsChanged('pack-changed');
    }
  };

  // Plan v2 H4: validation diagnostics from Node-side scan
  const onScanValidation = (data: unknown): void => {
    const d = data as { diagnostics?: ScanDiagnostic[] };
    console.info(`[scan-hmr] ← forgeax:scan-validation diagnostics=${d?.diagnostics?.length ?? 0}`);
    if (d?.diagnostics && d.diagnostics.length > 0) {
      pushDiagnostics(d.diagnostics);
      try {
        gateway.dispatch({
          kind: 'assetValidationFailed',
          diagnostics: d.diagnostics,
        } as never, 'scan' as never);
      } catch { /* ignore */ }
    }
  };

  hot.on('forgeax:scan-started', onScanStarted);
  hot.on('forgeax:scan-progress', onScanProgress);
  hot.on('forgeax:scan-done', onScanDone);
  hot.on('forgeax:scan-validation', onScanValidation);
  hot.on('forgeax:assetReimported', onAssetReimported);
  hot.on('forgeax:assetOrphanDetected', onAssetOrphan);
  hot.on('forgeax:asset-changed', onAssetChanged);

  // Race replay: if Node already finished startup scan before we subscribed.
  void replayLastScanDone();

  return () => {
    hot.off('forgeax:scan-started', onScanStarted);
    hot.off('forgeax:scan-progress', onScanProgress);
    hot.off('forgeax:scan-done', onScanDone);
    hot.off('forgeax:scan-validation', onScanValidation);
    hot.off('forgeax:assetReimported', onAssetReimported);
    hot.off('forgeax:assetOrphanDetected', onAssetOrphan);
    hot.off('forgeax:asset-changed', onAssetChanged);
  };
}
