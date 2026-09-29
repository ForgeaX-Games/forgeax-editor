import { studioBootTrace } from './studio-boot-trace';

/** Window flags set by Studio SurfaceKeepAliveLayer; standalone leaves them unset. */
export const VIEWPORT_HOST_GATE_FLAG = '__forgeax_viewport_host_gate';
export const VIEWPORT_HOST_READY_FLAG = '__forgeax_viewport_host_ready';
export const VIEWPORT_HOST_READY_EVENT = 'forgeax-viewport-host-ready';

function readWindowFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as Record<string, unknown>)[key] === true;
}

/** Studio shells can mount the viewport ref before the panel is in the document tree. */
export async function waitUntilDomConnected(
  element: HTMLElement,
  isActive: () => boolean,
  maxFrames = 120,
): Promise<boolean> {
  if (element.isConnected) {
    studioBootTrace('viewport.dom.connected', { immediate: true });
    return true;
  }
  studioBootTrace('viewport.dom.wait', { maxFrames });
  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (!isActive()) return false;
    if (element.isConnected) {
      studioBootTrace('viewport.dom.connected', { frames: frame + 1 });
      return true;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  const connected = element.isConnected;
  studioBootTrace('viewport.dom.timeout', { connected, maxFrames });
  return connected;
}

/**
 * When the host enables the gate, boot waits until the keep-alive overlay reports
 * layout readiness. Standalone never sets the gate and returns immediately.
 */
export async function waitForHostSurfaceGate(
  isActive: () => boolean,
  maxFrames = 240,
): Promise<boolean> {
  if (!readWindowFlag(VIEWPORT_HOST_GATE_FLAG)) {
    studioBootTrace('viewport.host-gate.skip', { reason: 'gate-disabled' });
    return true;
  }
  if (readWindowFlag(VIEWPORT_HOST_READY_FLAG)) {
    studioBootTrace('viewport.host-gate.ready', { immediate: true });
    return true;
  }
  studioBootTrace('viewport.host-gate.wait', { maxFrames });
  for (let frame = 0; frame < maxFrames; frame += 1) {
    if (!isActive()) return false;
    if (readWindowFlag(VIEWPORT_HOST_READY_FLAG)) {
      studioBootTrace('viewport.host-gate.ready', { frames: frame + 1 });
      return true;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  const ready = readWindowFlag(VIEWPORT_HOST_READY_FLAG);
  studioBootTrace('viewport.host-gate.timeout', { ready, maxFrames });
  return ready;
}

/** StrictMode remount: stale boot on a detached container must be replaced. */
export function shouldSupersedeStaleViewportBoot(
  bootStarted: boolean,
  activeContainer: HTMLDivElement | null,
  nextContainer: HTMLDivElement,
): boolean {
  if (!bootStarted || activeContainer === null) return false;
  if (activeContainer === nextContainer) return false;
  return !activeContainer.isConnected;
}
