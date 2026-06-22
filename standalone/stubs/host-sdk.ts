// Standalone stub for @forgeax/host-sdk.
//
// host-sdk is a studio-layer package that powers the wb:* workbench-plugin
// iframe RPC channel. That feature is studio-only and never renders in the
// editor standalone shell (:15290), which mounts just <DockShell>. But the
// interface module graph statically reaches StandalonePluginIframe (via
// CenterPluginLayer → KeepAlivePluginIframes), so the import must resolve even
// though host-sdk is not part of a standalone editor clone.
//
// editor/vite.config.ts aliases '@forgeax/host-sdk' to this stub ONLY when the
// studio tree is absent (standalone). The functions throw if ever invoked —
// which cannot happen in standalone because no plugin iframe is mounted.

function unavailable(name: string): never {
  throw new Error(
    `[@forgeax/host-sdk stub] ${name}() is not available in the editor standalone shell. ` +
      'Workbench plugin (wb:*) panels are a studio-only feature.',
  );
}

export function createPluginPort(): never {
  return unavailable('createPluginPort');
}

export function createWindowTransport(): never {
  return unavailable('createWindowTransport');
}
