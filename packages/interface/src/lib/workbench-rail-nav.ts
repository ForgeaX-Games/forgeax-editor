import { Bot, FolderOpen, LayoutGrid, type LucideIcon } from 'lucide-react';
import type { RailNavId } from '../components/Sidebar/sidebar-types';

/** Left rail primary nav — Lucide only (matches interface README: lucide-react). */
export const WORKBENCH_RAIL_NAV: {
  id: RailNavId;
  label: string;
  Icon: LucideIcon;
  large?: boolean;
}[] = [
  { id: 'agents', label: 'Agents', Icon: Bot },
  { id: 'files', label: 'Files', Icon: FolderOpen },
  { id: 'tools', label: 'Tools', Icon: LayoutGrid },
];
