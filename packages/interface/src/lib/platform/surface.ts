/**
 * Surface descriptor — the shared contract between keep-alive (in-window) and
 * windowing (out-of-window / detached) hosting.
 *
 * A "surface" is the smallest独立可托管单元:今天是一个插件 iframe(可带
 * left/center pane),未来会扩展到内置面板(agents / files / chat)。无论它被
 * keep-alive 在主窗里,还是被弹成独立 OS 窗口,描述它的都是同一个
 * `SurfaceDescriptor`。
 *
 * 窗口化时我们把描述符编码进子窗的 URL(`index.html?surface=...`),子窗的
 * `main.tsx` 解码后用 `<DetachedSurface>` 只渲染这一个 surface —— 这样子窗
 * 复用同一套前端代码,无需多 HTML 入口。
 */

export type SurfacePane = 'left' | 'center';

/** 今天只有 plugin 一种;panel(agents/files/chat)在窗口化扩到全 surface 时加入。 */
export type SurfaceKind = 'plugin' | 'panel';

export interface SurfaceDescriptor {
  kind: SurfaceKind;
  /** plugin: bus plugin id;panel: 内置面板 id(如 'agents' | 'files' | 'chat')。 */
  id: string;
  pane?: SurfacePane;
}

/** Stable key used by the keep-alive registry AND as the Tauri window label
 *  suffix. Must be filesystem/label safe (Tauri labels disallow some chars). */
export function surfaceKey(d: SurfaceDescriptor): string {
  const pane = d.pane ? `:${d.pane}` : '';
  return `${d.kind}:${d.id}${pane}`;
}

/** Tauri window labels must match /^[a-zA-Z0-9_-/:]+$/ — sanitize the key. */
export function surfaceWindowLabel(d: SurfaceDescriptor): string {
  return `fx-surface-${surfaceKey(d).replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
}

/** Encode a descriptor as URL query params for a detached window entry. */
export function encodeSurfaceQuery(d: SurfaceDescriptor): string {
  const p = new URLSearchParams();
  p.set('surface', d.kind);
  p.set('id', d.id);
  if (d.pane) p.set('pane', d.pane);
  return p.toString();
}

/** Decode the current location's surface descriptor, or null if this is the
 *  normal full-shell entry (no `?surface=`). */
export function decodeSurfaceFromLocation(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): SurfaceDescriptor | null {
  const p = new URLSearchParams(search);
  const kind = p.get('surface');
  const id = p.get('id');
  if (!kind || !id) return null;
  if (kind !== 'plugin' && kind !== 'panel') return null;
  const pane = p.get('pane');
  return {
    kind,
    id,
    pane: pane === 'left' || pane === 'center' ? pane : undefined,
  };
}
