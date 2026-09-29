/** DEV-only structured probes for Play iframe boot — filter console with `[play-boot-diag]`. */
export type PlayBootDiagSnapshot = Record<string, unknown>;

const snapshot: PlayBootDiagSnapshot = { phase: 'init' };

function playBootDiagEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  const raw =
    (typeof import.meta.env.FORGEAX_PLAY_BOOT_DIAG === 'string'
      ? import.meta.env.FORGEAX_PLAY_BOOT_DIAG
      : undefined) ??
    (typeof process !== 'undefined'
      ? process.env.FORGEAX_PLAY_BOOT_DIAG
      : undefined);
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw.trim());
}

export function playBootDiag(phase: string, detail: Record<string, unknown>): void {
  if (!playBootDiagEnabled()) return;
  console.info(`[play-boot-diag] ${phase} ${JSON.stringify(detail)}`);
}

export function playBootDiagMark(phase: string, detail: Record<string, unknown>): void {
  Object.assign(snapshot, { phase, ...detail, at: new Date().toISOString() });
  playBootDiag(phase, detail);
}

export function installPlayBootDiagProbe(): void {
  if (!playBootDiagEnabled()) return;
  Object.defineProperty(window, '__forgeaxPlayBootDiag', {
    configurable: true,
    enumerable: false,
    value: () => ({ ...snapshot }),
  });
}
