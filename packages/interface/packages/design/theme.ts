/**
 * Theme helpers shared by the host (interface) and every plugin.
 *
 * Dual marking: we set BOTH `data-theme="<name>"` (what `tokens.css` selectors
 * key off) and toggle the `.dark` class (what Tailwind's `dark:` variant reads
 * via the preset's `darkMode: ['selector', '[data-theme="dark"]']`). Keeping the
 * two in lockstep means CSS variables and Tailwind variants never disagree.
 *
 * ForgeaX is dark-only today, so `readTheme` defaults to `'dark'`. A future
 * light skin only needs to add `[data-theme="light"]` overrides in token CSS;
 * no `.tsx` changes required.
 */

export type ThemeName = 'dark' | 'light';

function resolveRoot(root?: HTMLElement): HTMLElement | null {
  if (root) return root;
  if (typeof document === 'undefined') return null;
  return document.documentElement;
}

export function applyTheme(theme: ThemeName, root?: HTMLElement): void {
  const el = resolveRoot(root);
  if (!el) return;
  el.dataset.theme = theme;
  el.classList.toggle('dark', theme === 'dark');
}

export function readTheme(root?: HTMLElement): ThemeName {
  const el = resolveRoot(root);
  const value = el?.dataset.theme;
  return value === 'light' ? 'light' : 'dark';
}
