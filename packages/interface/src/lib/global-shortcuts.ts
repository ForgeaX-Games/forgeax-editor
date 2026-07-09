/**
 * Global keyboard shortcuts · Blender-inspired, IME-safe.
 *
 *   Ctrl+Shift+F  toggle fullscreen (hide TopBar / Sidebar / ChatPanel / StatusBar)
 *   Ctrl+,        open / close Settings
 *   Ctrl+Shift+B  toggle Sidebar
 *   Ctrl+Shift+C  toggle ChatPanel
 *   Ctrl+Shift+D  toggle Dashboard overlay
 *   Ctrl+Shift+1..9  switch to workbench N (Blender parity — index into the
 *                    persisted workbench list, so custom workbenches also
 *                    reachable by ordinal)
 *   Ctrl+Shift+0  open Settings → Plugins (was Ctrl+Shift+3 before P3.5 —
 *                 relocated so 1..9 are free for workbench switching)
 *   Ctrl+/        focus chat composer
 *   Ctrl+H        open Settings → Changelog
 *   Esc           close current overlay (Settings → Dashboard → Fullscreen)
 *
 * IME 安全:
 *   - 总是用 Ctrl+Shift 复合,避开浏览器原生 (Ctrl+1/2/3 切 tab · Ctrl+J 下载 · Ctrl+B 收藏栏 · Ctrl+W/T 关/开 tab)
 *   - keydown 时检查 `event.isComposing` / `event.keyCode === 229` (中文输入法组词中)
 *   - target 是 input/textarea/contenteditable 时跳过非 Esc / Ctrl+/ (允许"focus composer"在输入框里也能撤焦再聚)
 *   - macOS:Cmd 与 Ctrl 同义 (event.metaKey || event.ctrlKey)
 *
 * 注册:在 App 顶层调用 `useGlobalShortcuts()` 一次。
 */

import { useEffect } from 'react';
import { t } from '@/i18n';
import { useShellStore } from '../store';
import { loadWorkbenchList, setActiveWorkbench } from './workbenches';

export interface ShortcutDef {
  /** 显示给用户的字符串,e.g. "Ctrl+Shift+F"。Mac 上 UI 会自动替换 Ctrl → ⌘/⌃。 */
  combo: string;
  /** 触发条件:keydown event → boolean。 */
  match: (e: KeyboardEvent) => boolean;
  /** 一行描述,显示在 Settings 表里。 */
  label: string;
  /** 分组(Layout / Mode / Overlay / Focus / general / edit)。 */
  group: 'layout' | 'mode' | 'overlay' | 'focus' | 'general' | 'edit';
  /** 触发动作。返回 true 表示 preventDefault。 */
  run: () => boolean | void;
  /** Esc 这种允许在 input 里触发(其他必须 target 不是 editable 才触发)。 */
  allowInInput?: boolean;
}

// Helper: is the event happening inside a text-editing surface?
// Guards against non-Element targets (e.g. window / document from synthetic
// dispatch) where .tagName / .closest aren't defined.
// Exported for unit tests (T4-9 typing-target-guard coverage).
export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!t || !(t instanceof Element)) return false;
  const tag = (t as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((t as HTMLElement).isContentEditable) return true;
  // RichInput composer (custom contenteditable wrapper)
  if (t.closest('.kc-composer-rich, [data-kc-composer], [contenteditable="true"]')) return true;
  return false;
}

// IME-composing check — Chinese input methods send a stream of keydowns
// while composing; key === "Process" or keyCode === 229 signals "the user
// is in IME, don't intercept anything."
// Exported for unit tests (T4-9 IME-guard coverage).
export function isComposing(e: KeyboardEvent): boolean {
  if (e.isComposing) return true;
  if (e.keyCode === 229) return true;
  if (e.key === 'Process') return true;
  return false;
}

