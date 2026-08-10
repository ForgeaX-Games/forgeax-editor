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
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
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
import { useMenubarSurface } from './menubar-surface';
import { isTauri } from '../../lib/platform/runtime';
import {
  getRecentGamesRevision,
  subscribeRecentGames,
  warmRecentGames,
} from '../../lib/recent-games';
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

/** 第三个参数 itemId 是**记账用**的稳定菜单项 id(如 file.save)。可选,所以
 *  只传两参的既有调用点照常编译。为什么需要它:人机同账要求两侧记录形状一致 ——
 *  AI 那路按 itemId 派发,人这路手上只有解析后的 commandId,不带上 itemId 的话
 *  两条记录对不上号(help.shortcuts 与 overlay.open 是同一动作的两个名字),
 *  比对"人和 AI 是不是做了同一件事"就得二次查菜单注册表。 */
type Execute = (id: string, args?: unknown, itemId?: string) => void;

/** Compute the resolved enabled flag for one item.
 *  - Explicit `enabled()` always wins.
 *  - Items with children (static or dynamic) default to enabled (a submenu
 *    opener needs no cmd).
 *  - Leaf items default to `!!commandId` (no command = no-op = disabled). */
function resolveEnabled(item: MenuItemDef): boolean {
  if (item.enabled) return item.enabled();
  if ((item.children && item.children.length > 0) || item.dynamicChildren) return true;
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
  const hasStaticChildren = !!item.children && item.children.length > 0;
  const hasChildren = hasStaticChildren || !!item.dynamicChildren;
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
    // Dynamic children are evaluated fresh on each render of the SubContent.
    // Radix mounts SubContent lazily (on hover-open) and unmounts on close, so
    // `item.dynamicChildren()` runs at open-time — the caller must have the data
    // ready synchronously (see file-menu game-list prefetch). Empty result → a
    // single disabled "no recent" placeholder so the submenu never looks broken.
    const kids = hasStaticChildren ? item.children! : item.dynamicChildren!();
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!enabled} className={['fx-menubar-item', dangerCls].filter(Boolean).join(' ')}>
          {leftNode}
          <span className="fx-menubar-item-label">{label}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="fx-menubar-content">
          {kids.length > 0
            ? renderMenuChildren(kids, t, execute)
            : (
                <DropdownMenuItem disabled className="fx-menubar-item">
                  <span className="fx-menubar-item-label">{t('menu.file.openRecentEmpty')}</span>
                </DropdownMenuItem>
              )}
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
        execute(item.commandId, item.args, item.id);
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
  /** Controlled open flag — the whole bar shares one "which menu is open"
   *  value so sibling hover can steal the open panel (UE-style). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pointer entered this trigger. The bar decides whether to switch the open
   *  panel here (only when some OTHER menu is already open). */
  onTriggerEnter: () => void;
}

