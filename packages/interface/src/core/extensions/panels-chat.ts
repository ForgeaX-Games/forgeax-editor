// packages/interface/src/core/extensions/panels-chat.ts
import type { AppExtension } from '../app-shell/types';
import { buildAssetPill, requestComposerInsert, type PillPayload } from '../../lib/composer-bridge';

export const panelsChatExtension: AppExtension = {
  id: 'panels.chat',
  version: '1.0.0',
  requires: ['commands'],
  setup(ctx) {
    const cleanups: Array<() => void> = [];
    cleanups.push(ctx.registerCommand({
      id: 'app.chat.insertPill',
      title: 'Insert reference pill into chat composer',
      execute: (args) => {
        const p = args as { pill?: PillPayload } | undefined;
        if (!p?.pill) throw new Error('app.chat.insertPill: missing { pill }');
        requestComposerInsert(p.pill);
        return { status: 'completed' as const };
      },
    }));
    // Public reference channel for callers outside interface (e.g. the editor's
    // page-tab menu): build the asset pill here so the composer-bridge stays an
    // interface-internal detail and cross-package callers only touch commands.
    cleanups.push(ctx.registerCommand({
      id: 'app.chat.referenceAsset',
      title: 'Reference an asset in the chat composer',
      execute: (args) => {
        const a = args as { guid?: string; name?: string; assetKind?: string; packPath?: string } | undefined;
        if (!a?.guid) throw new Error('app.chat.referenceAsset: missing { guid }');
        requestComposerInsert(buildAssetPill({
          guid: a.guid,
          ...(a.name ? { name: a.name } : {}),
          ...(a.assetKind ? { assetKind: a.assetKind } : {}),
          ...(a.packPath ? { packPath: a.packPath } : {}),
        }));
        return { status: 'completed' as const };
      },
    }));
    return () => { for (const c of cleanups) c(); };
  },
};
