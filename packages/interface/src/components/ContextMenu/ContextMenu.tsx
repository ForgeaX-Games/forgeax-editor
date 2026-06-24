import { useEffect, useState } from 'react';
import { buildMenu, type MenuItem } from './menuRegistry';
import { isTrustedMessageOrigin } from '@/lib/trustedOrigins';
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

// Wire protocol for editor-iframe context menus (architecture review §unify).
// Editor panels live in iframes (ep:*) and can't render a menu outside their
// own rect, so they POST their items here and THIS host renders them at the top
// layer of the whole window — same renderer as main-window right-clicks.
//   iframe → parent : { type:'VAG_CONTEXT_MENU', menuId, x, y, items:[{id,label,disabled,danger,sep}] }
//   parent → iframe : { type:'VAG_CONTEXT_MENU_ACTION', menuId, actionId }   (on click)
interface WireMenuItem { id?: string; label?: string; disabled?: boolean; danger?: boolean; sep?: boolean }

/**
 * App-wide context menu host. ONE controlled Radix DropdownMenu renders EVERY
 * context menu, fed by two sources:
 *   1. a capture-phase `contextmenu` listener over main-window DOM (via the
 *      `buildMenu` registry), and
 *   2. `VAG_CONTEXT_MENU` postMessages from editor-panel iframes (which can't
 *      render outside their own rect).
 * Radix owns focus / ↑↓ nav / Esc / outside-click / collision flipping.
 */
export function ContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);

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

  // Editor-iframe menus → render here at the top layer (no iframe clipping).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!isTrustedMessageOrigin(e.origin)) return; // foreign-origin guard
      const d = e.data as { type?: string; menuId?: string; x?: number; y?: number; items?: WireMenuItem[] } | null;
      if (!d || d.type !== 'VAG_CONTEXT_MENU' || !Array.isArray(d.items)) return;
      // Find the iframe that sent this so we can map its client coords → ours.
      const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source) as HTMLIFrameElement | undefined;
      const rect = frame?.getBoundingClientRect();
      const x = (rect?.left ?? 0) + (d.x ?? 0);
      const y = (rect?.top ?? 0) + (d.y ?? 0);
      const src = e.source as Window | null;
      const menuId = d.menuId;
      const items: MenuItem[] = d.items.map((it, idx) =>
        it.sep
          ? { kind: 'sep' as const }
          : {
              kind: 'item' as const,
              label: it.label ?? '',
              disabled: it.disabled,
              danger: it.danger,
              onClick: () => src?.postMessage({ type: 'VAG_CONTEXT_MENU_ACTION', menuId, actionId: it.id ?? `i${idx}` }, '*'),
            },
      );
      if (items.length) setState({ x, y, items });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

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
          className="min-w-[180px]"
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
