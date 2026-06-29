import { useRef } from 'react';
import type { ReactElement } from 'react';
import type { BusPluginInfo } from '../../lib/bus-api';
import { surfaceKey } from '../../lib/platform';
import { StandalonePluginIframe, type PluginIframePane } from './StandalonePluginIframe';

interface Props {
  pane: PluginIframePane;
  /** The plugin that should currently be visible in this pane, or null when no
   *  standalone plugin is active. Must be a standalone-iframe plugin. */
  activePlugin: BusPluginInfo | null;
  /** Surface keys (kind:plugin:id:pane) currently detached to their own OS
   *  window. Those iframes are NOT rendered here so the surface isn't hosted
   *  twice; on redock the entry reappears and remounts. */
  floatingKeys?: Record<string, true>;
}

/**
 * Keep-alive iframe stack (Plan A — "render but hide" instead of unmount).
 *
 * Renders one <StandalonePluginIframe> per *visited* plugin, all stacked in a
 * single stable parent so the browser never re-parents them — re-parenting an
 * iframe in the DOM forces a full reload, which is exactly the "panel switch
 * feels like a restart" symptom we are killing. Switching panels only flips
 * which child is `active`:
 *   - active  → visible & interactive
 *   - others  → CSS-hidden (visibility:hidden) but mounted & alive, so
 *               switching back is a one-frame composite: zero reload, zero
 *               bootstrap, full state (WebGL ctx / WS / scroll) preserved.
 *
 * The visited set only grows (no LRU — Plan B deferred; workbench plugin count
 * is small and Plan C pauses hidden plugins' render loops so idle cost is low).
 */
export function KeepAlivePluginIframes({ pane, activePlugin, floatingKeys }: Props): ReactElement {
  // Insertion-ordered registry of every plugin ever activated in this pane.
  // A ref (not state) keeps the iframe DOM nodes stable across re-renders; we
  // mutate it during render which is safe here because the operation is
  // idempotent and the freshly-added entry is read back in the same render.
  const visitedRef = useRef<Map<string, BusPluginInfo>>(new Map());

  if (activePlugin) {
    const prev = visitedRef.current.get(activePlugin.id);
    // Add on first visit; refresh the stored manifest if it changed (e.g. the
    // standalone entry just settled after a bus rescan).
    if (prev !== activePlugin) {
      visitedRef.current.set(activePlugin.id, activePlugin);
    }
  }

  const entries = [...visitedRef.current.values()].filter(
    (plugin) => !floatingKeys?.[surfaceKey({ kind: 'plugin', id: plugin.id, pane })],
  );

  return (
    <div className="fx-keepalive-stack">
      {entries.map((plugin) => {
        const isActive = plugin.id === activePlugin?.id;
        return (
          // `.fx-keepalive-item` is `position:absolute; inset:0`, so every visited
          // plugin's item fully overlaps the others and stacks by DOM order. The
          // inner iframe wrapper already goes `pointer-events:none` when inactive,
          // but the item DIV itself defaults to `pointer-events:auto` — so a
          // more-recently-visited (later-in-DOM) inactive item sat ON TOP of the
          // active one and swallowed every click. That's the "switch workbench and
          // come back → can't click anything" bug. Make inactive items fully
          // inert (click-through + hidden) so only the active item is a hit target.
          <div
            key={`${plugin.id}:${pane}`}
            className="fx-keepalive-item"
            style={isActive ? undefined : { pointerEvents: 'none', visibility: 'hidden' }}
            aria-hidden={isActive ? undefined : true}
          >
            <StandalonePluginIframe plugin={plugin} pane={pane} active={isActive} />
          </div>
        );
      })}
    </div>
  );
}
