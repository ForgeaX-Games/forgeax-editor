// systems-panel.tsx — ep:systems dockable panel (M5 w25).
//
// Lists all systems from the global registry + world's active schedule,
// with per-system enable/disable toggles. In the popout / ep-chromeless
// iframe, system operations are relayed to the main viewport via the
// BroadcastChannel sync channel (t:'sysctl' messages); the panel also
// listens for snapshot broadcasts so the list stays live.
//
// Anchors:
//   requirements AC-11: system list panel with enable/disable controls
//   plan-strategy D-9: ep:systems panel
//   research Finding 6: addSystem/removeSystem/inspect ready
//   charter F1: single-entry indexability — all systems in one list

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { getRegisteredSystems } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';

// ── Types ──────────────────────────────────────────────────────────────────

/** Lightweight broken-module error shape (matches DiscoverError from
 *  editor-core discoverer-errors.ts). Uses structural typing so any object
 *  with .code / .expected / .hint is accepted — no deep import needed. */
export interface BrokenModuleError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly relPath?: string;
}

interface SystemEntry {
  name: string;
  active: boolean;
}

// ── BroadcastChannel helpers ───────────────────────────────────────────────

const SYSCTL_CHANNEL_PREFIX = 'forgeax:editor:sysctl:';

function openSysctlChannel(sceneId: string): BroadcastChannel | null {
  try {
    return new BroadcastChannel(`${SYSCTL_CHANNEL_PREFIX}${sceneId}`);
  } catch {
    return null;
  }
}

// ── SystemsPanel ────────────────────────────────────────────────────────────

export interface SystemsPanelProps {
  /** World instance — available when rendered inside the main viewport.
   *  In popout / ep-chromeless iframe this is null; system operations go
   *  through BroadcastChannel. */
  world: World | null;
  /** Scene identifier for scoping the BroadcastChannel. */
  sceneId: string;
  /**
   * Broken module errors from the discoverer (w22). Each entry has .code,
   * .expected, .hint, and optional .relPath for identifying the failing
   * module. Null / empty = no broken modules.
   */
  brokenModules?: BrokenModuleError[] | null;
}

