/**
 * Shared Lucide mapping for Workbench modules.
 * Used by Sidebar `WorkbenchModuleStrip` and MainArea `WbGallery` — keep in sync.
 */
import {
  Archive,
  BarChart3,
  Blocks,
  BookOpen,
  Box,
  Clapperboard,
  Code2,
  Cpu,
  Film,
  Gamepad2,
  LayoutDashboard,
  Map as MapIcon,
  MessageSquareText,
  Music2,
  Palette,
  Package,
  PencilRuler,
  Plug,
  Settings,
  Sparkles,
  Telescope,
  User,
  UserCog,
  type LucideIcon,
} from 'lucide-react';

const WORKBENCH_ICON_BY_ID: Record<string, LucideIcon> = {
  character: MessageSquareText,
  'wb-character': MessageSquareText,
  'character-forge': PencilRuler,
  'wb-narrative': BookOpen,
  'wb-lowpoly-obj': User,
  ui: LayoutDashboard,
  narrative: BookOpen,
  skill: Sparkles,
  items: Package,
  'wb-observatory': Telescope,
  anim: Film,
  reel: Clapperboard,
  bgm: Music2,
  scene: MapIcon,
  look: Palette,
  balance: BarChart3,
  'wb-agent-persona': UserCog,
  code: Code2,
  'plugin-author': Plug,
  admin: Settings,
  library: Archive,
  'wb-template': Blocks,
};

export function iconForWorkbenchModule(input: {
  workbenchId: string;
  label?: string;
  pluginId?: string;
}): LucideIcon {
  const workbenchId = input.workbenchId.replace(/^wb:/, '').toLowerCase();
  const explicitIcon = WORKBENCH_ICON_BY_ID[workbenchId];
  if (explicitIcon) return explicitIcon;

  const key = `${workbenchId} ${input.label ?? ''} ${input.pluginId ?? ''}`.toLowerCase();
  if (key.includes('narrative') || key.includes('叙事') || key.includes('story') || key.includes('剧情')) return BookOpen;
  if (key.includes('character-forge') || key.includes('生成')) return PencilRuler;
  if (key.includes('lowpoly') || key.includes('humanoid')) return User;
  if (key.includes('character') || key.includes('角色')) return MessageSquareText;
  if (key.includes('narrative') || key.includes('story') || key.includes('叙事')) return BookOpen;
  if (key.includes('observatory') || key.includes('observe') || key.includes('观测')) return Telescope;
  if (key.includes('persona') || key.includes('agent persona')) return UserCog;
  if (key.includes('scene') || key.includes('场景') || key.includes('pcg')) return MapIcon;
  if (key.includes('skill') || key.includes('vfx') || key.includes('技能')) return Sparkles;
  if (key.includes('look') || key.includes('色彩') || key.includes('art')) return Palette;
  if (key.includes('library') || key.includes('asset') || key.includes('素材')) return Archive;
  if (key.includes('items') || key.includes('道具')) return Package;
  if (key.includes('anim') || key.includes('动画')) return Film;
  if (key.includes('reel') || key.includes('fmv') || key.includes('影游')) return Clapperboard;
  if (key.includes('bgm') || key.includes('music') || key.includes('音乐')) return Music2;
  if (key.includes('balance') || key.includes('数值')) return BarChart3;
  if (key.includes('ui') || key.includes('界面')) return LayoutDashboard;
  if (key.includes('admin') || key.includes('管理')) return Settings;
  if (key.includes('code') || key.includes('script') || key.includes('工程')) return Code2;
  if (key.includes('template')) return Blocks;
  if (key.includes('game') || key.includes('play')) return Gamepad2;
  if (key.includes('provider') || key.includes('plugin')) return Plug;
  if (key.includes('engine') || key.includes('runtime')) return Cpu;
  return Box;
}
