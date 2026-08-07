// create-material-instance — the ONE Content Browser path that mints a Material
// Instance and opens its editor tab (toolbar `+` menu and blank-area context
// menu both route here, so the two entry points cannot drift).
//
// Anchors: docs/2026-08-05-material-instance-editor-tech-plan.md §D4 (create →
// `openAssetEditor`), mirroring MaterialInstanceEditor's Save Sibling/Child.

import {
  createDefaultMaterialInstancePayload,
  gateway,
  generateAssetGuid,
} from '@forgeax/editor-core';
import { t } from '@forgeax/editor-core/i18n';
import { toast } from '@forgeax/editor-ui';
import { prompt as promptDialog } from '@forgeax/editor-ui/prompt';

/** Prompt for the parent material, dispatch the create, then open the MI tab.
 *  Returns without opening anything when the parent prompt is cancelled or the
 *  applier rejects the args (e.g. the parent GUID is not a GUID).
 *
 *  `packDir` must stay GAME-RELATIVE — the applier calls resolveGamePath. */
export async function createMaterialInstanceAndOpen(name: string, packDir: string): Promise<void> {
  const parentGuid = (await promptDialog({
    title: t('editor.contentBrowser.actions.createAsset', { label: 'Material Instance Parent' }),
    label: 'Parent Material GUID',
    defaultValue: '',
    confirmText: t('editor.contentBrowser.dialogs.createConfirm'),
    cancelText: t('editor.contentBrowser.dialogs.cancel'),
  }))?.trim();
  if (!parentGuid) return;

  const guid = generateAssetGuid();
  const packPath = `${packDir}/Materials.pack.json`;
  const created = gateway.dispatch({
    kind: 'createMaterialInstance',
    guid,
    name,
    parentGuid,
    packPath,
  }, 'human');
  if (!created.ok) {
    toast.error('createMaterialInstance', { description: created.error.hint });
    return;
  }

  // The pack write is fire-and-forget, but the tab opens by GUID and the page
  // controller seeds staging from this payload — the same defaults the applier
  // just wrote — so the editor is usable before the disk write lands.
  const opened = gateway.dispatch({
    kind: 'openAssetEditor',
    asset: {
      guid,
      kind: 'material-instance',
      name,
      packPath,
      payload: createDefaultMaterialInstancePayload(parentGuid) as unknown as Record<string, unknown>,
    },
  }, 'human');
  // The asset itself was created; only the tab failed to open. Report that
  // instead of dropping the refusal — the host may install no page navigation.
  if (!opened.ok) toast.error('openAssetEditor', { description: opened.error.hint });
}
