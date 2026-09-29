import {
  gateway,
  isSourcePackageCatalogVisible,
  registerPostSourcePackageCatalogSync,
  sourcePathMatchesCatalogExpectation,
  type SourcePackageCatalogExpectation,
  type SourcePackageCatalogRow,
} from '@forgeax/editor-core';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';

/** Safety net — import should finish once triggerCook + consumable load succeed. */
const SOURCE_PACKAGE_CATALOG_DEADLINE_MS = 15_000;

function catalogEntries(): readonly SourcePackageCatalogRow[] {
  return gateway.assetCatalog() as readonly SourcePackageCatalogRow[];
}

function producerGuid(expectation: SourcePackageCatalogExpectation): string | undefined {
  const rows = catalogEntries();
  const producer = rows.find((row) => (
    typeof row.sourcePath === 'string'
    && row.projection?.subject === 'imported-output'
    && row.lifecycle === 'current'
    && sourcePathMatchesCatalogExpectation(row.sourcePath, expectation)
  ));
  if (producer !== undefined) return producer.guid;
  if (expectation.packageGuid !== undefined) return expectation.packageGuid;
  return expectation.subAssetGuids[0];
}

async function loadByGuidOk(registry: AssetRegistry, guid: string): Promise<boolean> {
  try {
    const parsed = registry.parseGuid(guid);
    const loaded = await registry.loadByGuid(parsed);
    if (loaded !== null && typeof loaded === 'object' && 'ok' in loaded) {
      return (loaded as { readonly ok: boolean }).ok === true;
    }
    return loaded !== null && loaded !== undefined;
  } catch {
    return false;
  }
}

async function importReady(
  registry: AssetRegistry,
  expectation: SourcePackageCatalogExpectation,
): Promise<boolean> {
  if (!isSourcePackageCatalogVisible(catalogEntries(), expectation)) return false;
  const guid = producerGuid(expectation);
  if (guid === undefined) return true;
  return loadByGuidOk(registry, guid);
}

async function awaitSourcePackageCatalogVisible(
  expectation: SourcePackageCatalogExpectation,
): Promise<void> {
  const registry = gateway.doc.registry;
  if (registry === undefined) {
    throw new Error('AssetRegistry unavailable for source-package catalog sync');
  }

  if (await importReady(registry, expectation)) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      unsubscribe();
      fn();
    };

    const deadline = setTimeout(() => {
      finish(() => {
        reject(new Error('source package catalog visibility deadline exceeded'));
      });
    }, SOURCE_PACKAGE_CATALOG_DEADLINE_MS);

    const check = (): void => {
      void importReady(registry, expectation).then((ready) => {
        if (ready) finish(resolve);
      });
    };

    const unsubscribe = registry.subscribeCatalog(check);

    void registry.reconcileCatalog?.().then(check);
  });
}

/** Register the host-owned glTF/FBX catalog replica barrier (Viewport boot). */
export function installSourcePackageCatalogBarrier(): () => void {
  registerPostSourcePackageCatalogSync(awaitSourcePackageCatalogVisible);
  return () => registerPostSourcePackageCatalogSync(null);
}
