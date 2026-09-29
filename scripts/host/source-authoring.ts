import { createFileSystemPackAuthoringGateway } from '@forgeax/engine-pack/build';
import { utimes } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ok } from '@forgeax/engine-types';

/** The scoped host supplies the root; Engine owns validation and source writes. */
export function createSourceAuthoringHandler(gameRoot: string) {
  const gateway = createFileSystemPackAuthoringGateway({
    gameRoot,
    rebuild: async (sourcePath) => {
      const now = new Date();
      await utimes(resolve(gameRoot, sourcePath), now, now);
      return ok(undefined);
    },
  });
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
