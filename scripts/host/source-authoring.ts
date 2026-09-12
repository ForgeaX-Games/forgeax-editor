import { createScriptablePackAuthoringGateway } from '@forgeax/engine-pack/source';
import { createFileSystemScriptablePackAuthoringPort, loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ok } from '@forgeax/engine-types';
import { readdir, readFile, utimes } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/** Node host adapter shared by standalone Editor and embedding products.
 * The host resolves the project root; Engine owns operation validation and writes.
 */
export function createSourceAuthoringHost(gameRoot: string) {
  const gameDir = resolve(gameRoot);
  const authoredTextExtensions = new Set(['.json', '.ts', '.tsx', '.js', '.jsx', '.md']);

  async function authoredFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.forgeax') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && authoredTextExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(path);
      }
    };
    await visit(root);
    return files;
  }

  async function sourceIncomingRefs(sourcePath: string, sourceKey?: string): Promise<readonly string[]> {
    if (sourceKey === undefined) return [];
    const loaded = await loadScriptablePack(resolve(gameDir, sourcePath), { metadataOnly: true });
    if (!loaded.ok) return [];
    const output = loaded.value.assets[sourceKey];
    if (output === undefined) return [];
    const guid = AssetGuid.format(output.guid);
    const sourceAbs = resolve(gameDir, sourcePath);
    const references: string[] = [];
    for (const path of await authoredFiles(gameDir)) {
      if (path === sourceAbs) continue;
      const contents = await readFile(path, 'utf8').catch(() => '');
      if (contents.includes(guid)) references.push(relative(gameDir, path).replace(/\\/g, '/'));
    }
    return references.sort();
  }

  return createScriptablePackAuthoringGateway(
    createFileSystemScriptablePackAuthoringPort({
      gameRoot: gameDir,
      incomingRefs: sourceIncomingRefs,
      // Source mutation writes already notify the existing producer watchers.
      // Explicit rebuild has no content write, so publish the same source event
      // without adding a second cooker in the API process.
      rebuild: async (sourcePath) => {
        const now = new Date();
        await utimes(resolve(gameDir, sourcePath), now, now);
        return ok(undefined);
      },
    }),
  );

}

/** HTTP adapter; callers bind this to a verified project before dispatch. */
export function createSourceAuthoringHandler(gameRoot: string) {
  const gateway = createSourceAuthoringHost(gameRoot);
  return async (request: Request): Promise<Response> => {
    let operation: Parameters<typeof gateway.execute>[0];
    try {
      operation = await request.json() as typeof operation;
    } catch {
      return Response.json({ ok: false, error: {
        code: 'pack-source-operation-invalid',
        hint: 'Source authoring operation body must be valid JSON.',
        retryable: false,
        recoveryActions: ['inspect-operation-schema'],
      } }, { status: 400 });
    }
    return Response.json(await gateway.execute(operation));
  };
}
