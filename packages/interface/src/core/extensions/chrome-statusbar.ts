// packages/interface/src/core/extensions/chrome-statusbar.ts
//
// ADR-0030 §2.4 — interface's status-bar registry. Every footer chip that lives
// UNDER interface is registered HERE, inside interface, through the single
// panels channel: health / dev surface overlay, the project-version &
// diagnostics popovers, and the BUS/MB/RES/… pulse feeds. This extension is
// auto-loaded by appHostBootstrap, so the product assembler (studio/root) never
// imports or lists any of these chips — the imports converge inside interface.
// Third-party plugins register their own footer chips the same way: their
// extension's `contributes.panels.stripItems`, no root edit required.
import type { AppExtension } from '../app-shell/types';
import type { StatusItemContribution } from '../panels';
import { healthStatusItem } from '../../components/StatusBar/HealthIndicator';
import { surfaceOverlayStatusItem } from '../../components/Surfaces/SurfaceOverlay';
import { pulseStatusItems } from '../../components/StatusBar/feeds/PulseFeeds';
import { projectVersionStatusItem } from '../../components/StatusBar/footer/ProjectVersionPopover';
import { diagnosticsStatusItem } from '../../components/StatusBar/footer/DiagnosticsPopover';

/** Fold an ordered list of status items into the keyed `stripItems` record the
 *  derive step sub-merges per id. Exported so product assemblers reuse it. */
export function toStripItems(
  items: readonly StatusItemContribution[],
): Record<string, StatusItemContribution> {
  const out: Record<string, StatusItemContribution> = {};
  for (const it of items) out[it.id] = it;
  return out;
}

export const chromeStatusBarExtension: AppExtension = {
  id: 'chrome.statusbar',
  version: '1.0.0',
  contributes: {
    panels: {
      stripItems: toStripItems([
        projectVersionStatusItem,
        diagnosticsStatusItem,
        healthStatusItem,
        surfaceOverlayStatusItem,
        ...pulseStatusItems,
      ]),
    },
  },
};
