// Reference registry — the SINGLE source of truth for "what can be referenced
// into the Chat composer, and how".
//
// Background (see docs/features/editor-mode/editor-mode-architecture-review.md §A1):
// the right-click "引用到 Chat" pill used to be built by a 14-branch closest()
// chain in pill.ts AND a parallel closest() chain in menuRegistry.ts. The
// contract (which CSS class + data-* a component must expose to be referenceable)
// was implicit and duplicated — rename a class and references silently broke.
//
// Now there is ONE list (`REFERENCE_REGISTRY`). Both the pill builder
// (`buildPillFromTarget`) and the context-menu builder (`buildMenu`) read it.
// To make a new unit referenceable you add ONE entry here and expose the
// documented data-* attributes on its DOM node — nothing else.
//
// ── data-* contract ─────────────────────────────────────────────────────────
//   file row      .fp-row.file            data-fp-path (or .fp-name text)
//   dir row       .fp-row.dir             .fp-name text
//   agent card    .agent-card             data-agent-id (+ .ac-name text, data-role)
//   wb agent card .wm-agent-card          data-agent-id, data-agent-name
//   wb plugin     .ws-icon-btn            data-plugin-id, aria-label
//   preview game  .preview-toolbar        data-game-slug
//   console line  .console-row            (text content)
//   workspace tab .mode-tab               data-ws-id, data-ws-name
//   game row      .tb-game-row            data-game-slug
//   session row   .tb-game-row            data-session-id, data-session-name
//   chat msg      .kc-text/.kc-body       (text content)
//   user msg      .user-bubble            (text content)
//   bus plugin    [data-plugin-id]        data-plugin-id (+ first text line)
// ─────────────────────────────────────────────────────────────────────────────

import type { PillPayload } from './pill';
import { t } from '@/i18n';

/** Canonical visible label for the "send this into Chat" action. The ONLY
 *  place this string is defined — every menu reads it so the wording can never
 *  drift (it previously existed as 3 variants). */
export const REFERENCE_LABEL = t('reference.send_to_chat');

/** A copy action a unit can offer in its context menu (in addition to the
 *  reference action). Plain data so this module stays free of menu/JSX deps. */
export interface RefCopyItem {
  label: string;
  text: string;
}

/** One referenceable unit type. */
export interface RefDescriptor {
  /** Stable id (tests / telemetry). */
  kind: string;
  /** CSS selector; the first matching ancestor of the event target wins.
   *  Order in REFERENCE_REGISTRY = specificity priority (most specific first). */
  match: string;
  /** Build the pill payload from the matched element. Return null to skip
   *  (e.g. a required data-* is missing) and let later descriptors try. */
  build: (el: HTMLElement) => PillPayload | null;
  /** Optional extra copy items for this unit's context menu. */
  copy?: (el: HTMLElement) => RefCopyItem[];
  /** True when this unit has its OWN dedicated context menu (e.g. workspace
   *  tabs open a rename/delete menu via onContextMenu). The global ContextMenu
   *  then skips it entirely so the two menus don't stack and fight for clicks. */
  ownMenu?: boolean;
}

const text = (el: Element | null): string => (el?.textContent ?? '').trim();
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

