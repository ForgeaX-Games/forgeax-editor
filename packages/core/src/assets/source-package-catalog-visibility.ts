// assets/source-package-catalog-visibility — pure checks for glTF/FBX import catalog sync.

import type { SourcePackageCatalogExpectation } from '../session/authored-asset-write';

export interface SourcePackageCatalogRow {
  readonly guid: string;
  readonly kind?: string;
  readonly sourcePath?: string;
  readonly lifecycle?: string;
  readonly projection?: { readonly subject?: unknown };
}

export function sourcePathMatchesCatalogExpectation(
  sourcePath: string,
  expectation: SourcePackageCatalogExpectation,
): boolean {
  const dest = expectation.destPath.replace(/\\/g, '/');
  const normalizedDest = dest.replace(/^sample\//, '');
  const fileSuffix = `/${expectation.sourceName}`;
  return sourcePath === dest
    || sourcePath.endsWith(dest)
    || sourcePath.endsWith(`/${normalizedDest}`)
    || sourcePath.endsWith(fileSuffix);
}

/** Whether the live catalog projection already exposes a finished source-package import. */
export function isSourcePackageCatalogVisible(
  rows: readonly SourcePackageCatalogRow[],
  expectation: SourcePackageCatalogExpectation,
): boolean {
  if (rows.length === 0) return false;

  const pathRows = rows.filter((row) => (
    typeof row.sourcePath === 'string' && sourcePathMatchesCatalogExpectation(row.sourcePath, expectation)
  ));

  const producerVisible = rows.some((row) => (
    typeof row.sourcePath === 'string'
    && sourcePathMatchesCatalogExpectation(row.sourcePath, expectation)
    && row.projection?.subject === 'imported-output'
    && row.lifecycle === 'current'
  ));
  if (producerVisible) return true;

  if (expectation.packageGuid !== undefined) {
    const packageRow = rows.find((row) => row.guid.toLowerCase() === expectation.packageGuid!.toLowerCase());
    if (packageRow !== undefined && typeof packageRow.sourcePath === 'string'
      && sourcePathMatchesCatalogExpectation(packageRow.sourcePath, expectation)) {
      return true;
    }
  }

  if (expectation.subAssetGuids.length > 0) {
    const found = new Set(rows.map((row) => row.guid.toLowerCase()));
    if (expectation.subAssetGuids.every((guid) => found.has(guid.toLowerCase()))) {
      return true;
    }
  }

  if (pathRows.length === 0) return false;
  return ['scene', 'mesh', 'material'].every((kind) => pathRows.some((row) => row.kind === kind));
}
