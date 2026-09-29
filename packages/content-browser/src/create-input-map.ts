// create-input-map — Content Browser path that mints an Input Map.

import {
  createDefaultInputMapPayload,
  dispatchActiveEditorOperation,
  generateAssetGuid,
} from '@forgeax/editor-core';
import { toast } from '@forgeax/editor-ui';

/** Dispatch create only — no editor tab. `packDir` stays game-relative. */
export async function createInputMap(name: string, packDir: string): Promise<string | null> {
  const guid = generateAssetGuid();
  const packPath = `${packDir}/${name}.pack.json`;
  const created = await dispatchActiveEditorOperation({
    kind: 'createInputMap',
    guid,
    name,
    packPath,
  }, 'human');
  if (!created.ok) {
    toast.error('createInputMap', { description: created.error.hint });
    return null;
  }
  return guid;
}

/** Dispatch create + open the Input Map tab. */
export async function createInputMapAndOpen(name: string, packDir: string): Promise<void> {
  const guid = await createInputMap(name, packDir);
  if (!guid) return;
  const packPath = `${packDir}/${name}.pack.json`;
  const payload = createDefaultInputMapPayload();
  const opened = await dispatchActiveEditorOperation({
    kind: 'openAssetEditor',
    asset: {
      guid,
      kind: 'input-map',
      name,
      packPath,
      payload: payload as unknown as Record<string, unknown>,
    },
  }, 'human');
  if (!opened.ok) toast.error('openAssetEditor', { description: opened.error.hint });
}
