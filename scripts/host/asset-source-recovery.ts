import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMeta } from '@forgeax/engine-pack';
import { isValidAssetGuidString } from '@forgeax/engine-pack/guid';
import { produceSourceMetadata, type ExistingSourceMetadata } from '../../packages/core/src/assets/source-metadata-producer';
import { getImportFormat } from '../../packages/core/src/scan/ext-importer-map';

function failure(code: string, hint: string, sourcePath: string): Error {
  return Object.assign(new Error(code), { code, expected: 'one existing project source with recoverable metadata identity', hint, detail: { sourcePath } });
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function readSidecar(path: string): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure('asset-recovery-sidecar-invalid', 'Metadata must be a regular project file.', basename(path));
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Recover one producer sidecar without requiring a healthy Catalog or Viewport.
 * Host authorization and subsequent full scan/cook belong to the scope controller. */
export async function recoverAssetSource(gameRoot: string, sourcePath: string) {
  const normalized = sourcePath.replace(/\\/g, '/');
  if (!normalized || isAbsolute(normalized) || win32.isAbsolute(sourcePath) || normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw failure('asset-recovery-path-invalid', 'Use one project-relative source path without traversal.', '<invalid>');
  }
  const root = await realpath(gameRoot);
  const target = resolve(root, normalized);
  const sourceReal = await realpath(target).catch(() => undefined);
  if (!sourceReal || !inside(root, sourceReal) || !(await lstat(sourceReal)).isFile()) {
    throw failure('asset-recovery-source-unavailable', 'Source must exist as a regular file inside this project.', normalized);
  }
  const format = getImportFormat(basename(target));
  if (!format) throw failure('asset-recovery-format-unsupported', 'This source has no registered import producer.', normalized);
  const metaPath = format.importer === 'ui' ? target.replace(/\.ui\.html$/i, '.meta.json') : `${target}.meta.json`;
  const metadataDirectory = await realpath(dirname(metaPath));
  if (!inside(root, metadataDirectory)) throw failure('asset-recovery-path-invalid', 'Metadata directory must remain inside this project.', normalized);
  const originalSource = await readFile(sourceReal);
  const originalMeta = await readSidecar(metaPath);
  let existing: ExistingSourceMetadata | undefined;
  let existingObject: Record<string, unknown> | undefined;
  if (originalMeta !== undefined) {
    try {
      const value = JSON.parse(originalMeta.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'external-asset-package'
        || value.importer !== format.importer || !Array.isArray(value.subAssets) || value.subAssets.length === 0
        || value.subAssets.some((entry: Record<string, unknown>) => !entry || !isValidAssetGuidString(entry.guid)
          || typeof entry.kind !== 'string' || !Number.isInteger(entry.sourceIndex))) throw new Error('unrecoverable identity');
      if (new Set(value.subAssets.map((entry: { guid: string }) => entry.guid)).size !== value.subAssets.length) throw new Error('duplicate identity');
      existingObject = value;
      existing = value;
    } catch {
      throw failure('asset-recovery-identity-unrecoverable', 'Existing metadata cannot establish valid producer identities; restore its known-good sidecar instead of minting replacement GUIDs.', normalized);
    }
  }
  const produced = await produceSourceMetadata({
    bytes: originalSource.buffer.slice(originalSource.byteOffset, originalSource.byteOffset + originalSource.byteLength) as ArrayBuffer,
    sourceName: basename(target), ...(existing === undefined ? {} : { existing }),
  });
  if (!produced.ok) throw failure(produced.code, produced.error, normalized);
  const metadata = JSON.parse(produced.metaJson) as Record<string, unknown> & { subAssets: { guid: string; kind: string }[] };
  if (existing?.subAssets.some((entry) => !metadata.subAssets.some((output) => output.guid === entry.guid && output.kind === entry.kind))) {
    throw failure('asset-recovery-identity-unrecoverable', 'Canonical source outputs no longer include every existing identity; restore the matching source before rebuilding.', normalized);
  }
  for (const field of ['guid', 'sourceOverrides', 'instances', 'promote'] as const) {
    if (existingObject?.[field] !== undefined) metadata[field] = existingObject[field];
  }
  if (!validateMeta(metadata)) throw failure('asset-recovery-metadata-invalid', 'Canonical metadata did not pass the Engine schema; no sidecar was written.', normalized);
  const contents = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
  const temporary = `${metaPath}.forgeax-recovery-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    const currentSourceReal = await realpath(target).catch(() => undefined);
    const currentDirectory = await realpath(dirname(metaPath)).catch(() => undefined);
    const currentMeta = await readSidecar(metaPath);
    if (currentSourceReal !== sourceReal || currentDirectory !== metadataDirectory
      || !(await readFile(sourceReal)).equals(originalSource)
      || (originalMeta === undefined ? currentMeta !== undefined : currentMeta === undefined || !currentMeta.equals(originalMeta))) {
      throw failure('asset-recovery-source-changed', 'Source or metadata changed during production; retry against the new snapshot.', normalized);
    }
    await rename(temporary, metaPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return { sourcePath: normalized, metaPath: relative(root, metaPath).split(sep).join('/'), subAssets: metadata.subAssets, metadataRebuilt: true as const };
}
