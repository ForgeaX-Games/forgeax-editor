import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Box, Bot } from 'lucide-react';
import { useShellStore } from '../../store';
import { listExtensions, type ExtensionInfo } from '../../lib/extension-api';
import { useSurface, type UISurfaceActionDef } from '../../lib/surface';
import { extensionRendersInMainArea } from '../MainArea/WorkbenchExtensionHost';
import { iconForWorkbenchModule } from '../../lib/workbench-module-icons';
import { setActiveWorkbench } from '../../lib/workbenches';
import { useActiveWorkbench } from '../../lib/useWorkbench';
import { useTranslation } from '@/i18n';
import './ActivityRail.css';

// Shell-level persistent left activity bar (Approach B). Lives in `.studio-body`
// as fixed chrome OUTSIDE dockview, so it survives Scene↔AI workbench switches —
// it is the single top-level nav that replaces the old Scene/AI capsule:
//   编辑器 → Scene editor layout · Agents → agent list · <plugins> · 插件制作/商店
// Switching logic reuses the shipped store transitions (setActiveWorkbench +
// openWorkbench), same path the workbench.open_plugin action uses.
//
// Plugin grouping/ordering/labels follow the product spec (curated below), NOT
// manifest position/displayName: three categories (3D / 2D / 通用) in this order,
// group-internal order = the spec row order, and each item's label is the spec's
// short name. Only spec'd plugins appear (matched by slug = manifest.id minus the
// `@forgeax-extension/` prefix); `hidden` manifests still show if spec'd
// (e.g. wb-lowpoly-obj). Un-spec'd workbench plugins are intentionally omitted.

interface RailItem {
  id: string; // wb:<workbench.id> — the tab id openWorkbench expects
  slug: string;
  label: string;
  manifest: ExtensionInfo;
}

// Product spec: category → ordered plugin slugs.
// 暂时隐藏(功能未就绪):方块人编辑(wb-lowpoly-obj)、Diffusion Renderer
// (wb-diffusion-renderer)。就绪后把 slug 加回对应分组即可恢复。
const RAIL_CATEGORIES: ReadonlyArray<{ category: string; slugs: readonly string[] }> = [
  { category: '3D', slugs: ['wb-skill', 'wb-gen3d', 'wb-3d-lowpoly'] },
  { category: '2D', slugs: ['wb-character', 'wb-items', 'wb-anim', 'wb-2d-scene-asset-generator'] },
  { category: '通用', slugs: ['wb-ui', 'wb-narrative', 'wb-reel', 'wb-game-video', 'wb-bgm', 'wb-scene-generator'] },
];
// Product spec: slug → short display name (产品规范名称).
const RAIL_LABELS: Record<string, string> = {
  'wb-skill': '技能特效',
  'wb-gen3d': '3D角色',
  'wb-3d-lowpoly': '3D低多边形',
  'wb-character': '角色编辑',
  'wb-items': '道具图标',
  'wb-anim': '动画设计',
  'wb-2d-scene-asset-generator': '2D场景资产',
  'wb-ui': 'UI设计',
  'wb-narrative': '叙事设计',
  'wb-reel': '影游工坊',
  'wb-game-video': '视频游戏',
  'wb-bgm': '音乐音效',
  'wb-scene-generator': '场景生成',
};

function slugOf(manifestId: string): string {
  return manifestId.replace(/^@forgeax-extension\//, '').replace(/^@forgeax-plugin\//, '');
}

// P9 dual-modality — schema the AI reads to learn selectTab / setMode value ranges.
const HOST_SIDEBAR_SCHEMA = {
  type: 'object',
  properties: {
    workbenchTab: { type: 'string', description: 'Currently active workbench tab id (e.g. agents, wb:character)' },
    mode: { type: 'string', enum: ['scene', 'ai'] },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: ['builtin', 'bus'] },
        },
      },
    },
  },
} as const;

interface HostSidebarSnapshot {
  workbenchTab: string;
  mode: 'scene' | 'ai';
  entries: Array<{ id: string; label: string; kind: 'builtin' | 'bus' }>;
}

