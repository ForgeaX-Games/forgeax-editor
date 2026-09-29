// create-actions — folder inline-create dispatch (assets use the prompt flow in ContentBrowser).

import { dispatchActiveEditorOperation, joinGameRelativePath } from '@forgeax/editor-core';

export function resolvePackDir(currentPath: string): string {
  return (currentPath || 'assets').replace(/^\/+|\/+$/g, '') || 'assets';
}

/** Dispatch a folder create. Returns its game-relative path when accepted. */
export async function executeCreateFolder(
  parentPath: string,
  name: string,
): Promise<string | null> {
  const result = await dispatchActiveEditorOperation(
    { kind: 'createDirectory', parentPath, name },
    'human',
  );
  if (!result.ok) {
    console.warn('[content-browser] createDirectory rejected', result.error);
    return null;
  }
  return joinGameRelativePath(parentPath, name);
}
