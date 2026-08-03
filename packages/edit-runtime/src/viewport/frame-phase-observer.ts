// frame-phase-observer — opt-in bridge from the engine frame loop to browser
// User Timing. The engine owns the phase vocabulary and emits boundaries; the
// editor only exposes them when the performance diagnostic harness explicitly
// enables the global switch before app creation.

import type { FramePhaseObserver } from '@forgeax/engine-app';
import type { RenderPhaseObserver } from '@forgeax/engine-render';

const DIAGNOSTICS_KEY = '__forgeaxFramePhaseDiagnostics';

interface FramePhaseDiagnosticsConfig {
  readonly enabled?: boolean;
}

type DiagnosticGlobal = typeof globalThis & {
  readonly __forgeaxFramePhaseDiagnostics?: FramePhaseDiagnosticsConfig;
};

/**
 * Creates the browser-side observer used by the performance evidence tool.
 *
 * The default is deliberately undefined: normal editor and game sessions do
 * not allocate an observer or emit User Timing marks. The global is a
 * diagnostic transport flag, not a product setting, and must be installed by
 * the harness before the page boots.
 */
export function createFramePhaseObserver(): FramePhaseObserver | undefined {
  const diagnosticGlobal = globalThis as DiagnosticGlobal;
  if (diagnosticGlobal[DIAGNOSTICS_KEY]?.enabled !== true) return undefined;

  const performanceApi = globalThis.performance;
  if (performanceApi === undefined || typeof performanceApi.mark !== 'function') {
    return undefined;
  }

  return {
    onEvent(event) {
      try {
        performanceApi.mark(
          `forgeax.frame.phase.${event.frameSeq}.${event.phase}.${event.boundary}`,
        );
      } catch {
        // Diagnostics must not change the editor's frame-loop behavior.
      }
    },
  };
}

/**
 * Creates the companion observer for engine RenderSystem stages. It shares the
 * same opt-in transport and User Timing policy as frame phases, while keeping
 * the render-owned vocabulary in `@forgeax/engine-render`.
 */
export function createRenderPhaseObserver(): RenderPhaseObserver | undefined {
  const diagnosticGlobal = globalThis as DiagnosticGlobal;
  if (diagnosticGlobal[DIAGNOSTICS_KEY]?.enabled !== true) return undefined;

  const performanceApi = globalThis.performance;
  if (performanceApi === undefined || typeof performanceApi.mark !== 'function') {
    return undefined;
  }

  return {
    onEvent(event) {
      try {
        const skipReason = event.boundary === 'skip' ? `.${event.skipReason}` : '';
        performanceApi.mark(
          `forgeax.render.phase.${event.frameSeq}.${event.phase}.${event.boundary}${skipReason}`,
        );
      } catch {
        // Diagnostics must not change the editor's frame-loop behavior.
      }
    },
  };
}
