/**
 * MenuBar — Web renderer for the menu registry (T2).
 *
 * Subscribes to `lib/menu-registry` via `useSyncExternalStore` and renders
 * top-level dropdowns for `file` / `edit` / `window` / `build` / `select` /
 * `help` (in that order). `brand` renders first as a small app-menu dropdown.
 * `publish` is intentionally excluded — TopBar already owns a Publish button.
 *
 * Platform guard: under Tauri the OS draws the real menu bar (T5's native
 * bridge), so we render ONLY the brand entry (or nothing when brand is empty).
 * On web we render the full bar.
 *
 * Commands: clicking a leaf item dispatches through the SAME accessor TopBar
 * uses — `useHost().commands.execute(id, args)` (`useCommand<T>(id)` bakes the
 * id into the callback, which doesn't fit here since ids are dynamic at click
 * time; the underlying accessor is identical). This keeps keyboard shortcuts,
 * command palette, and menu clicks on one entry.
 */
import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import {
  BookOpen,
  BoxSelect,
  Check,
  Clipboard,
  Clock,
  Code,
  Copy,
  FilePlus,
  FlipHorizontal2,
  Focus,
  FolderOpen,
  FolderSearch,
  Gamepad2,
  Github,
  Globe,
  GraduationCap,
  Hash,
  Info,
  Keyboard,
  LayoutGrid,
  Maximize,
  MessageCircle,
  Newspaper,
  Package,
  Pencil,
  Play,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  SaveAll,
  Scale,
  Scan,
  Scissors,
  ScrollText,
  Search,
  Settings,
  Shapes,
  Sparkles,
  Square,
  SquareDashed,
  Store,
  Trash2,
  Undo2,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation, type TFunction } from '@/i18n';
import { useHost } from '../../core/app-shell';
import { useBrand } from '../../brand/BrandProvider';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '../ui/dropdown-menu';
import {
  onMenuChange,
  snapshotAllMenus,
  type MenuId,
  type MenuItemDef,
} from '../../lib/menu-registry';
import { prettyCombo } from '../../lib/global-shortcuts';
import { isTauri } from '../../lib/platform/runtime';
import './MenuBar.css';

// Icon name → lucide component. Mirrors ContextMenu.tsx's MENU_ICONS pattern
// (single-file lookup so an unknown name gracefully renders no icon rather
// than crashing). Static import — never dynamic — so the bundle keeps only
// the icons actually referenced from builtin-menus.ts.
const MENU_ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen,
  'box-select': BoxSelect,
  clipboard: Clipboard,
  clock: Clock,
  code: Code,
  copy: Copy,
  'file-plus': FilePlus,
  'flip-horizontal-2': FlipHorizontal2,
  focus: Focus,
  'folder-open': FolderOpen,
  'folder-search': FolderSearch,
  'gamepad-2': Gamepad2,
  github: Github,
  globe: Globe,
  'graduation-cap': GraduationCap,
  hash: Hash,
  info: Info,
  keyboard: Keyboard,
  'layout-grid': LayoutGrid,
  maximize: Maximize,
  'message-circle': MessageCircle,
  newspaper: Newspaper,
  package: Package,
  pencil: Pencil,
  play: Play,
  'redo-2': Redo2,
  'refresh-cw': RefreshCw,
  'rotate-ccw': RotateCcw,
  save: Save,
  'save-all': SaveAll,
  scale: Scale,
  scan: Scan,
  scissors: Scissors,
  'scroll-text': ScrollText,
  search: Search,
  settings: Settings,
  shapes: Shapes,
  sparkles: Sparkles,
  square: Square,
  'square-dashed': SquareDashed,
  store: Store,
  'trash-2': Trash2,
  'undo-2': Undo2,
  upload: Upload,
  x: X,
};