// Ctrl-or-Cmd helper.
function mod(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

// ── Editor keyboard-router deps (keyboard-router convergence, M4 T4-1..T4-3) ──
// The interface package is editor-agnostic (lint:agnostic forbids importing
// @forgeax/editor), so the edit-domain shortcuts (Delete / Backspace / F2 /
// Ctrl+D / Ctrl+A / G) are injected by the host editor via
// registerKeyboardRouterDeps. Each dep is a thin callback the editor wires to
// its own gateway / selection / viewport-quadrant — the router stays a pure
// dispatcher and never touches editor state directly (G-1 / AC-A1: still ONE
// global keydown listener — the one in useGlobalShortcuts below).
export interface RouterSelectedAsset {
  guid: string;
  kind: string;
  name: string;
  packPath: string;
  payload: Record<string, unknown>;
}

export interface KeyboardRouterDeps {
  /** Dispatch an editor op through the one gateway door. */
  dispatch: (op: { kind: string; [k: string]: unknown }, origin?: string) => void;
  /** Current entity-selection handles (for Delete / F2 / Ctrl+D routing). */
  getEntitySelection: () => number[];
  /** Current asset-selection list (for Delete / F2 / Ctrl+D routing). */
  getAssetSelection: () => RouterSelectedAsset[];
  /** Derive of "who was selected last" — drives triple-domain key routing (AC-C1). */
  getLastSelectionDomain: () => 'entity' | 'asset' | 'folder' | null;
  /** True under ▶ Play (entity-domain Delete must early-return, AC-A5b). */
  isPlayMode: () => boolean;
  /** Current viewport display axis (for G toggle, AC-Cb4). */
  getDisplay: () => 'scene' | 'game';
  /** Current input owner (for G: play·game yields to the game, T0-10 / RK-10). */
  getInputTarget: () => 'scene' | 'game';
  /** Entity: delete the given handles (cascade, one undo step). */
  deleteEntities: (ids: number[]) => void;
  /** Entity: duplicate the given handles. */
  duplicateEntities: (ids: number[]) => void;
  /** Entity: open rename for the given handle. */
  renameEntity: (id: number) => void;
  /** Entity: select all entities. */
  selectAllEntities: () => void;
  /** Asset: delete the given assets (UI-layer guard dialog if needed, AC-C2). */
  deleteAssets: (assets: RouterSelectedAsset[]) => void;
  /** Asset: duplicate the given asset (guid, packPath). */
  duplicateAsset: (guid: string, packPath: string) => void;
  /** Asset: rename the given asset (guid, packPath). */
  renameAsset: (guid: string, packPath: string) => void;
  /** Asset: select all assets in the active browser (CB-scoped, wired by CB). */
  selectAllAssets: () => void;
  /** Folder: get current folder selection paths (D3b). */
  getFolderSelection?: () => { path: string }[];
  /** Folder: delete the given folders (D3b). */
  deleteFolders?: (folders: { path: string }[]) => void;
}

let routerDeps: KeyboardRouterDeps | null = null;
/** Inject the editor-side callbacks the router needs. Called once at host boot
 *  (forgeax-editor standalone/main.tsx) BEFORE the App mounts (useGlobalShortcuts
 *  reads this at effect time, which is after mount, so registration first is safe). */
export function registerKeyboardRouterDeps(deps: KeyboardRouterDeps | null): void {
  routerDeps = deps;
}

// Build the edit-domain shortcut list from injected deps. Pure dispatcher: every
// branch routes through a dep callback (which the editor maps onto gateway ops),
// so this file stays editor-agnostic. Three-layer guards (IME / typing-target /
// play-mode) are enforced by the host's onKey wrapper (isComposing / isTypingTarget)
// plus the per-op play-mode checks below.
function editShortcuts(deps: KeyboardRouterDeps): ShortcutDef[] {
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

  // Triple-domain Delete (AC-C2): folder → asset → entity.
  // Entity+play early-returns (edit-rejected-in-play).
  const routeDelete = (): boolean => {
    const domain = deps.getLastSelectionDomain() ?? 'entity';
    if (domain === 'folder') {
      const folders = deps.getFolderSelection?.();
      if (folders && folders.length > 0) { deps.deleteFolders?.(folders); return true; }
      return false;
    }
    if (domain === 'asset') {
      const assets = deps.getAssetSelection();
      if (assets.length > 0) { deps.deleteAssets(assets); return true; }
      return false;
    }
    if (deps.isPlayMode()) return false; // let the key fall through in play
    const ids = deps.getEntitySelection();
    if (ids.length > 0) { deps.deleteEntities(ids); return true; }
    return false;
  };
  const routeF2 = (): boolean => {
    const domain = deps.getLastSelectionDomain() ?? 'entity';
    if (domain === 'asset') {
      const a = deps.getAssetSelection()[0];
      if (a) { deps.renameAsset(a.guid, a.packPath); return true; }
      return false;
    }
    const id = deps.getEntitySelection()[0];
    if (id != null) { deps.renameEntity(id); return true; }
    return false;
  };
  const routeCtrlD = (): boolean => {
    const domain = deps.getLastSelectionDomain() ?? 'entity';
    if (domain === 'asset') {
      for (const a of deps.getAssetSelection()) deps.duplicateAsset(a.guid, a.packPath);
      return true;
    }
    const ids = deps.getEntitySelection();
    if (ids.length > 0) { deps.duplicateEntities(ids); return true; }
    return false;
  };
  const routeCtrlA = (): boolean => {
    const domain = deps.getLastSelectionDomain() ?? 'entity';
    if (domain === 'asset') deps.selectAllAssets();
    else deps.selectAllEntities();
    return true;
  };
  // G display toggle (AC-Cb4): play·game + inputTarget==='game' yields to the
  // game (T0-10). Otherwise toggle scene⇄game through the setDisplay session op.
  const routeG = (): boolean => {
    if (deps.getInputTarget() === 'game') return false;
    deps.dispatch(
      { kind: 'setDisplay', display: deps.getDisplay() === 'game' ? 'scene' : 'game' },
      'human',
    );
    return true;
  };

  return [
    {
      combo: isMac ? 'Backspace' : 'Delete',
      group: 'edit',
      label: 'Delete selection',
      match: (e) => e.key === 'Delete' || (isMac && e.key === 'Backspace'),
      run: routeDelete,
    },
    {
      combo: 'F2',
      group: 'edit',
      label: 'Rename selection',
      match: (e) => !mod(e) && !e.shiftKey && !e.altKey && e.key === 'F2',
      run: routeF2,
    },
    {
      combo: 'Ctrl+D',
      group: 'edit',
      label: 'Duplicate selection',
      match: (e) => mod(e) && !e.shiftKey && !e.altKey
        && (e.code === 'KeyD' || e.key.toLowerCase() === 'd'),
      run: routeCtrlD,
    },
    {
      combo: 'Ctrl+A',
      group: 'edit',
      label: 'Select all (entity / asset)',
      match: (e) => mod(e) && !e.shiftKey && !e.altKey
        && (e.code === 'KeyA' || e.key.toLowerCase() === 'a'),
      run: routeCtrlA,
    },
    {
      combo: 'G',
      group: 'edit',
      label: 'Toggle viewport display (scene ⇄ game)',
      match: (e) => !mod(e) && !e.shiftKey && !e.altKey
        && (e.key === 'g' || e.key === 'G'),
      run: routeG,
    },
  ];
}

// Build the shortcut registry. Each match() / run() is plain JS so we can
// drive them from a Settings table later (or a Command Palette).
export function buildShortcuts(): ShortcutDef[] {
  const store = useShellStore.getState;
  const shortcuts: ShortcutDef[] = [
    // ── Layout (collapse / fullscreen) ──
    {
      combo: 'Ctrl+Shift+F',
      group: 'layout',
      label: t('shortcuts.gameFullscreen'),
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyF',
      run: () => { store().toggleFullscreen(); return true; },
    },
    {
      combo: 'Ctrl+Shift+Enter',
      group: 'layout',
      label: t('shortcuts.browserFullscreen'),
      match: (e) => mod(e) && e.shiftKey && (e.code === 'Enter' || e.key === 'Enter'),
      run: () => {
        // Browser-native fullscreen toggle. Independent of store.fullscreen
        // — user can have either, both, or neither. Esc exits the native FS
        // automatically; fullscreenchange listener below keeps state in sync
        // if needed (we don't currently mirror native FS into the store,
        // because the two modes are intentionally orthogonal).
        try {
          if (!document.fullscreenElement) {
            void document.documentElement.requestFullscreen?.().catch(() => { /* blocked */ });
          } else {
            void document.exitFullscreen?.().catch(() => { /* */ });
          }
        } catch { /* old browsers without FS API */ }
        return true;
      },
    },
    {
      combo: 'Ctrl+Shift+B',
      group: 'layout',
      label: t('shortcuts.toggleSidebar'),
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyB',
      run: () => { store().toggleSidebar(); return true; },
    },
    {
      combo: 'Ctrl+Shift+C',
      group: 'layout',
      label: t('shortcuts.toggleChatPanel'),
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyC',
      run: () => { store().toggleChatpanel(); return true; },
    },

    // ── Overlay (Dashboard / Settings) ──
    {
      combo: 'Ctrl+Shift+D',
      group: 'overlay',
      label: t('shortcuts.toggleDashboard'),
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyD',
      run: () => { const s = store(); s.activeOverlay === 'dashboard' ? s.closeOverlay() : s.openOverlay('dashboard'); return true; },
    },
    {
      combo: 'Ctrl+,',
      group: 'overlay',
      label: t('shortcuts.toggleSettings'),
      match: (e) => mod(e) && !e.shiftKey && (e.key === ',' || e.code === 'Comma'),
      run: () => { const s = store(); s.activeOverlay === 'settings' ? s.closeOverlay() : s.openOverlay('settings'); return true; },
    },
    {
      combo: 'Ctrl+H',
      group: 'overlay',
      label: t('shortcuts.openChangelog'),
      match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyH',
      run: () => { store().openOverlay('settings', 'changelog'); return true; },
    },
    {
      combo: 'Esc',
      group: 'overlay',
      label: t('shortcuts.closeOverlay'),
      allowInInput: true,
      match: (e) => e.key === 'Escape' && !mod(e) && !e.shiftKey && !e.altKey,
      run: () => {
        const s = store();
        // Browser fullscreen exits automatically on Esc — but be defensive
        // in case some browser swallows the event before reaching the native
        // handler; explicit exit is a no-op when no element is fullscreen.
        if (document.fullscreenElement) {
          void document.exitFullscreen?.().catch(() => { /* */ });
          return true;
        }
        if (s.fullscreen)     { s.setFullscreen(false); return true; }
        if (s.activeOverlay)  { s.closeOverlay(); return true; }
        return false;
      },
    },

    // ── Workbench switch (Blender parity: Ctrl+Shift+1..9 → workbench N) ──
    // P3.5 · Was three fixed-mode bindings (Viewport / Workbench / Plugins);
    // now indexes into loadWorkbenchList().list so custom workbenches are
    // reachable by ordinal, matching Blender's workspace-tab shortcut
    // ergonomic and VSCode's Ctrl+N-tab switcher.
    //
    // Mode side-effect: we can't call setMode directly here — the derivation
    // 'scene' vs 'ai' lives in modeForWorkbench() in WorkbenchSwitcher.tsx. To
    // avoid a shortcuts → component import cycle, we mirror the same rule
    // inline (only 'scene' id → 'scene' mode; every other id → 'ai' mode).
    // WorkbenchSwitcher subscribes to workbench-list changes and re-renders,
    // but AppMode is a store field — someone has to write it.
    ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n): ShortcutDef => ({
      combo: `Ctrl+Shift+${n}`,
      group: 'mode',
      label: t('shortcuts.switchWorkbenchN', { n }),
      match: (e) => mod(e) && e.shiftKey && e.code === `Digit${n}`,
      run: () => {
        const { list } = loadWorkbenchList();
        const wb = list[n - 1];
        if (!wb) return false; // no Nth workbench — let default browser behavior through
        setActiveWorkbench(wb.id);
        store().setMode(wb.id === 'scene' ? 'scene' : 'ai');
        return true;
      },
    })),
    {
      combo: 'Ctrl+Shift+0',
      group: 'overlay',
      label: t('shortcuts.openPlugins'),
      match: (e) => mod(e) && e.shiftKey && (e.code === 'Digit0' || e.key === '0' || e.key === ')'),
      run: () => { store().openOverlay('settings', 'plugins'); return true; },
    },

    // ── Focus ──
    {
      combo: 'Ctrl+/',
      group: 'focus',
      label: t('shortcuts.focusComposer'),
      allowInInput: true,
      match: (e) => mod(e) && !e.shiftKey && (e.key === '/' || e.code === 'Slash'),
      run: () => {
        // Auto-uncollapse first if hidden.
        const s = store();
        if (s.chatpanelCollapsed) s.toggleChatpanel();
        // Focus the composer's editable element. Selector covers RichInput
        // (preferred new path) and the legacy textarea fallback.
        const el =
          document.querySelector<HTMLElement>('.kc-composer-rich [contenteditable="true"]') ||
          document.querySelector<HTMLElement>('.kc-composer textarea') ||
          document.querySelector<HTMLElement>('[data-kc-composer]');
        if (el) {
          el.focus();
          // Move caret to end if it's a contenteditable
          if (el.isContentEditable) {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        }
        return true;
      },
    },
  ];
  // Inject the host editor's edit-domain shortcuts (Delete / F2 / Ctrl+D /
  // Ctrl+A / G) when deps were registered at boot. Keeps this file editor-agnostic.
  if (routerDeps) shortcuts.push(...editShortcuts(routerDeps));
  return shortcuts;
}