export const REFERENCE_REGISTRY: RefDescriptor[] = [
  {
    kind: 'file',
    match: '.fp-row.file',
    build: (el) => {
      const path = el.dataset.fpPath || text(el.querySelector('.fp-name'));
      if (!path) return null;
      const name = path.split('/').pop() || path;
      return {
        kind: 'file', display: name, icon: '📄',
        detail: `[${t('reference.file_ref')}: \`${path}\`]`,
        tooltip: { title: `📄 ${t('reference.file')} · ${name}`, lines: [`${t('reference.path')}: ${path}`, t('reference.chip_hint')] },
      };
    },
    copy: (el) => {
      const path = el.dataset.fpPath || text(el.querySelector('.fp-name'));
      const name = path.split('/').pop() || path;
      return name ? [{ label: t('reference.copy_file_name'), text: name }] : [];
    },
  },
  {
    kind: 'dir',
    match: '.fp-row.dir',
    build: (el) => {
      const name = text(el.querySelector('.fp-name'));
      if (!name) return null;
      return {
        kind: 'dir', display: name, icon: '📁',
        detail: `[${t('reference.dir_ref')}: \`${name}\`]`,
        tooltip: { title: `📁 ${t('reference.directory')} · ${name}`, lines: [`${t('reference.dir_name')}: ${name}`] },
      };
    },
  },
  {
    kind: 'agent',
    match: '.agent-card',
    build: (el) => {
      const agentId = el.dataset.agentId || '';
      if (!agentId) return null;
      const name = text(el.querySelector('.ac-name')).replace('★', '').trim() || agentId;
      const role = el.dataset.role || '';
      return {
        kind: 'agent', display: name || agentId, icon: '🤝',
        detail: `@${agentId}`,
        tooltip: { title: `🤝 Agent · ${name}`, lines: [`id: ${agentId}`, role ? `role: ${role}` : ''].filter(Boolean) },
      };
    },
  },
  {
    kind: 'wb-agent',
    match: '.wm-agent-card[data-agent-id]',
    build: (el) => {
      const agentId = el.dataset.agentId || '';
      if (!agentId) return null;
      const name = el.dataset.agentName || agentId;
      return {
        kind: 'agent', display: name, icon: '🤝',
        detail: `@${agentId}`,
        tooltip: { title: `🤝 Agent · ${name}`, lines: [`id: ${agentId}`] },
      };
    },
  },
  {
    kind: 'wb-plugin',
    match: '.ws-icon-btn',
    build: (el) => {
      const pluginId = el.dataset.pluginId || '';
      if (!pluginId) return null;
      const label = el.getAttribute('aria-label') || pluginId;
      return {
        kind: 'tool', display: label, icon: '🔧',
        detail: `[${t('reference.workshop_plugin_ref')}: \`${pluginId}\` · ${label}]`,
        tooltip: { title: `🔧 ${t('reference.workshop_plugin')} · ${label}`, lines: [`plugin id: ${pluginId}`] },
      };
    },
  },
  {
    kind: 'preview-game',
    match: '.preview-toolbar',
    build: (el) => {
      const slug = el.dataset.gameSlug || '';
      if (!slug) return null;
      return {
        kind: 'game', display: slug, icon: '🎮',
        detail: `[${t('reference.current_game_ref')}: \`games/${slug}\`]`,
        tooltip: { title: `🎮 ${t('reference.current_game')} · ${slug}`, lines: [`slug: ${slug}`, `${t('reference.path_prefix')}: .forgeax/games/${slug}/`] },
      };
    },
  },
  {
    kind: 'console-row',
    match: '.console-row',
    build: (el) => {
      const line = text(el);
      if (!line) return null;
      return {
        kind: 'log', display: truncate(line, 40), icon: '📜',
        detail: `[${t('reference.console_log')}: \`${line}\`]`,
        tooltip: { title: t('reference.console_log_line'), lines: [line] },
      };
    },
    copy: (el) => { const line = text(el); return line ? [{ label: t('reference.copy_log_line'), text: line }] : []; },
  },
  {
    kind: 'workspace-tab',
    match: '.mode-tab[data-ws-id]',
    ownMenu: true, // TopBar opens a dedicated rename/delete/reference menu
    build: (el) => {
      const wsId = el.dataset.wsId || '';
      if (!wsId) return null;
      return buildWorkspacePill(wsId, el.dataset.wsName || wsId);
    },
  },
  {
    kind: 'game-row',
    match: '.tb-game-row[data-game-slug]',
    build: (el) => {
      const slug = el.dataset.gameSlug || '';
      if (!slug) return null;
      return {
        kind: 'game', display: slug, icon: '🎮',
        detail: `[${t('reference.game_ref')}: \`games/${slug}\`]`,
        tooltip: { title: `🎮 Game · ${slug}`, lines: [`${t('reference.path')}: .forgeax/games/${slug}/`, `slug: ${slug}`] },
      };
    },
    copy: (el) => { const s = el.dataset.gameSlug || ''; return s ? [{ label: t('reference.copy_slug'), text: s }] : []; },
  },
  {
    kind: 'session-row',
    match: '.tb-game-row[data-session-id]',
    build: (el) => {
      const sid = el.dataset.sessionId || '';
      if (!sid) return null;
      const name = el.dataset.sessionName || sid.slice(0, 8);
      return {
        kind: 'tool', display: name, icon: '💬',
        detail: `[${t('reference.session_ref')}: sid=${sid} name="${name}"]`,
        tooltip: { title: `💬 Session · ${name}`, lines: [`sid: ${sid}`] },
      };
    },
    copy: (el) => { const s = el.dataset.sessionId || ''; return s ? [{ label: t('reference.copy_session_id'), text: s }] : []; },
  },
  {
    kind: 'chat-msg',
    match: '.kc-text, .kc-body',
    build: (el) => {
      const raw = text(el);
      if (!raw) return null;
      const head = truncate(raw, 60);
      return {
        kind: 'log', display: head, icon: '💭',
        detail: `[${t('reference.chat_ref')}: "${truncate(raw, 200)}"]`,
        tooltip: { title: `💭 ${t('reference.chat_message_ref')}`, lines: [head] },
      };
    },
    copy: (el) => { const m = text(el); return m ? [{ label: t('reference.copy_message'), text: m }] : []; },
  },
  {
    kind: 'user-msg',
    match: '.user-bubble',
    build: (el) => {
      const raw = text(el);
      if (!raw) return null;
      const head = truncate(raw, 60);
      return {
        kind: 'log', display: head, icon: '🧑',
        detail: `[${t('reference.user_message_ref')}: "${truncate(raw, 200)}"]`,
        tooltip: { title: `🧑 ${t('reference.user_message_ref')}`, lines: [head] },
      };
    },
    copy: (el) => { const m = text(el); return m ? [{ label: t('reference.copy_message'), text: m }] : []; },
  },
  {
    kind: 'bus-plugin',
    match: '[data-plugin-id]',
    build: (el) => {
      // ws-icon-btn already handled above; skip it here so we don't double-match.
      if (el.closest('.ws-icon-btn')) return null;
      const pluginId = el.dataset.pluginId || '';
      if (!pluginId) return null;
      const label = truncate(text(el).split('\n')[0] || pluginId, 40);
      return {
        kind: 'tool', display: label || pluginId, icon: '🔌',
        detail: `[${t('reference.bus_plugin_ref')}: id="${pluginId}" label="${label}"]`,
        tooltip: { title: `🔌 ${t('reference.bus_plugin')} · ${label}`, lines: [`plugin id: ${pluginId}`] },
      };
    },
    copy: (el) => { const id = el.dataset.pluginId || ''; return id ? [{ label: t('reference.copy_plugin_id'), text: id }] : []; },
  },
];

