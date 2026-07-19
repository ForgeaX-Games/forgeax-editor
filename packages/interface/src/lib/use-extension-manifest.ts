import { useEffect, useState } from 'react';
import { listExtensionsShared, type ExtensionInfo } from './extension-api';

/** A plugin has two identities: the canonical manifest id (`@forgeax-extension/
 *  wb-observatory`, the bus SSOT) and the short workbench id (`wb-observatory`,
 *  the UI-facing alias). Callers open plugins by either form — the sidebar
 *  passes the manifest id, while `workbench.open_plugin` / deep links often pass
 *  the workbench id. Resolution must accept both, else opening by the alias
 *  never finds the manifest and the panel falls to "Could not load plugin".
 *  A third accepted form: persisted dock layouts written before the Extension
 *  rename (ADR 0025 M3) carry `@forgeax-plugin/*` in the user's localStorage —
 *  normalize at this single match point (same sanctioned compat exception as
 *  the kernel scanner's id normalize). */
export function manifestMatchesId(m: ExtensionInfo, id: string): boolean {
  const norm = id.replace(/^@forgeax-plugin\//, '@forgeax-extension/');
  return m.id === norm || m.workbench?.id === norm;
}

/** Fetches the bus manifest for a single plugin id, with retry/polling so a
 *  transient miss (busy server, manifest still settling, bus reload window)
 *  self-heals instead of leaving the panel stuck until the user switches tabs.
 *
 *  - First attempt rides the shared 2s cache → instant on tab switch-back.
 *  - Subsequent attempts force a fresh fetch (every POLL_MS) so a manifest that
 *    just gained `entry.standalone` is picked up live.
 *  - Polling stops once we have a usable manifest (standalone present) or after
 *    MAX_ATTEMPTS (the plugin genuinely ships no standalone entry — e.g. the
 *    inline wb-plugin-author panel — so there is nothing more to wait for).
 *
 *  Extracted from WorkbenchExtensionHost so the keep-alive CenterExtensionLayer can
 *  share one implementation (single source of truth for manifest resolution).
 */
export function useExtensionManifest(extensionId: string): ExtensionInfo | null | 'loading' {
  const [info, setInfo] = useState<ExtensionInfo | null | 'loading'>('loading');
  useEffect(() => {
    if (!extensionId) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const MAX_ATTEMPTS = 15; // ~22s at POLL_MS — covers cold start / scan windows
    const POLL_MS = 1500;
    setInfo('loading');

    const tick = async () => {
      attempts += 1;
      try {
        const res = await listExtensionsShared({ force: attempts > 1 });
        if (cancelled) return;
        const found = res.items.find((p) => manifestMatchesId(p, extensionId)) ?? null;
        setInfo(found);
        if (found?.entry?.standalone || attempts >= MAX_ATTEMPTS) return;
      } catch {
        if (cancelled) return;
        if (attempts >= MAX_ATTEMPTS) {
          setInfo(null);
          return;
        }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [extensionId]);
  return info;
}
