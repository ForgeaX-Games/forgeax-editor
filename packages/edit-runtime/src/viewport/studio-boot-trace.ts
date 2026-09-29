/** DEV-only breadcrumbs for Studio ▶ Play boot — filter console with `[studio-boot-trace]`. */

export type StudioBootTraceSnapshot = Record<string, unknown>;

const snapshot: StudioBootTraceSnapshot = { phase: 'init' };
const STAGES: string[] = [];

function studioBootTraceEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  const raw =
    (typeof import.meta.env.FORGEAX_STUDIO_BOOT_TRACE === 'string'
      ? import.meta.env.FORGEAX_STUDIO_BOOT_TRACE
      : undefined) ??
    (typeof globalThis !== 'undefined'
      ? (globalThis as Record<string, unknown>).FORGEAX_STUDIO_BOOT_TRACE
      : undefined);
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim());
}

export function studioBootTrace(stage: string, detail: Record<string, unknown> = {}): void {
  if (!studioBootTraceEnabled()) return;
  const entry = { stage, ...detail, at: new Date().toISOString() };
  Object.assign(snapshot, entry);
  STAGES.push(stage);
  console.info(`[studio-boot-trace] ${stage} ${JSON.stringify(detail)}`);
}

export function studioBootTraceSession(detail: Record<string, unknown>): void {
  studioBootTrace('viewport.session', detail);
}

export function installStudioBootTraceProbe(): void {
  if (!studioBootTraceEnabled()) return;
  Object.defineProperty(window, '__forgeaxStudioBootTrace', {
    configurable: true,
    enumerable: false,
    value: () => ({ snapshot: { ...snapshot }, stages: [...STAGES] }),
  });
}
