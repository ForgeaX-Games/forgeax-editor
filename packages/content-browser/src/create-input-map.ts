// create-input-map — Content Browser path that mints an Input Map and opens its editor.

import {
  createDefaultInputMapPayload,
  dispatchActiveEditorOperation,
  generateAssetGuid,
} from '@forgeax/editor-core';
import { toast } from '@forgeax/editor-ui';

/** Dispatch create + open the Input Map tab. `packDir` stays game-relative. */
export async function createInputMapAndOpen(name: string, packDir: string): Promise<void> {
  const guid = generateAssetGuid();
  const packPath = `${packDir}/${name}.pack.json`;
  const payload = createDefaultInputMapPayload();
  const created = await dispatchActiveEditorOperation({
    kind: 'createInputMap',
    guid,
    name,
    packPath,
  }, 'human');
  if (!created.ok) {
    toast.error('createInputMap', { description: created.error.hint });
    return;
  }

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
