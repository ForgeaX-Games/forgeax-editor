// packages/interface/src/core/extensions/panels-chat.ts
import type { AppExtension } from '../app-shell/types';
import { requestComposerInsert, type PillPayload } from '../../lib/composer-bridge';

export const panelsChatExtension: AppExtension = {
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
