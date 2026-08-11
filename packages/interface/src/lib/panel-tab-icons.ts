/**
 * Unified Lucide mapping for dockview panel tabs — the SSOT for "what icon does
 * this dock panel show". Mirrors the `iconForPage` pattern: one pure, react-free
 * resolver keyed by the bare panel id, so the dock
 * tab, the layout menu, and the in-panel header never drift on icon semantics.
 * Follow `DESIGN-SYSTEM.md` §icon rules — no ad-hoc per-file lucide imports in
 * consumers, no emoji.
 *
 * Panel ids come in two shapes: static/injected ids (`viewport`, `chat`, …) and
 * editor ids that dockview prefixes with `ep:` (`ep:hierarchy`). Callers may pass
 * either — the `ep:` prefix is stripped before lookup.
 */
import {
  Activity,
  Bell,
  Bot,
  Box,
  Flag,
  FolderTree,
  Grid3x3,
  History,
  Info,
  LayoutDashboard,
  LayoutGrid,
  ListChecks,
  ListTree,
  MessageSquare,
  Monitor,
  Package,
  Puzzle,
  Rocket,
  SlidersHorizontal,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/** Bare-panel-id → Lucide glyph. Keys are ids WITHOUT the `ep:` dock prefix. */
const ICON_BY_PANEL: Record<string, LucideIcon> = {
  // interface static panels (panelRegistry.tsx)
  tools: Wrench,
  main: LayoutDashboard,
  viewport: Monitor,
  chat: MessageSquare,
  agents: Bot,
  files: FolderTree,
  console: SquareTerminal,
  telemetry: Activity,
  info: Info,
  checkpoints: Flag,
  events: Bell,
  // editor business panels (EDITOR_PANELS, injected as ep:*)
  hierarchy: ListTree,
  inspector: SlidersHorizontal,
  assets: Package,
  history: History,
  capabilities: Puzzle,
  launcher: Rocket,
  'asset-overview': LayoutGrid,
  'asset-properties': ListChecks,
  'mesh-slots': Grid3x3,
};

/** Normalize a dock panel id to its bare form (drop the `ep:` editor prefix). */
export function barePanelId(id: string): string {
  return id.startsWith('ep:') ? id.slice(3) : id;
}

/**
 * Resolve the Lucide icon for a dock panel id. Never returns undefined — an
 * unmapped id (page-mode document panels, marketplace-injected workbench panels)
 * falls back to a neutral `Box` glyph rather than nothing.
 */
export function iconForDockPanel(id: string): LucideIcon {
  return ICON_BY_PANEL[barePanelId(id)] ?? Box;
}
