/**
 * Global keyboard shortcuts · Blender-inspired, IME-safe.
 *
 *   Ctrl+Shift+F  toggle fullscreen (hide TopBar / Sidebar / ChatPanel / StatusBar)
 *   Ctrl+,        open / close Settings
 *   Ctrl+Shift+B  toggle Sidebar
 *   Ctrl+Shift+C  toggle ChatPanel
 *   Ctrl+Shift+D  toggle Dashboard overlay
 *   Ctrl+Shift+1  mode: Preview
 *   Ctrl+Shift+2  mode: Workbench
 *   Ctrl+Shift+3  open Settings → Plugins (was the Bus mode tab)
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
import { useAppStore } from '../store';

export interface ShortcutDef {
  /** 显示给用户的字符串,e.g. "Ctrl+Shift+F"。Mac 上 UI 会自动替换 Ctrl → ⌘/⌃。 */
  combo: string;
  /** 触发条件:keydown event → boolean。 */
  match: (e: KeyboardEvent) => boolean;
  /** 一行描述,显示在 Settings 表里。 */
  label: string;
  /** 分组(Layout / Mode / Overlay / Focus)。 */
  group: 'layout' | 'mode' | 'overlay' | 'focus' | 'general';
  /** 触发动作。返回 true 表示 preventDefault。 */
  run: () => boolean | void;
  /** Esc 这种允许在 input 里触发(其他必须 target 不是 editable 才触发)。 */
  allowInInput?: boolean;
}

// Helper: is the event happening inside a text-editing surface?
// Guards against non-Element targets (e.g. window / document from synthetic
// dispatch) where .tagName / .closest aren't defined.
function isTypingTarget(e: KeyboardEvent): boolean {
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
function isComposing(e: KeyboardEvent): boolean {
  if (e.isComposing) return true;
  if (e.keyCode === 229) return true;
  if (e.key === 'Process') return true;
  return false;
}

// Ctrl-or-Cmd helper.
function mod(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

// Build the shortcut registry. Each match() / run() is plain JS so we can
// drive them from a Settings table later (or a Command Palette).
export function buildShortcuts(): ShortcutDef[] {
  const store = useAppStore.getState;
  return [
    // ── Layout (collapse / fullscreen) ──
    {
      combo: 'Ctrl+Shift+F',
      group: 'layout',
      label: '游戏全屏 · 只隐 Studio 自己的 TopBar / Sidebar / ChatPanel / StatusBar(浏览器边框还在)',
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyF',
      run: () => { store().toggleFullscreen(); return true; },
    },
    {
      combo: 'Ctrl+Shift+Enter',
      group: 'layout',
      label: '浏览器全屏(PPT 放映式)· 浏览器原生 fullscreen API(连标签栏 / 地址栏一起消失)',
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
      label: '切换左侧 Sidebar(工作台栏)',
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyB',
      run: () => { store().toggleSidebar(); return true; },
    },
    {
      combo: 'Ctrl+Shift+C',
      group: 'layout',
      label: '切换右侧 ChatPanel',
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyC',
      run: () => { store().toggleChatpanel(); return true; },
    },

    // ── Overlay (Dashboard / Settings) ──
    {
      combo: 'Ctrl+Shift+D',
      group: 'overlay',
      label: '切换 Dashboard 总览面板',
      match: (e) => mod(e) && e.shiftKey && e.code === 'KeyD',
      run: () => { const s = store(); s.setDashboardOpen(!s.dashboardOpen); return true; },
    },
    {
      combo: 'Ctrl+,',
      group: 'overlay',
      label: '打开 / 关闭 Settings 浮层',
      match: (e) => mod(e) && !e.shiftKey && (e.key === ',' || e.code === 'Comma'),
      run: () => { const s = store(); s.setSettingsOpen(!s.settingsOpen); return true; },
    },
    {
      combo: 'Ctrl+H',
      group: 'overlay',
      label: 'Settings → Changelog(版本迭代记录)',
      match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyH',
      run: () => { store().openSettings('changelog'); return true; },
    },
    {
      combo: 'Esc',
      group: 'overlay',
      label: '关闭当前浮层 · 浏览器全屏 → 游戏全屏 → Settings → Dashboard 依次撤回',
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
        if (s.settingsOpen)   { s.setSettingsOpen(false); return true; }
        if (s.dashboardOpen)  { s.setDashboardOpen(false); return true; }
        return false;
      },
    },

    // ── Top-level mode ──
    {
      combo: 'Ctrl+Shift+1',
      group: 'mode',
      label: '切到 Preview 模式',
      match: (e) => mod(e) && e.shiftKey && (e.code === 'Digit1' || e.key === '1' || e.key === '!'),
      run: () => { store().setMode('preview'); return true; },
    },
    {
      combo: 'Ctrl+Shift+2',
      group: 'mode',
      label: '切到 Workbench 模式',
      match: (e) => mod(e) && e.shiftKey && (e.code === 'Digit2' || e.key === '2' || e.key === '@'),
      run: () => { store().setMode('workbench'); return true; },
    },
    {
      combo: 'Ctrl+Shift+3',
      group: 'mode',
      label: 'Settings → Plugins(原 Bus mode tab)',
      match: (e) => mod(e) && e.shiftKey && (e.code === 'Digit3' || e.key === '3' || e.key === '#'),
      run: () => { store().openSettings('plugins'); return true; },
    },

    // ── Focus ──
    {
      combo: 'Ctrl+/',
      group: 'focus',
      label: '聚焦右侧 ChatPanel 输入框',
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
