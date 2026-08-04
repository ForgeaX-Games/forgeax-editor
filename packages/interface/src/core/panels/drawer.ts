// packages/interface/src/core/panels/drawer.ts
//
// ADR-0030 §2.3 — the `drawer` location member of the ShellContribution family.
// A drawer panel is a bottom PanelContribution (a View): it registers a launcher
// tab at the bottom that expands UPWARD into a resizable, single-active panel
// (UE Content-Browser style). Its launcher tab is DERIVED from the contribution
// (ADR-0030 §2.3) — you do not register the launcher separately.
//
// The drawer location's capabilities (fixed for 'drawer.bottom'):
//   overlay: true · resizable: 'vertical' · singleActive: true
// left edge = screen left, right edge = flush against the plugin rail.
import type { ReactNode } from 'react';

/** The only built-in drawer location today. Adding a side drawer later is a new
 *  location id + geometry, not a new code path (ADR-0030 §1). */
export type DrawerLocationId = 'drawer.bottom';

export interface DrawerPanelContribution {
  readonly kind?: 'panel';
  readonly id: string;
  /** Display title fallback (used verbatim when `titleKey` is absent or its key
   *  is missing). Keep it a human-readable literal, not an id. */
  readonly title: string;
  /** i18n key resolved through `t()` at render time; when set it wins over
   *  `title`. Built-ins set this; plugins may pass only a literal `title`. */
  readonly titleKey?: string;
  /** lucide icon name for the launcher tab (resolved by DrawerHostView). */
  readonly icon?: string;
  readonly location?: DrawerLocationId;
  /** Launcher tab order within the drawer. Lower = earlier. Default 0. */
  readonly order?: number;
  /** Conditional visibility of the launcher tab. Missing = always visible. */
  readonly when?: () => boolean;
  /** Panel body renderer (in-process). */
  readonly render: () => ReactNode;
}
