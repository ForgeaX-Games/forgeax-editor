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
  /** Overall deadline for all three phases (ms). Default 15000. */
  readonly deadlineMs?: number;
  /** Poll interval while waiting for the pack-index row (ms). Default 100. */
  readonly rowPollMs?: number;
  /** Poll/retry interval for the body + load phases (ms). Default 150. */
  readonly bodyPollMs?: number;
}

export interface AuthoredAssetPublicationExpectation {
  /** The catalog revision must differ from the pre-mutation row when present. */
  readonly previousRevision?: string;
  /** The current publication locator must differ from the pre-operation row when present. */
  readonly previousPublication?: Partial<{
    readonly generation: number;
    readonly digest: string;
    readonly outputSetDigest: string;
    readonly packageUrl: string;
    readonly receiptKey: string;
  }>;
  /** The row must expose a producer-owned current publication locator. */
  readonly requireCurrentPublication?: boolean;
  /** When supplied, the current publication locator must match these fields. */
  readonly currentPublication?: Partial<{
    readonly generation: number;
    readonly digest: string;
    readonly outputSetDigest: string;
    readonly packageUrl: string;
    readonly receiptKey: string;
  }>;
}

interface CatalogRevisionFacts {
  readonly revision?: unknown;
  readonly lifecycle?: unknown;
  readonly publication?: unknown;
}

function revisionDigest(row: CatalogRevisionFacts | undefined): string | undefined {
  if (row === undefined) return undefined;
  if (typeof row.revision === 'string') return row.revision;
  if (row.revision === null || typeof row.revision !== 'object') return undefined;
  const digest = (row.revision as { readonly digest?: unknown }).digest;
  return typeof digest === 'string' ? digest : undefined;
}

