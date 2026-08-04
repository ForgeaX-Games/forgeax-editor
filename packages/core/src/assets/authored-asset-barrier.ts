// assets/authored-asset-barrier — the canonical post-write catalog visibility
// barrier for freshly authored pack assets (createMaterial above all).
//
// A pack write resolving means the BYTES landed; it does NOT mean the asset is
// consumable: the vite-plugin-pack watcher rebuilds the served pack-index
// asynchronously, and the registry's packFileCache may still hold the PRE-WRITE
// pack body. Binding against the fresh GUID in that window loadByGuid-misses on
// the DDC path and falls back to the import transport — POST /__import/{guid}
// 404s for internal materials (that route serves external import sources
// only), the exact gray-card cascade this barrier exists to prevent.
//
// Three phases, each with hard proof before the next:
//   1. ROW  — refreshCatalog until the pack-index row exists AND carries a
//      non-empty packageUrl (`packIndexCache.has(guid)` alone proves nothing
//      about the pack BODY; a stale row can linger from a previous rebuild).
//   2. BODY — fetch the package body DIRECTLY until it contains the GUID.
//      Never call loadByGuid before this phase passes: a body-miss inside
//      loadByGuid is what triggers the erroneous /__import fallback.
//   3. LOAD — invalidate the registry's cached pack body for the row's
//      packageUrl (it may predate the write), then loadByGuid until success.
//      packFileInFlight can still resolve one attempt from a stale in-flight
//      fetch, so this phase retries rather than trusting a single call.
//
// Single SSOT: ViewportComponent registers the hook built here, and the
// authored-material-persistence integration test drives the same code path.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

export interface AuthoredAssetCatalogBarrierOptions {
  /** Overall deadline for all three phases (ms). Default 5000. */
  readonly deadlineMs?: number;
  /** Poll interval while waiting for the pack-index row (ms). Default 100. */
  readonly rowPollMs?: number;
  /** Poll/retry interval for the body + load phases (ms). Default 150. */
  readonly bodyPollMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createAuthoredAssetCatalogBarrier(
  registry: AssetRegistry,
  opts: AuthoredAssetCatalogBarrierOptions = {},
): (guid: string) => Promise<void> {
  const deadlineMs = opts.deadlineMs ?? 5000;
  const rowPollMs = opts.rowPollMs ?? 100;
  const bodyPollMs = opts.bodyPollMs ?? 150;

  return async (guid: string): Promise<void> => {
    const key = guid.toLowerCase();
    const deadline = Date.now() + deadlineMs;

    // Phase 1 — pack-index ROW.
    let packageUrl: string | null = null;
    while (Date.now() < deadline) {
      await registry.refreshCatalog?.().catch(() => false);
      const row = registry.packIndexCache?.get(key);
      if (row && typeof row.packageUrl === 'string' && row.packageUrl.length > 0) {
        packageUrl = row.packageUrl;
        break;
      }
      await sleep(rowPollMs);
    }
    if (packageUrl === null) {
      throw new Error(`Asset catalog did not expose imported GUID ${guid} (pack-index row with packageUrl) before the visibility deadline.`);
    }

    // Phase 2 — pack BODY contains the GUID (direct fetch, no loadByGuid).
    const bodyContainsGuid = async (): Promise<boolean> => {
      try {
        const r = await fetch(packageUrl, { cache: 'no-store' });
        if (!r.ok) return false;
        const body = (await r.json()) as { assets?: { guid?: unknown }[] };
        return Array.isArray(body.assets) && body.assets.some((a) => typeof a?.guid === 'string' && a.guid.toLowerCase() === key);
      } catch {
        return false;
      }
    };
    let bodyVisible = false;
    while (Date.now() < deadline) {
      if (await bodyContainsGuid()) { bodyVisible = true; break; }
      await sleep(bodyPollMs);
    }
    if (!bodyVisible) {
      throw new Error(`Asset catalog row ${guid} was visible but the pack body at ${packageUrl} never contained the asset before the visibility deadline.`);
    }

    // Phase 3 — registry LOAD succeeds from the (re-fetched) Pack v2 body.
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) return;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      registry.packFileCache?.delete(packageUrl);
      const loaded = await registry.loadByGuid(parsed.value);
      if (loaded.ok) return;
      lastError = loaded.error?.code ?? 'unknown';
      await sleep(bodyPollMs);
    }
    throw new Error(`Asset catalog row ${guid} was visible and present in ${packageUrl} but loadByGuid never succeeded (last load error: ${lastError ?? 'unknown'}).`);
  };
}