// ── snapshot cache (stable identity across getSnapshot calls) ────────────
// snapshotAllMenus() computes a fresh object each call; useSyncExternalStore
// requires that repeated getSnapshot() reads return the SAME identity until
// the store actually changes, else React re-renders on every read (potential
// infinite loop). Module-level cache + a single change-listener keeps identity
// stable between registrations. Registry lives as long as this module, so a
// single unbound listener at import time is fine (no cleanup handle needed).
let cachedSnapshot: Record<MenuId, MenuItemDef[]> = snapshotAllMenus();
onMenuChange(() => { cachedSnapshot = snapshotAllMenus(); });

function getSnapshot(): Record<MenuId, MenuItemDef[]> {
  return cachedSnapshot;
}

// SSR/server snapshot — stable identity across calls. This app is a pure
// client build, so this branch never actually fires; providing it satisfies
// the useSyncExternalStore contract and future-proofs against SSR.
const EMPTY_SNAPSHOT: Record<MenuId, MenuItemDef[]> = Object.freeze({
  brand: [], file: [], edit: [], window: [], build: [], select: [], help: [], publish: [],
}) as Record<MenuId, MenuItemDef[]>;

function getServerSnapshot(): Record<MenuId, MenuItemDef[]> {
  return EMPTY_SNAPSHOT;
}

function subscribe(cb: () => void): () => void {
  return onMenuChange(cb);
}

// Top-level dropdowns rendered on web, in order. `publish` is excluded (TopBar
// owns the Publish CTA at the far right); `brand` renders separately at the
// far left.
const TOP_MENUS: readonly Exclude<MenuId, 'brand' | 'publish'>[] = [
  'file', 'edit', 'window', 'build', 'select', 'help',
];

// ── Item rendering (recursive: children reuse the same walker) ───────────

type Execute = (id: string, args?: unknown) => void;

/** Compute the resolved enabled flag for one item.
 *  - Explicit `enabled()` always wins.
 *  - Items with children default to enabled (a submenu opener needs no cmd).
 *  - Leaf items default to `!!commandId` (no command = no-op = disabled). */
function resolveEnabled(item: MenuItemDef): boolean {
  if (item.enabled) return item.enabled();
  if (item.children && item.children.length > 0) return true;
  return !!item.commandId;
}

interface RowProps {
  item: MenuItemDef;
  t: TFunction;
  execute: Execute;
}

function MenuItemRow({ item, t, execute }: RowProps) {
  // when=false items are hidden entirely (caller also skips their separator).
  if (item.when && !item.when()) return null;

  const enabled = resolveEnabled(item);
  const label = t(item.labelKey);
  const combo = item.keybinding ? prettyCombo(item.keybinding) : '';
  const checked = item.checked ? item.checked() : false;
  const hasChildren = !!item.children && item.children.length > 0;
  const dangerCls = item.danger ? 'fx-menubar-item--danger text-destructive focus:text-destructive' : '';
  // Left glyph — a SINGLE slot, like the prototype's `.fe-ctx-item`: a checkable
  // item shows its check state there, every other item shows its icon. Rendering
  // both a check column AND an icon would reserve an empty column that shoves the
  // icon right, so we pick one. Unknown / missing icon name renders nothing.
  const Icon = item.icon ? MENU_ICONS[item.icon] : undefined;
  const iconNode = Icon
    ? <span className="fx-menubar-item-icon" aria-hidden="true"><Icon size={14} /></span>
    : null;
  const leftNode = item.checked
    ? (
        <span className="fx-menubar-item-check" aria-hidden="true">
          {checked ? <Check size={12} /> : null}
        </span>
      )
    : iconNode;

  if (hasChildren) {
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!enabled} className={['fx-menubar-item', dangerCls].filter(Boolean).join(' ')}>
          {leftNode}
          <span className="fx-menubar-item-label">{label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="fx-menubar-content">
          {renderMenuChildren(item.children!, t, execute)}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  }

  // Leaf. Disabled leaves render as text-only rows: greyed, no click handler,
  // still showing label + keybinding. Radix `disabled` prop applies pointer-
  // events-none + opacity via the ui/dropdown-menu component styling.
  return (
    <DropdownMenuItem
      disabled={!enabled}
      className={['fx-menubar-item', dangerCls].filter(Boolean).join(' ')}
      onSelect={(e) => {
        if (!enabled || !item.commandId) { e.preventDefault(); return; }
        execute(item.commandId, item.args);
      }}
    >
      {leftNode}
      <span className="fx-menubar-item-label">{label}</span>
      {combo && <span className="fx-menubar-item-kbd">{combo}</span>}
    </DropdownMenuItem>
  );
}