function publicationLocator(row: CatalogRevisionFacts | undefined): Record<string, unknown> | undefined {
  if (row?.publication === null || typeof row?.publication !== 'object') return undefined;
  const current = (row.publication as { readonly current?: unknown }).current;
  return current !== null && typeof current === 'object'
    ? current as Record<string, unknown>
    : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type VisibleCatalogRow = CatalogRevisionFacts & {
  readonly packageUrl?: unknown;
  readonly kind?: unknown;
  readonly name?: unknown;
};

function ensurePackIndexRow(registry: AssetRegistry, key: string, row: VisibleCatalogRow): void {
  if (typeof row.packageUrl !== 'string' || row.packageUrl.length === 0) return;
  if (typeof row.kind !== 'string' || row.kind.length === 0) return;
  if (registry.packIndexCache === undefined) registry.packIndexCache = new Map();
  registry.packIndexCache.set(key, {
    packageUrl: row.packageUrl,
    kind: row.kind,
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
  });
}

async function packBodyContainsGuid(packageUrl: string, key: string): Promise<boolean> {
  try {
    const response = await fetch(packageUrl, { cache: 'no-store' });
    if (!response.ok) return false;
    const body = (await response.json()) as { assets?: { guid?: unknown }[] };
    return Array.isArray(body.assets)
      && body.assets.some((asset) => typeof asset?.guid === 'string' && asset.guid.toLowerCase() === key);
  } catch {
    return false;
  }
}

/** Resolve a catalog row candidate; callers must prove the pack body before pinning cache. */
function resolveVisibleCatalogRow(registry: AssetRegistry, key: string): VisibleCatalogRow | undefined {
  const cached = registry.packIndexCache?.get(key) as VisibleCatalogRow | undefined;
  if (cached !== undefined && typeof cached.packageUrl === 'string' && cached.packageUrl.length > 0) {
    return cached;
  }
  const snapshotRow = registry.catalogSnapshot?.()?.entries.find(
    (entry) => entry.guid.toLowerCase() === key,
  );
  if (
    snapshotRow !== undefined &&
    typeof snapshotRow.packageUrl === 'string' &&
    snapshotRow.packageUrl.length > 0
  ) {
    return snapshotRow;
  }
  const listed = registry.listCatalog().find((entry) => entry.guid.toLowerCase() === key);
  if (listed !== undefined && typeof listed.packageUrl === 'string' && listed.packageUrl.length > 0) {
    return listed;
  }
  return undefined;
}

function rowMatchesExpectation(
  row: VisibleCatalogRow,
  expectation: AuthoredAssetPublicationExpectation,
): boolean {
  const currentRevision = revisionDigest(row);
  const currentPublication = publicationLocator(row);
  const revisionChanged =
    expectation.previousRevision === undefined ||
    currentRevision !== undefined && currentRevision !== expectation.previousRevision;
  const publicationChanged =
    expectation.previousPublication === undefined ||
    currentPublication === undefined ||
    Object.entries(expectation.previousPublication).some(
      ([field, previous]) => currentPublication[field] !== previous,
    );
  const publicationMatches =
    expectation.requireCurrentPublication !== true && expectation.currentPublication === undefined
      ? true
      : currentPublication !== undefined &&
        Object.entries(expectation.currentPublication ?? {}).every(
          ([field, expected]) => currentPublication[field] === expected,
        );
  const lifecycleMatches =
    (expectation.requireCurrentPublication !== true && expectation.currentPublication === undefined) ||
    row.lifecycle === 'current';
  return (
    typeof row.packageUrl === 'string' &&
    row.packageUrl.length > 0 &&
    revisionChanged &&
    publicationChanged &&
    publicationMatches &&
    lifecycleMatches
  );
}

export function createAuthoredAssetCatalogBarrier(
  registry: AssetRegistry,
  opts: AuthoredAssetCatalogBarrierOptions = {},
): (guid: string, expectation?: AuthoredAssetPublicationExpectation) => Promise<void> {
  // This is one shared deadline across row publication, direct body proof, and
  // the registry reload. Five seconds was enough on a warm workstation but
  // left the LOAD phase with no useful budget on cold, software-GPU CI after
  // the watcher and pack-index consumed the first phases. Keep explicit short
  // deadlines available to focused tests while giving the real three-stage
  // cold path a bounded window that matches its contract.
  const deadlineMs = opts.deadlineMs ?? 15_000;
  const rowPollMs = opts.rowPollMs ?? 100;
  const bodyPollMs = opts.bodyPollMs ?? 150;

  return async (
    guid: string,
    expectation: AuthoredAssetPublicationExpectation = {},
  ): Promise<void> => {
    const key = guid.toLowerCase();
    const deadline = Date.now() + deadlineMs;

    // Phase 1 — pack-index ROW plus pack BODY proof. CatalogReplica can retain a
    // stale imported row (e.g. deleted test-material sidecar → /__forgeax-ddc/
    // 404) while the authored Materials.pack.json row is still rebuilding. Never
    // pin packIndexCache until the body fetch proves the GUID is present.
    let packageUrl: string | null = null;
    await sleep(Math.min(rowPollMs, 200));
    while (Date.now() < deadline) {
      const row = resolveVisibleCatalogRow(registry, key);
      if (row !== undefined && rowMatchesExpectation(row, expectation)) {
        const candidateUrl = row.packageUrl as string;
        if (await packBodyContainsGuid(candidateUrl, key)) {
          packageUrl = candidateUrl;
          ensurePackIndexRow(registry, key, row);
          break;
        }
        registry.packIndexCache?.delete(key);
      }
      if (registry.catalogSnapshot?.()?.stale === true) {
        await registry.reconcileCatalog?.().catch(() => undefined);
      } else {
        await registry.refreshCatalog?.().catch(() => false);
      }
      await sleep(rowPollMs);
    }
    if (packageUrl === null) {
      throw new Error(`Asset catalog did not expose imported GUID ${guid} (pack-index row with packageUrl) before the visibility deadline.`);
    }

    // Phase 3 — registry LOAD succeeds from the (re-fetched) Pack v2 body.
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) return;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      registry.packFileCache?.delete(packageUrl);
      const loaded = await registry.loadByGuid(parsed.value);
      if (loaded.ok) {
        // A lazy Meta import can publish its authoritative catalog row while
        // loadByGuid is fetching the pack body. Refresh once after that load
        // so the operation completion and gateway.assetCatalog() observe the
        // same publication, rather than ending on the pre-import snapshot.
        await registry.refreshCatalog?.().catch(() => false);
        return;
      }
      lastError = loaded.error?.code ?? 'unknown';
      await sleep(bodyPollMs);
    }
    throw new Error(`Asset catalog row ${guid} was visible and present in ${packageUrl} but loadByGuid never succeeded (last load error: ${lastError ?? 'unknown'}).`);
  };
}