export function SystemsPanel({ world, sceneId, brokenModules }: SystemsPanelProps): ReactNode {
  const [systems, setSystems] = useState<SystemEntry[]>([]);
  const [pendingOps, setPendingOps] = useState<Set<string>>(new Set());

  // ── Refresh the local system list ──
  const refreshList = useCallback(() => {
    const registered = getRegisteredSystems();
    const activeNames = world
      ? new Set(world.inspect().systems.map((s) => s.name))
      : new Set<string>();

    const entries: SystemEntry[] = [];
    for (const [name] of registered) {
      entries.push({ name, active: activeNames.has(name) });
    }
    setSystems(entries);
  }, [world]);

  // ── Initial list + poll for changes (BroadcastChannel driven when world=null) ──
  useEffect(() => {
    refreshList();

    if (world) {
      // When world is available, we can poll inspect() for changes.
      // (In a full HMR-aware system this would be event-driven, but for
      // M5 human visual verification polling is sufficient.)
      const interval = setInterval(refreshList, 2000);
      return () => clearInterval(interval);
    }

    // In popout mode, listen on the sysctl channel for list updates
    // pushed by the main viewport after apply.
    const ch = openSysctlChannel(sceneId);
    if (!ch) return;

    const onMessage = (ev: MessageEvent) => {
      const msg = ev.data as Record<string, unknown> | undefined;
      if (msg?.t === 'sysctl-snapshot' && Array.isArray(msg.systems)) {
        setSystems(msg.systems as SystemEntry[]);
      }
    };
    ch.addEventListener('message', onMessage);

    // Request initial list
    ch.postMessage({ t: 'sysctl-hello' });

    return () => {
      ch.removeEventListener('message', onMessage);
      try { ch.close(); } catch { /* already closed */ }
    };
  }, [world, sceneId, refreshList]);

  // ── Toggle single system on/off ──
  const toggleSystem = useCallback(
    (name: string, active: boolean) => {
      if (!world) {
        // Popout mode: relay via BroadcastChannel
        const ch = openSysctlChannel(sceneId);
        if (!ch) return;
        ch.postMessage({ t: 'sysctl', op: active ? 'remove' : 'add', name });
        try { ch.close(); } catch { /* ignore */ }
        return;
      }

      setPendingOps((prev) => new Set(prev).add(name));

      try {
        if (active) {
          world.removeSystem(name);
        } else {
          const handle = getRegisteredSystems().get(name);
          if (handle) {
            world.addSystem(handle);
          }
        }
        refreshList();
      } catch (err) {
        console.warn(`[SystemsPanel] toggle "${name}" failed:`, err);
      } finally {
        setPendingOps((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }

      // Broadcast the updated list for any listening popouts
      broadcastSnapshot(sceneId, world);
    },
    [world, sceneId, refreshList],
  );

  // ── Render ──
  const hasWorld = world !== null;
  const hasBroken = brokenModules && brokenModules.length > 0;

  return (
    <div className="panel" data-testid="panel-systems">
      <h3>Systems</h3>
      {!hasWorld && (
        <div className="field muted" data-testid="systems-no-world">
          Systems panel requires the main viewport context.
        </div>
      )}
      {systems.length === 0 && hasWorld && (
        <div className="field muted" data-testid="systems-empty">
          No systems registered. Define systems in your game scripts.
        </div>
      )}
      {systems.map((sys) => {
        const pending = pendingOps.has(sys.name);
        return (
          <div
            key={sys.name}
            className="field"
            data-testid={`system-row-${sys.name}`}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                className={`status-dot${sys.active ? ' on' : ''}`}
                data-testid={`system-dot-${sys.name}`}
                title={sys.active ? 'active' : 'inactive'}
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: sys.active ? 'var(--accent, #4a9)' : 'var(--fg3, #666)',
                }}
              />
              <span>{sys.name}</span>
            </span>
            <button
              type="button"
              className="tbtn"
              data-testid={`system-toggle-${sys.name}`}
              disabled={pending}
              onClick={() => toggleSystem(sys.name, sys.active)}
            >
              {pending ? '...' : sys.active ? 'Disable' : 'Enable'}
            </button>
          </div>
        );
      })}

      {/* ── Broken module indicator (w27) ── */}
      {hasBroken && (
        <div
          data-testid="broken-modules-section"
          style={{
            marginTop: 12,
            borderTop: '1px solid var(--border, #444)',
            paddingTop: 8,
          }}
        >
          <h4 style={{ color: 'var(--accent-warn, #f90)' }}>
            Broken Modules ({brokenModules!.length})
          </h4>
          {brokenModules!.map((err, i) => {
            const rel = (err as { relPath?: string }).relPath ?? `#${i + 1}`;
            const code = err.code ?? 'UNKNOWN';
            return (
              <div
                key={i}
                className="field broken-module"
                data-testid={`broken-module-${i}`}
                style={{
                  padding: '4px 8px',
                  marginBottom: 4,
                  background: 'rgba(255,153,0,.08)',
                  borderLeft: '3px solid var(--accent-warn, #f90)',
                  borderRadius: 3,
                  fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--accent-warn, #f90)' }}>
                  {rel}
                </div>
                <div style={{ opacity: 0.7 }}>Code: {code}</div>
                {err.hint && (
                  <div style={{ opacity: 0.6, fontStyle: 'italic' }}>{err.hint}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Utility: broadcast current system list to popouts ──

function broadcastSnapshot(sceneId: string, w: World): void {
  const registered = getRegisteredSystems();
  const activeNames = new Set(w.inspect().systems.map((s) => s.name));
  const systems: SystemEntry[] = [];
  for (const [name] of registered) {
    systems.push({ name, active: activeNames.has(name) });
  }

  const ch = openSysctlChannel(sceneId);
  if (!ch) return;
  ch.postMessage({ t: 'sysctl-snapshot', systems });
  try { ch.close(); } catch { /* ignore */ }
}