/**
 * FatalBanner — the "reason + Reload" banner pinned to the top of a Play / Edit
 * region when the engine reports a region-fatal failure (device-lost, scene
 * instantiate failed, WebGPU init failed, missing module, …).
 *
 * Why this is its OWN component (not part of the bottom status bar):
 * the latest-state indicator + full log moved to the GlobalStatusBar chip + the
 * Info dock panel, so the wide HealthStatusBar strip was retired. The fatal
 * banner is a DIFFERENT concern — it must sit OVER the black viewport so the
 * user knows why Play / Edit is empty and can recover in one click — so it is
 * extracted here and mounted by the Play / Edit surface wrappers
 * (SurfacePanels), independent of the bottom strip.
 *
 * Data: the per-region `fatal` channel of healthStore (promoted there by
 * push() when an error matches FATAL_CODES / FATAL_TEXT_PATTERNS). Pure
 * presentation; the `.preview-fatal-banner` styling lives in MainArea.css and
 * is shared by both regions.
 */

import { AlertOctagon, RotateCcw, X } from 'lucide-react';
import { useHealthStore, type HealthSource } from './healthStore';

/** Reason → human title. Falls back to a generic line. */
function titleFor(code: string | undefined, source: HealthSource): string {
  switch (code) {
    case 'device-lost':
    case 'context-lost':
      return 'GPU device lost';
    case 'scene-instantiate-failed':
      return 'Scene failed to load';
    case 'webgpu-init-failed':
      return 'WebGPU init failed';
    case 'module-missing':
      return 'Module missing';
    case 'load-timeout':
      return 'Load timed out';
    case 'createApp-failed':
      return 'Engine failed to start';
    default:
      return `${source === 'edit' ? 'Edit' : 'Play'} failed`;
  }
}

/**
 * Banner for one region. Renders nothing when that region has no live fatal.
 * `source` is 'play' or 'edit' — the only two regions that surface a banner.
 */
export function FatalBanner({ source }: { source: 'play' | 'edit' }) {
  const fatal = useHealthStore((s) => s.fatal[source]);
  const clearFatal = useHealthStore((s) => s.clearFatal);
  if (!fatal) return null;

  return (
    <div className="preview-fatal-banner" role="alert" aria-live="assertive">
      <AlertOctagon className="pfb-icon" size={16} />
      <div className="pfb-body">
        <div className="pfb-title">{titleFor(fatal.code, source)}</div>
        <div className="pfb-msg" title={fatal.message}>{fatal.message}</div>
      </div>
      <button
        type="button"
        className="pfb-retry"
        title="Reload the page to recover this region"
        onClick={() => window.location.reload()}
      >
        <RotateCcw size={13} /> Reload
      </button>
      <button
        type="button"
        className="pfb-retry pfb-dismiss"
        title="Dismiss this banner"
        aria-label="Dismiss"
        onClick={() => clearFatal(source)}
      >
        <X size={13} />
      </button>
    </div>
  );
}