export function ActivityRail() {
  const { t } = useTranslation();
  const workbenchTab = useShellStore((s) => s.workbenchTab);
  // "mode" is derived from the active workspace (SSOT lives in workbenches.ts).
  // scene workspace → 'scene', every other workspace → 'ai'. No separate store field.
  const mode: 'scene' | 'ai' = useActiveWorkbench()?.id === 'scene' ? 'scene' : 'ai';
  const expandedExtensionId = useShellStore((s) => s.workbenchExpandedExtensionId);

  const [busExtensions, setBusExtensions] = useState<ExtensionInfo[] | null>(null);
  // Persistent component: retry the fetch a few times so a slow boot doesn't
  // pin the rail to an empty plugin list for the whole session.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    const RETRY_MS = 1500;
    const load = () => {
      attempts += 1;
      listExtensions('workbench')
        .then((res) => { if (!cancelled) setBusExtensions(res.items); })
        .catch(() => {
          if (cancelled) return;
          if (attempts >= MAX_ATTEMPTS) { setBusExtensions([]); return; }
          timer = setTimeout(load, RETRY_MS);
        });
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);

  // Curated groups per product spec. `hidden` is ignored (spec is authoritative);
  // missing plugins are dropped, empty groups collapse.
  const railGroups = useMemo(() => {
    const bySlug = new Map<string, ExtensionInfo>();
    for (const m of busExtensions ?? []) bySlug.set(slugOf(m.id), m);
    return RAIL_CATEGORIES
      .map(({ category, slugs }) => ({
        category,
        items: slugs
          .map((slug): RailItem | null => {
            const m = bySlug.get(slug);
            if (!m) return null;
            return { id: `wb:${m.workbench?.id ?? slug}`, slug, label: RAIL_LABELS[slug] ?? slug, manifest: m };
          })
          .filter((x): x is RailItem => x !== null),
      }))
      .filter((g) => g.items.length > 0);
  }, [busExtensions]);
  // Flat list (spec order) for the surface snapshot + keyboard nav + tab lookup.
  const railEntries = useMemo(() => railGroups.flatMap((g) => g.items), [railGroups]);
  const railEntriesRef = useRef(railEntries);
  railEntriesRef.current = railEntries;

  // 插件制作 opens the inline wb-plugin-author authoring panel (host-registered
  // in workbenchPanels, keyed by manifest id); 插件商店 opens the plugins-manager
  // overlay. Both reuse shipped surfaces — no new backend.
  const pluginAuthorId = useMemo(
    () => (busExtensions ?? []).find((m) => (m.workbench?.id ?? m.id) === 'plugin-author')?.id ?? null,
    [busExtensions],
  );
  const pluginAuthorActive = mode === 'ai' && !!pluginAuthorId && expandedExtensionId === pluginAuthorId;

  const entriesSlim = useMemo<HostSidebarSnapshot['entries']>(
    () => [
      { id: 'agents', label: 'Agents', kind: 'builtin' },
      ...railEntries.map((e) => ({ id: e.id, label: e.label, kind: 'bus' as const })),
    ],
    [railEntries],
  );
  const railSurface = useSurface<HostSidebarSnapshot, Record<string, UISurfaceActionDef>>({
    id: 'host.sidebar',
    layer: 'host',
    schema: HOST_SIDEBAR_SCHEMA as unknown as Record<string, unknown>,
    initialSnapshot: { workbenchTab, mode, entries: entriesSlim },
    actions: {
      selectTab: {
        id: 'selectTab',
        argsSchema: { type: 'object', required: ['tab'], properties: { tab: { type: 'string' } } },
        run: (raw) => {
          const a = (raw ?? {}) as { tab?: unknown };
          if (typeof a.tab !== 'string') return;
          // All selectTab targets (agents / plugins) live in the AI workbench, so
          // switch its dock layout first, then set tab + expanded atomically.
          setActiveWorkbench('ai');
          const entry = railEntriesRef.current.find((e) => e.id === a.tab);
          const manifest = entry?.manifest ?? null;
          useShellStore.getState().openWorkbench({
            tab: a.tab,
            expandedExtensionId: manifest && extensionRendersInMainArea(manifest) ? manifest.id : null,
          });
        },
      },
      setMode: {
        id: 'setMode',
        argsSchema: {
          type: 'object',
          required: ['mode'],
          properties: { mode: { type: 'string', enum: ['scene', 'ai'] } },
        },
        run: (raw) => {
          const a = (raw ?? {}) as { mode?: unknown };
          // "mode" maps 1:1 to a workspace id; switching the active workspace is
          // the single write (mode is derived from it).
          if (a.mode === 'scene' || a.mode === 'ai') {
            setActiveWorkbench(a.mode);
          }
        },
      },
    },
  });

  useEffect(() => {
    railSurface.setSnapshot({ workbenchTab, mode, entries: entriesSlim });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchTab, mode, entriesSlim]);

  const openEditor = () => { setActiveWorkbench('scene'); };
  const openAgents = () => { void railSurface.dispatch('selectTab', { tab: 'agents' }); };
  const openPlugin = (id: string) => { void railSurface.dispatch('selectTab', { tab: id }); };

  const editorActive = mode === 'scene';
  const agentsActive = mode === 'ai' && workbenchTab === 'agents';

  // Roving keyboard nav over the plugin buttons (flat index into railEntries).
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const n = railEntries.length;
    if (n === 0) return;
    let target = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') target = (idx + 1) % n;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') target = (idx - 1 + n) % n;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = n - 1;
    else return;
    e.preventDefault();
    openPlugin(railEntries[target]!.id);
    tabRefs.current[target]?.focus();
  };

  return (
    <nav
      className="activity-rail thin-scrollbar"
      role="tablist"
      aria-orientation="vertical"
      aria-label={t('sidebar.workbenchExtensionsHint')}
      data-fx-slot="ActivityRail"
    >
      <div className="activity-rail-group">
        <button
          type="button"
          className={`activity-rail-item${editorActive ? ' active' : ''}`}
          onClick={openEditor}
          title={t('sidebar.editor')}
          aria-label={t('sidebar.editor')}
          role="tab"
          aria-selected={editorActive}
          data-rail-action="editor"
        >
          <span className="activity-rail-item-ic" aria-hidden><Box size={22} strokeWidth={1.7} /></span>
          <span className="activity-rail-item-lb">{t('sidebar.editor')}</span>
        </button>
        <button
          type="button"
          className={`activity-rail-item${agentsActive ? ' active' : ''}`}
          onClick={openAgents}
          title="Agents"
          aria-label="Agents"
          role="tab"
          aria-selected={agentsActive}
          data-rail-action="agents"
        >
          <span className="activity-rail-item-ic" aria-hidden><Bot size={22} strokeWidth={1.7} /></span>
          <span className="activity-rail-item-lb">Agents</span>
        </button>
      </div>

      {railGroups.map((group) => (
        <div className="activity-rail-group" key={group.category} data-category={group.category}>
          {group.items.map((item) => {
            const flatIdx = railEntries.indexOf(item);
            const active = mode === 'ai' && !pluginAuthorActive && workbenchTab === item.id;
            const Icon = iconForWorkbenchModule({ workbenchId: item.id, label: item.label, extensionId: item.manifest.id });
            return (
              <button
                key={item.id}
                ref={(el) => { tabRefs.current[flatIdx] = el; }}
                type="button"
                className={`activity-rail-item${active ? ' active' : ''}`}
                onClick={() => openPlugin(item.id)}
                onKeyDown={(ev) => onTabKey(ev, flatIdx)}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={t('sidebar.tabTooltip', { label: item.label, id: item.manifest.id })}
                aria-label={item.label}
                data-extension-id={item.manifest.id}
              >
                <span className="activity-rail-item-ic" aria-hidden><Icon size={22} strokeWidth={1.7} /></span>
                <span className="activity-rail-item-lb">{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
