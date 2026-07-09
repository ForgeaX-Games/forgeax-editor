// packages/interface/src/core/plugins/iframe-message-adapter.ts
//
// Single owner of window `message` listener. Replaces the three separate
// `useEffect(() => window.addEventListener('message', ...))` blocks that
// lived in App.tsx L57-133 for VAG_EDITOR_REF / FORGEAX_ADD_ASSET_TO_CHAT /
// FORGEAX_FOCUS_PANEL. Foreign-origin guard preserved (isTrustedMessageOrigin).
import type { AppPlugin } from '../app-shell/types';
import { isTrustedMessageOrigin } from '../../lib/trustedOrigins';
import {
  buildEntityPill, buildAssetPill, buildComponentPill,
} from '../../lib/composer-bridge';

export const iframeMessageAdapterPlugin: AppPlugin = {
  id: 'iframe-message-adapter', version: '1.0.0',
  requires: ['bus', 'commands'],
  setup(ctx) {
    const { bus, host } = ctx;
    // Best-effort side-effect: pill insert / panel focus commands may not be
    // registered yet (chat/dock panel plugin not loaded, headless tests).
    // Swallow rejection so the bus.emit still lands and one missing command
    // doesn't break the whole listener.
    const onMessage = (ev: MessageEvent): void => {
      if (!isTrustedMessageOrigin(ev.origin)) return;
      const data = ev.data as { type?: unknown } | null;
      if (!data || typeof data.type !== 'string') return;

      switch (data.type) {
        case 'VAG_EDITOR_REF': {
          const p = (data as { payload?: Record<string, unknown> }).payload;
          if (!p || typeof p.kind !== 'string') return;
          if (p.kind === 'component' && typeof p.entityName === 'string' && typeof p.comp === 'string') {
            const pill = buildComponentPill({
              entityId: typeof p.entityId === 'number' ? p.entityId : undefined,
              entityName: p.entityName, comp: p.comp, value: p.value,
            });
            void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
          } else if (p.kind === 'asset' && typeof p.guid === 'string') {
            const pill = buildAssetPill({
              guid: p.guid,
              name: typeof p.name === 'string' ? p.name : undefined,
              assetKind: typeof p.assetKind === 'string' ? p.assetKind : undefined,
              packPath: typeof p.packPath === 'string' ? p.packPath : undefined,
            });
            void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
          } else if (p.kind === 'entity' && (typeof p.id === 'number' || typeof p.id === 'string') && typeof p.name === 'string') {
            const pill = buildEntityPill({
              id: p.id, name: p.name, components: p.components,
              source: (p.source ?? undefined) as { plugin?: string; docId?: string } | undefined,
            });
            void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
          }
          bus.emit('editor:ref', { kind: p.kind as 'entity' | 'asset' | 'component', payload: p });
          return;
        }
        case 'FORGEAX_ADD_ASSET_TO_CHAT': {
          const refs = (data as { refs?: unknown }).refs;
          if (!Array.isArray(refs)) return;
          for (const ref of refs as Array<Record<string, unknown>>) {
            if (ref.type === 'asset' && typeof ref.guid === 'string') {
              const pill = buildAssetPill({
                guid: ref.guid,
                name: typeof ref.name === 'string' ? ref.name : undefined,
                assetKind: typeof ref.kind === 'string' ? ref.kind : undefined,
                packPath: typeof ref.path === 'string' ? ref.path : undefined,
                payload: ref.payload as Record<string, unknown> | undefined,
              });
              void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
            } else if (ref.type === 'folder' && typeof ref.path === 'string') {
              const pill = buildAssetPill({
                guid: `folder:${ref.path}`,
                name: typeof ref.name === 'string' ? `📁 ${ref.name}` : '📁 Folder',
                assetKind: 'folder',
                packPath: typeof ref.path === 'string' ? ref.path : undefined,
                payload: ref.summary as Record<string, unknown> | undefined,
              });
              void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
            }
          }
          bus.emit('iframe:add-asset', { refs: refs as readonly Record<string, unknown>[] });
          return;
        }
        case 'FORGEAX_FOCUS_PANEL': {
          const panel = (data as { panel?: unknown }).panel;
          if (typeof panel !== 'string') return;
          void host.commands.execute('app.panel.focus', { id: `ep:${panel}` }).catch(() => {});
          return;
        }
        default: return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); };
  },
};