/**
 * Mount once at App root. Returns nothing — purely an effect.
 *
 * `passive: false` so we can preventDefault — required for Ctrl+, (Chrome
 * historically had no native binding but treat it as user gesture) and
 * Ctrl+Shift+1/2/3 (which Chrome maps to tab switching only WITHOUT Shift,
 * so we're safe, but we preventDefault anyway).
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const shortcuts = buildShortcuts();
    const onKey = (e: KeyboardEvent) => {
      // 0. IME composing — bail. Never intercept Chinese pinyin chord.
      if (isComposing(e)) return;
      // 1. Find first matching shortcut.
      for (const s of shortcuts) {
        if (!s.match(e)) continue;
        // 2. Typing target → only allow shortcuts marked allowInInput.
        if (isTypingTarget(e) && !s.allowInInput) return;
        const shouldPreventDefault = s.run() !== false;
        if (shouldPreventDefault) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey, true); // capture-phase: beat ChatPanel handlers
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

// macOS pretty-printing for shortcut combos shown in Settings.
// Returns the canonical UI string. Not platform-detected — we just always
// render Ctrl on Linux/Win and ⌘ on Mac.
export function prettyCombo(combo: string): string {
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  if (!isMac) return combo;
  return combo
    .replace(/Ctrl/g, '⌘')
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g, '⌥')
    .replace(/\+/g, '');
}