/** Walk the registry and return the first matching unit for an event target. */
export function buildReferenceFor(
  target: Element | null,
): { el: HTMLElement; descriptor: RefDescriptor; pill: PillPayload } | null {
  if (!target) return null;
  for (const descriptor of REFERENCE_REGISTRY) {
    const el = target.closest<HTMLElement>(descriptor.match);
    if (!el) continue;
    const pill = descriptor.build(el);
    if (pill) return { el, descriptor, pill };
    // matched the selector but data was missing — keep trying other descriptors.
  }
  return null;
}

/** Back-compat thin wrapper: DOM target → pill payload (or null). */
export function buildPillFromTarget(target: Element | null): PillPayload | null {
  return buildReferenceFor(target)?.pill ?? null;
}

// ── Editor-iframe reference builders ─────────────────────────────────────────
// The editor (✎ Edit) lives in an iframe; its units (entities/assets/components)
// can't be reached by the DOM registry above, so the iframe posts a
// VAG_EDITOR_REF message and App.tsx's listener turns it into a pill. Those builders
// live HERE too so pill construction (icons/labels/detail format) has a single
// home and can't drift from the DOM path.

export function buildEntityPill(p: { id?: number | string; name: string; components?: unknown; source?: { plugin?: string; docId?: string } }): PillPayload {
  const comps = Array.isArray(p.components) ? (p.components as string[]).join(', ') : '';
  const srcStr = p.source?.plugin ? ` ${t('reference.source')}=${p.source.plugin}/${p.source.docId ?? ''}` : '';
  return {
    kind: 'entity', display: p.name, icon: '🎯',
    detail: `[${t('reference.scene_entity')}: id=${p.id} name="${p.name}"${comps ? ` components=[${comps}]` : ''}${srcStr}]`,
    tooltip: {
      title: `🎯 ${t('reference.scene_entity')} · ${p.name}`,
      lines: [`id: ${p.id}`, comps ? `${t('reference.components')}: ${comps}` : '', p.source?.plugin ? `${t('reference.source')}: ${p.source.plugin}/${p.source.docId ?? ''}` : ''].filter(Boolean),
    },
  };
}

export function buildAssetPill(p: { guid: string; name?: string; assetKind?: string; packPath?: string }): PillPayload {
  const name = p.name ?? p.guid.slice(0, 8);
  return {
    kind: 'entity', display: name, icon: '🧱',
    detail: `[${t('reference.asset')}: guid=${p.guid} kind=${p.assetKind ?? ''}${p.packPath ? ` pack=${p.packPath}` : ''}]`,
    tooltip: {
      title: `🧱 ${t('reference.asset')} · ${name}`,
      lines: [`guid: ${p.guid}`, p.assetKind ? `kind: ${p.assetKind}` : '', p.packPath ? `pack: ${p.packPath}` : ''].filter(Boolean),
    },
  };
}

/** Workspace pill — used by both the DOM descriptor and TopBar's dedicated
 *  workspace-tab context menu (which has only {id,name}, not a DOM node). */
export function buildWorkspacePill(wsId: string, wsName: string): PillPayload {
  return {
    kind: 'tool', display: wsName, icon: '🗂',
    detail: `[${t('reference.workspace_ref')}: "${wsName}" id=${wsId}]`,
    tooltip: { title: `🗂 ${t('reference.workspace')} · ${wsName}`, lines: [`id: ${wsId}`, t('reference.workspace_context_hint')] },
  };
}

export function buildComponentPill(p: { entityId?: number; entityName: string; comp: string; value: unknown }): PillPayload {
  const json = JSON.stringify({ [p.comp]: p.value }, null, 2);
  return {
    kind: 'entity', display: `${p.entityName}.${p.comp}`, icon: '🔧',
    detail: `[${t('reference.component_property')}: ${p.entityName}#${p.entityId ?? '?'}.${p.comp} = ${json}]`,
    tooltip: { title: `🔧 ${p.comp} · ${p.entityName}`, lines: [truncate(json, 80)] },
  };
}
