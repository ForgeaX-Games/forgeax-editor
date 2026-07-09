// packages/interface/src/core/plugins/panels-chat.ts
import type { AppPlugin } from '../app-shell/types';
import { requestComposerInsert, type PillPayload } from '../../lib/composer-bridge';

export const panelsChatPlugin: AppPlugin = {
  id: 'panels.chat',
  version: '1.0.0',
  requires: ['commands'],
  setup(ctx) {
    const off = ctx.registerCommand({
      id: 'app.chat.insertPill',
      title: 'Insert reference pill into chat composer',
      execute: (args) => {
        const p = args as { pill?: PillPayload } | undefined;
        if (!p?.pill) throw new Error('app.chat.insertPill: missing { pill }');
        requestComposerInsert(p.pill);
        return { status: 'completed' as const };
      },
    });
    return off;
  },
};