/** Walk a sorted item list, inserting a `DropdownMenuSeparator` at each
 *  group boundary. Boundary rule mirrors `serializeMenusForNative` in the
 *  registry: `prevGroup` is updated even for hidden items so the separator
 *  policy stays identical between the two renderers (§SSOT / §Derive). */
function renderMenuChildren(items: MenuItemDef[], t: TFunction, execute: Execute): ReactNode[] {
  const rows: ReactNode[] = [];
  let prevGroup: string | null = null;
  for (const it of items) {
    const hidden = it.when ? !it.when() : false;
    if (!hidden && prevGroup !== null && it.group !== prevGroup) {
      rows.push(<DropdownMenuSeparator key={`sep-${it.id}`} />);
    }
    if (!hidden) {
      rows.push(<MenuItemRow key={it.id} item={it} t={t} execute={execute} />);
    }
    prevGroup = it.group;
  }
  return rows;
}

// ── Top-level dropdown ────────────────────────────────────────────────────

interface TopMenuProps {
  menu: MenuId;
  items: MenuItemDef[];
  t: TFunction;
  execute: Execute;
}

function TopMenu({ menu, items, t, execute }: TopMenuProps) {
  const brand = useBrand();
  if (items.length === 0) return null;
  const isBrand = menu === 'brand';
  // Top-level titles are fixed labels (`menubar.<menu>`). If i18n hasn't been
  // populated yet (T3 owns that), `t()` falls back to returning the key so we
  // don't crash — we just show "menubar.file" in place of "File" until T3.
  const titleKey = `menubar.${menu}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={isBrand ? 'fx-menubar-btn fx-menubar-btn--brand' : 'fx-menubar-btn'}
          data-menu={menu}
        >
          {isBrand ? (
            <>
              {/* Prototype `.mb-brand`: a glowing rounded mark (product initial)
                  followed by the product name in brand colour. */}
              <span className="fx-menubar-brand-mark" aria-hidden="true">
                {brand.product.name.charAt(0).toUpperCase()}
              </span>
              <span className="fx-menubar-brand-name">{brand.product.name}</span>
            </>
          ) : (
            t(titleKey)
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="fx-menubar-content">
        {renderMenuChildren(items, t, execute)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Public component ─────────────────────────────────────────────────────

export function MenuBar() {
  const { t } = useTranslation();
  const menus = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const host = useHost();
  // Same command bus TopBar uses. Fire-and-forget: menu clicks never await
  // the command result — that would block dropdown-close animation.
  const execute = useCallback<Execute>(
    (id, args) => { void host.commands.execute(id, args); },
    [host],
  );

  // Under Tauri the OS native menu is the SSOT for the whole menu bar (T5
  // bridge) — brand/app menu included — so the HTML bar renders nothing at all
  // (no brand chip, no dropdowns). The trailing divider goes with it.
  if (isTauri()) return null;

  return (
    <>
      <div className="fx-menubar">
        {menus.brand.length > 0 && (
          <TopMenu menu="brand" items={menus.brand} t={t} execute={execute} />
        )}
        {TOP_MENUS.map((m) => (
          <TopMenu key={m} menu={m} items={menus[m]} t={t} execute={execute} />
        ))}
      </div>
      {/* Separates the menu cluster from the game/session switchers. Lives here
          (not in TopBar) so it disappears together with the bar under Tauri. */}
      <span className="tb-divider" aria-hidden="true" />
    </>
  );
}
