// packages/interface/src/core/extensions/detached-agents-browser.ts
//
// Day 8(ADR 0027)统一契约重写示例:本扩展不再手写 AppExtension 形状,
// 而是声明一份 forgeax-extension.json 语法的 manifest(与 marketplace /
// agentstudio 同一契约 SSOT),经 manifest-adapter 落 v9 槽
// (provides.workbench.surface:'detached' → panels.detached)。
import type React from 'react';
import type { WorkbenchManifest } from '@forgeax/types';
import { appExtensionFromManifest } from '../app-shell/manifest-adapter';
import type { AppExtension } from '../app-shell/types';

const manifest: WorkbenchManifest = {
  schemaVersion: 1,
  id: 'detached.agents-browser',
  version: '1.0.0',
  kind: 'workbench',
  displayName: { zh: 'Agents 浏览器', en: 'Agents Browser' },
  description: {
    zh: '弹出式 OS 窗口里的 Agents 浏览面板。',
    en: 'Agents browser panel rendered inside a detached OS window.',
  },
  author: { name: 'forgeax', email: 'dev@forgeax.local' },
  provides: { workbench: { id: 'agents-browser', surface: 'detached' } },
};

export function createDetachedAgentsBrowserExtension(AgentsBrowser: React.ComponentType): AppExtension {
  return appExtensionFromManifest({ manifest, components: { AgentsBrowser } });
}
