// composer-bridge — the L1 (interface) cross-app contract for the Chat composer.
//
// This is the chrome-level bridge any app/surface uses to push a reference into
// the chat composer WITHOUT sharing the chat store's internals. It owns three
// concerns that must stay in interface (per R4, docs/v2-vision/architecture-
// evolution/17): (1) the `PillPayload` wire model + sentinel codec, (2) the
// reference registry that maps a DOM target to a pill, and (3) the pending-
// insert slot (`requestComposerInsert` / `useComposerPendingInsert`). The chat
// app (@forgeax/chat) and chrome (App.tsx / ContextMenu / TopBar) talk through
// these exports; the chat store no longer exposes a `composerPendingInsert`
// field on `useShellStore`.
//
// ── Reference registry — the SINGLE source of truth for "what can be referenced
//    into the Chat composer, and how".
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

import { create } from 'zustand';
import { t } from '@/i18n';

// ── Pill data model + sentinel wire codec (was components/Composer/pill.ts) ──
//
// A "pill" is a structured reference token in the composer / chat history that:
//   - Displays as a compact chip ("📄 main.ts")
//   - Hovers to a detail tooltip (full path, kind, hints)
//   - On send, expands to a verbose text snippet the AI can act on
//
// The token is encoded into the otherwise-plaintext message string as:
//   ⟦pill:<base64url JSON payload>⟧
// `⟦` U+27E6 and `⟧` U+27E7 are extremely rare in normal user text, so this is
// effectively a private band the rest of the pipeline can pass through.

export type PillKind = 'file' | 'dir' | 'agent' | 'tool' | 'game' | 'log' | 'entity' | 'paste';

export interface PillPayload {
  kind: PillKind;
  display: string;
  icon?: string;
  detail: string;
  tooltip: { title: string; lines: string[] };
}

const SENTINEL_RE = /⟦pill:([A-Za-z0-9_\-]+=*)⟧/g;

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 ? '='.repeat(4 - (norm.length % 4)) : '';
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodePill(p: PillPayload): string {
  return `⟦pill:${b64urlEncode(JSON.stringify(p))}⟧`;
}

export function decodePill(token: string): PillPayload | null {
  const m = token.match(/^⟦pill:([A-Za-z0-9_\-]+=*)⟧$/);
  if (!m) return null;
  try {
    const obj = JSON.parse(b64urlDecode(m[1]));
    if (!obj || typeof obj !== 'object' || !obj.kind || !obj.detail) return null;
    return obj as PillPayload;
  } catch {
    return null;
  }
}

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'pill'; token: string; payload: PillPayload };

export function parseSegments(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTINEL_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) });
    const payload = decodePill(m[0]);
    if (payload) out.push({ kind: 'pill', token: m[0], payload });
    else out.push({ kind: 'text', text: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function expandPills(text: string): string {
  return text.replace(SENTINEL_RE, (full) => {
    const p = decodePill(full);
    return p ? p.detail : full;
  });
}

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

// ── Editor reference builders ───────────────────────────────────────────────
// The editor is in-process but its ECS units (entities/assets/components) are
// outside the shell DOM registry above. Its injected typed bridge calls these
// builders, keeping pill construction (icons/labels/detail format) in one place
// so it cannot drift from the DOM path.

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

export function buildAssetPill(p: { guid: string; name?: string; assetKind?: string; packPath?: string; payload?: Record<string, unknown> }): PillPayload {
  const name = p.name ?? p.guid.slice(0, 8);
  const isFolderSummary = p.assetKind === 'folder' && p.payload;
  let detail: string;
  if (isFolderSummary) {
    const s = p.payload as { totalAssets?: number; kinds?: Record<string, number>; guids?: string[] };
    const kindList = s.kinds ? Object.entries(s.kinds).map(([k, v]) => `${k} × ${v}`).join(', ') : '';
    detail = `[${t('reference.asset')}: folder="${name}" path=${p.packPath ?? ''} totalAssets=${s.totalAssets ?? 0} kinds=(${kindList})]`;
  } else if (p.payload) {
    const payloadStr = JSON.stringify(p.payload, null, 2);
    const truncPayload = payloadStr.length > 2000 ? payloadStr.slice(0, 2000) + '\n…(truncated)' : payloadStr;
    detail = `[${t('reference.asset')}: guid=${p.guid} kind=${p.assetKind ?? ''}${p.packPath ? ` pack=${p.packPath}` : ''}\npayload:\n${truncPayload}]`;
  } else {
    detail = `[${t('reference.asset')}: guid=${p.guid} kind=${p.assetKind ?? ''}${p.packPath ? ` pack=${p.packPath}` : ''}]`;
  }
  return {
    kind: 'entity', display: name, icon: isFolderSummary ? '📁' : '🧱',
    detail,
    tooltip: {
      title: `${isFolderSummary ? '📁' : '🧱'} ${t('reference.asset')} · ${name}`,
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

// ── Cross-app pending-insert slot ────────────────────────────────────────────
// Any surface (right-click "引用到 Chat", injected editor reference bridge, Content
// Browser batch) calls requestComposerInsert(pill); the Composer consumes it on its next
// render tick via useComposerPendingInsert(), inserts the chip at the caret, then
// clears. A queue lets batch "Add to AI Chat" (multi-select) insert all pills.
//
// Lives here (interface L1), NOT in the chat store, so the slot is a chrome-level
// bridge the chat app reads — chat never shares useShellStore internals (R4 §5.3).
interface ComposerInsertBridge {
  pendingInsert: PillPayload | null;
  queue: PillPayload[];
  request: (p: PillPayload) => void;
  clear: () => void;
}

const useComposerInsertBridge = create<ComposerInsertBridge>((set) => ({
  pendingInsert: null,
  queue: [],
  request: (p) => set((s) => ({
    queue: [...s.queue, p],
    pendingInsert: s.queue.length === 0 ? p : s.pendingInsert,
  })),
  clear: () => set((s) => {
    const q = s.queue.slice(1);
    return { queue: q, pendingInsert: q[0] ?? null };
  }),
}));

/** Publish a pill into the composer. Callable from any surface (no React ctx). */
export function requestComposerInsert(p: PillPayload): void {
  useComposerInsertBridge.getState().request(p);
}

/** React hook — the next pending pill to insert (null when none). */
export function useComposerPendingInsert(): PillPayload | null {
  return useComposerInsertBridge((s) => s.pendingInsert);
}

/** Drop the consumed pill and advance the queue. */
export function clearComposerPendingInsert(): void {
  useComposerInsertBridge.getState().clear();
}
