import type {
  DetachedWindowCapability,
  DetachedWindowTarget,
  SurfaceDescriptor,
} from '../../lib/platform/surface';
import { surfaceKey } from '../../lib/platform/surface';

export interface OpenPanelWindowOptions {
  detachSurface: (
    surface: SurfaceDescriptor,
    options: { title: string; width: number; height: number; x?: number; y?: number },
  ) => Promise<boolean>;
  position?: { x: number; y: number };
  closeDockPanel?: () => void;
}

const detachedDockPanels = new Map<string, string>();

export interface PanelWindowingSources {
  basePanelIds: ReadonlySet<string>;
  baseWindowing: Readonly<Record<string, DetachedWindowCapability>>;
  pageWindowing: Readonly<Record<string, DetachedWindowCapability>>;
  injectedWindowing?: DetachedWindowCapability;
}

/** Whether the Page runtime survives the later BASE/editor component spreads. */
export function pageRuntimeOwnsPanel(
  panelId: string,
  basePanelIds: ReadonlySet<string>,
  editorPanelIds: readonly string[],
): boolean {
  if (basePanelIds.has(panelId)) return false;
  return !(panelId.startsWith('ep:') && editorPanelIds.includes(panelId.slice(3)));
}

/**
 * Resolve capability with the same ownership precedence as DockRegion's final
 * component map: editor ep:* is dock-only; BASE wins even when it deliberately
 * has no capability; only unclaimed ids may fall through Page → injected.
 */
export function resolvePanelWindowing(
  panelId: string,
  sources: PanelWindowingSources,
): DetachedWindowCapability | undefined {
  if (panelId.startsWith('ep:')) return undefined;
  if (sources.basePanelIds.has(panelId)) return sources.baseWindowing[panelId];
  return sources.pageWindowing[panelId] ?? sources.injectedWindowing;
}

export function canOpenPanelWindow(
  capability: DetachedWindowCapability | undefined,
  carrierAvailable: boolean,
): capability is DetachedWindowCapability {
  return capability !== undefined && carrierAvailable;
}

export function shouldShowDetachedPlaceholder(
  floatingSurfaces: Readonly<Record<string, true>>,
  surface: SurfaceDescriptor,
): boolean {
  return floatingSurfaces[surfaceKey(surface)] === true;
}

/**
 * The one high-level panel pop-out action used by every shell affordance.
 * It constructs the target, opens the physical carrier, and only then removes
 * an ordinary dock tab only when the target explicitly requests that behavior.
 */
export async function openPanelWindow(
  panelId: string,
  capability: DetachedWindowCapability | undefined,
  options: OpenPanelWindowOptions,
): Promise<boolean> {
  if (!capability) return false;

  let target: DetachedWindowTarget;
  try {
    target = capability.createTarget();
  } catch {
    return false;
  }

  let ok: boolean;
  try {
    ok = await options.detachSurface(target.surface, {
      title: target.title,
      width: target.width,
      height: target.height,
      ...options.position,
    });
  } catch {
    return false;
  }
  if (!ok) return false;

  if (target.dockBehavior === 'close') {
    detachedDockPanels.set(surfaceKey(target.surface), panelId);
    options.closeDockPanel?.();
  }
  return true;
}

/**
 * Resolve the dock placement restored by a window-close event. This is a lookup,
 * not a consume: every DockRegion receives the same close notification and the
 * region that owns the placement must be allowed to handle it.
 */
export function detachedDockPanelForSurface(surface: SurfaceDescriptor): string | undefined {
  const key = surfaceKey(surface);
  const panelId = detachedDockPanels.get(key);
  if (panelId) {
    queueMicrotask(() => {
      if (detachedDockPanels.get(key) === panelId) detachedDockPanels.delete(key);
    });
  }
  return panelId;
}
