import { useEffect, useState } from 'react';
import { buildMenu, type MenuItem } from './menuRegistry';
import { buildAssetPill, buildComponentPill, buildEntityPill } from '../../lib/composer-bridge';
import { pushHealth } from '../StatusBar/healthStore';
import { useShellStore } from '../../store';
import { usePanelRenderers } from '../DockShell/panelRenderers';
import { useHost } from '../../core/app-shell';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/**
 * App-wide context menu host. ONE controlled Radix DropdownMenu renders EVERY
 * context menu, fed by two in-process sources:
 *   1. a capture-phase `contextmenu` listener over main-window DOM (via the
 *      `buildMenu` registry), and
 *   2. the editor's injected single-realm renderer callback, which carries the
 *      real item closures (no cross-window protocol copy).
 * Radix owns focus / ↑↓ nav / Esc / outside-click / collision flipping.
 */
export function ContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);
  const renderers = usePanelRenderers();
  const host = useHost();

  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      const selection = window.getSelection()?.toString() ?? '';
      const items = buildMenu(e.target, selection);
      if (items.length === 0) {
        setState(null);
        return;
      }
      setState({ x: e.clientX, y: e.clientY, items });
    };
    document.addEventListener('contextmenu', onCtx, { capture: true });
    return () => document.removeEventListener('contextmenu', onCtx, { capture: true });
  }, []);

  // Editor menus are injected structurally by the single-realm host. Their
  // onClick closures stay in-process, so the UI capability has one body instead
  // of a serialised cross-window protocol mirror.
  useEffect(() => renderers.editor?.setContextMenuRenderer?.((menu) => {
    if (!menu) {
      setState(null);
      return;
    }
    const items: MenuItem[] = menu.items.map((item) =>
      item.sep
        ? { kind: 'sep' as const }
        : {
            kind: 'item' as const,
            label: item.label ?? '',
            disabled: item.disabled,
            danger: item.danger,
            onClick: item.onClick ?? (() => {}),
          },
    );
    setState(items.length ? { x: menu.x, y: menu.y, items } : null);
  }), [renderers.editor]);

  // Project typed editor coordination into the host commands directly. This is
  // the single-realm replacement for the iframe-message adapter's postMessage
  // mirror; editor-core remains injected through PanelRenderers, not imported.
  useEffect(() => renderers.editor?.installBridge?.({
    onEditorHealth: ({ level, code, message }) => {
      pushHealth({ level, source: 'edit', code, message });
    },
    onEditorConsole: (entry) => {
      useShellStore.getState().pushConsole(entry);
    },
    onEditorNetwork: (entry) => {
      useShellStore.getState().pushNetwork(entry);
    },
    onEditorRef: (p) => {
      if (p.kind === 'component' && typeof p.entityName === 'string' && typeof p.comp === 'string') {
        const pill = buildComponentPill({
          entityId: p.entityId,
          entityName: p.entityName,
          comp: p.comp,
          value: p.value,
        });
        void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
      } else if (p.kind === 'asset' && typeof p.guid === 'string') {
        const pill = buildAssetPill({ guid: p.guid, name: p.name, assetKind: p.assetKind, packPath: p.packPath });
        void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
      } else if (p.kind === 'entity' && typeof p.id === 'number' && typeof p.name === 'string') {
        const pill = buildEntityPill({ id: p.id, name: p.name, components: p.components, source: p.source });
        void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
      }
    },
    onAddAssetToChat: (refs) => {
      for (const ref of refs) {
        if (ref.type === 'asset' && typeof ref.guid === 'string') {
          const pill = buildAssetPill({
            guid: ref.guid,
            name: ref.name,
            assetKind: ref.kind,
            packPath: ref.path,
            payload: ref.payload,
          });
          void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
        } else if (ref.type === 'folder' && typeof ref.path === 'string') {
          const pill = buildAssetPill({
            guid: `folder:${ref.path}`,
            name: ref.name ? `📁 ${ref.name}` : '📁 Folder',
            assetKind: 'folder',
            packPath: ref.path,
            payload: ref.summary,
          });
          void host.commands.execute('app.chat.insertPill', { pill }).catch(() => {});
        }
      }
    },
  }), [host, renderers.editor]);

  return (
    <DropdownMenu
      open={state !== null}
      onOpenChange={(o) => {
        if (!o) setState(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 0,
            height: 0,
          }}
        />
      </DropdownMenuTrigger>
      {state && (
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={2}
          className="min-w-[180px] forgeax-ctx-menu-panel"
          onContextMenu={(e) => e.preventDefault()}
        >
          {state.items.map((it, i) =>
            it.kind === 'sep' ? (
              <DropdownMenuSeparator key={`s${i}`} />
            ) : (
              <DropdownMenuItem
                key={`i${i}`}
                disabled={it.disabled}
                className={it.danger ? 'text-destructive focus:text-destructive' : undefined}
                onSelect={() => {
                  if (!it.disabled) it.onClick();
                }}
              >
                {it.label}
              </DropdownMenuItem>
            ),
          )}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
