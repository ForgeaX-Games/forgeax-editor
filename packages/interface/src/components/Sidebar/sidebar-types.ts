import type { LucideIcon } from 'lucide-react';
import type { ExtensionInfo } from '../../lib/extension-api';

export type BuiltinId = 'agents' | 'files';

export interface BuiltinEntry {
  kind: 'builtin';
  id: BuiltinId;
  label: string;
  Icon: LucideIcon;
}

export interface BusEntry {
  kind: 'bus';
  id: string;
  label: string;
  emoji: string;
  manifest: ExtensionInfo;
}

export type SidebarEntry = BuiltinEntry | BusEntry;

export type RailNavId = 'agents' | 'files' | 'tools';