function TopMenu({ menu, items, t, execute, open, onOpenChange, onTriggerEnter }: TopMenuProps) {
  const brand = useBrand();
  // The async warm completes after File has rendered. Subscribe so an
  // already-open recent submenu replaces its empty placeholder immediately.
  useSyncExternalStore(
    subscribeRecentGames,
    getRecentGamesRevision,
    getRecentGamesRevision,
  );
  if (items.length === 0) return null;
  const isBrand = menu === 'brand';
  // Top-level titles are fixed labels (`menubar.<menu>`). If i18n hasn't been
  // populated yet (T3 owns that), `t()` falls back to returning the key so we
  // don't crash — we just show "menubar.file" in place of "File" until T3.
  const titleKey = `menubar.${menu}`;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={isBrand ? 'fx-menubar-btn fx-menubar-btn--brand no-motion-lift' : 'fx-menubar-btn no-motion-lift'}
          data-menu={menu}
          onPointerEnter={onTriggerEnter}
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
  const { t, i18n } = useTranslation();
  const menus = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const host = useHost();
  // Same command bus TopBar uses. Fire-and-forget: menu clicks never await
  // the command result — that would block dropdown-close animation.
  // 纯执行,不记账。AI 经 host.menubar.invoke 走的就是这一个 —— 它那一路已经由
  // dispatchToSurface 记了 source:'ai',这里再补一次会变成同一次操作在账本里既是
  // ai 又是 user(而 /dispatched 端点无条件打 source:'user',分不出调用方)。
  const execute = useCallback<Execute>(
    (id, args) => { void host.commands.execute(id, args); },
    [host],
  );
  // 人点菜单项才走这个:先补账再执行。人机同账的语义是"同一条 handler、只用 source
  // 区分",所以记账必须挂在**人这条调用点**上,不能挂在两路共用的 execute 里。
  // 两侧统一记 { itemId, commandId } —— 不统一的话账本里 AI 记 itemId、人记
  // commandId,同一个动作两种名字,离线比对还得回查注册表(2026-08-05 实测)。
  // fire-and-forget,失败静默(账本是观测面,不是功能依赖)。
  const executeFromClick = useCallback<Execute>(
    (id, args, itemId) => {
      void fetch('/api/bus/ui/surfaces/host.menubar/dispatched', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'invoke', args: { itemId, commandId: id, args } }),
      }).catch(() => {});
      execute(id, args);
    },
    [execute],
  );
  // AI 面(host.menubar.invoke)的执行器:**await 命令本体** —— 命令失败要变成
  // ack ok=false,agent 才不会把失败说成"已完成"(2026-08-06 外审 B6①:此前同步
  // 返回,file.save 失败也被 ack 成功)。人点击仍走上面的 fire-and-forget(不卡
  // 下拉动画);两者只差等不等结果,handler 是同一个 commands.execute。
  const executeForSurface = useCallback(
    (id: string, args?: unknown) => Promise.resolve(host.commands.execute(id, args)),
    [host],
  );
  // Dual-modality projection: publish the menu tree + an `invoke` action that
  // runs the SAME execute a human click runs. Must sit before the isTauri()
  // early return (hooks rule); the registry stays the SSOT either way.
  // 传 i18n.language 而不是 t:`t` 是模块级恒定标识(i18n/index.ts 刻意如此,
  // 免得列进依赖数组造成无限重渲染),用它当依赖等于永不重投影 —— 切语言后 DOM
  // 变了、snapshot 还是旧语言,AI 按 label 导航与用户所见错位(2026-08-06 探测)。
  useMenubarSurface(menus, t, executeForSurface, i18n.language);

  // One shared "which top-level menu is open" value for the whole bar. This is
  // what makes it behave like a native/UE menu bar rather than N unrelated
  // dropdowns: only one panel is open at a time, and once ANY panel is open,
  // pointer-entering a sibling trigger steals the open state to it (see
  // `handleTriggerEnter`). `null` = closed bar (idle: hover just highlights,
  // it does NOT open — matching UE, where you must click to arm the bar).
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);

  // File owns a dynamic 打开最近 submenu backed by an async game list. Warm the
  // cache whenever File becomes the open menu — via click OR hover-steal — so
  // `getRecentGames()` is populated by the time the user reaches the submenu.
  useEffect(() => {
    if (openMenu === 'file') void warmRecentGames();
  }, [openMenu]);

  const handleOpenChange = useCallback(
    (menu: MenuId) => (isOpen: boolean) => {
      // Radix fires (false) on the previously-open menu when we steal focus to
      // a sibling; only honour a close if THIS menu is still the current one,
      // else the steal would immediately re-close the bar.
      setOpenMenu((cur) => (isOpen ? menu : cur === menu ? null : cur));
    },
    [],
  );

  const handleTriggerEnter = useCallback(
    (menu: MenuId) => () => {
      // Steal the open panel to the hovered trigger, but only while the bar is
      // already armed (some other menu open). Idle hover must not auto-open.
      setOpenMenu((cur) => (cur !== null && cur !== menu ? menu : cur));
    },
    [],
  );

  // Under Tauri the OS native menu is the SSOT for the whole menu bar (T5
  // bridge) — brand/app menu included — so the HTML bar renders nothing at all
  // (no brand chip, no dropdowns). The trailing divider goes with it.
  if (isTauri()) return null;

  return (
    <>
      <div className="fx-menubar">
        {menus.brand.length > 0 && (
          <TopMenu
            menu="brand"
            items={menus.brand}
            t={t}
            // 人点击走 executeFromClick(先补账再执行),不是共用的 execute ——
            // 人机同账靠的就是记账挂在人这条调用点上。main 新加的悬停切换 props 照收。
            execute={executeFromClick}
            open={openMenu === 'brand'}
            onOpenChange={handleOpenChange('brand')}
            onTriggerEnter={handleTriggerEnter('brand')}
          />
        )}
        {TOP_MENUS.map((m) => (
          <TopMenu
            key={m}
            menu={m}
            items={menus[m]}
            t={t}
            execute={executeFromClick}
            open={openMenu === m}
            onOpenChange={handleOpenChange(m)}
            onTriggerEnter={handleTriggerEnter(m)}
          />
        ))}
      </div>
      {/* Separates the menu cluster from the game/session switchers. Lives here
          (not in TopBar) so it disappears together with the bar under Tauri. */}
      <span className="tb-divider" aria-hidden="true" />
    </>
  );
}
