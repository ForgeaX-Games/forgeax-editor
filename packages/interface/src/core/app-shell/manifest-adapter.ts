// packages/interface/src/core/app-shell/manifest-adapter.ts
//
// 契约归一(ADR 0027,双基座归一 Day 8):v9 分类槽接受统一 manifest 形状。
//
// 统一契约 = `forgeax-extension.json` 语法(@forgeax/types WorkbenchManifest,
// 与 marketplace / agentstudio(Day 6 vendored kernel)同一 SSOT)。本适配器
// 把声明式 manifest 翻成 AppExtension:v9 类目由 schema 既有的
// `provides.workbench.surface` 判别(零 schema fork):
//
//   surface 缺省/'dock' → panels(PanelDescriptor:title←displayName、
//                          order←position、icon←icon)
//   surface:'detached'  → detached[<组件键>]
//   surface:'chrome'    → chrome[<组件键>]
//   surface:'overlay'   → overlays[<组件键>]
//
// 组件本体经 `components` 注入(manifest 声明"有什么",宿主决定"怎么渲")。
// 逐 registry 完整映射表与排除清单见 docs/decisions/0027(tool /
// protocolAdapter / streamMiddleware 留 chat domain 层,不进本适配器)。
import { createElement, type ComponentType } from 'react';
import type { WorkbenchManifest } from '@forgeax/types';
import type { PanelRenderers } from '../../components/DockShell/panelRenderers';
import type { AppExtension } from './types';

export interface ManifestExtensionInput {
  readonly manifest: WorkbenchManifest;
  /** 组件注入表;dock 面板取首个组件,其余类目按键名落槽。 */
  readonly components: Record<string, ComponentType>;
}

function pickTitle(m: WorkbenchManifest): string {
  const dn = m.displayName as { zh?: string; en?: string } | string | undefined;
  if (typeof dn === 'string') return dn;
  return dn?.zh ?? dn?.en ?? m.id;
}

export function appExtensionFromManifest(input: ManifestExtensionInput): AppExtension {
  const { manifest, components } = input;
  const wb = manifest.provides.workbench;
  const surface = wb.surface ?? 'dock';

  let panels: Partial<PanelRenderers>;
  if (surface === 'detached' || surface === 'chrome') {
    panels = { [surface]: { ...components } } as Partial<PanelRenderers>;
  } else if (surface === 'overlay') {
    panels = { overlays: { ...components } } as Partial<PanelRenderers>;
  } else if (surface === 'slot') {
    // ai-workbench 槽件(MainAreaBody / SidebarAgents / CornerAgentPicker 等)
    panels = { slots: { ...components } } as Partial<PanelRenderers>;
  } else {
    const Component = Object.values(components)[0]!;
    panels = {
      panels: {
        [wb.id]: {
          title: pickTitle(manifest),
          order: wb.position,
          icon: wb.icon,
          render: () => createElement(Component),
        },
      },
    } as Partial<PanelRenderers>;
  }

  return {
    id: manifest.id,
    version: manifest.version,
    contributes: { panels },
  };
}
