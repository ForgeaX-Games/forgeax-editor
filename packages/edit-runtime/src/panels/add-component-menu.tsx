// add-component-menu.tsx — "+ Add Component" menu for the Inspector (M5 w26).
//
// Lists all registered components from engine's registry, grouped by
// mountable (not yet on the selected entity) vs already-mounted (repeat).
// Clicking a mountable item dispatches an addComponent command through
// the shared bus (which reaches the main viewport via BroadcastChannel
// sync in popout context, or applies directly in main).
//
// Anchors:
//   requirements AC-12: Inspector Add Component menu with mountable/unmountable grouping
//   research Finding 5: getRegisteredComponents ready (component.ts:598)
//   charter F1: all component options visible in one place

import { useState, type ReactNode } from 'react';
import { getRegisteredComponents } from '@forgeax/engine-ecs';
import { defaultComponentData } from '@forgeax/editor-core';
import { dispatch, useSelection } from '@forgeax/editor-shared';

// ── AddComponentMenu ────────────────────────────────────────────────────────

export interface AddComponentMenuProps {
  /** Names of components already mounted on the selected entity.
   *  Passed explicitly so the component is a pure renderer. */
  mountedComponents: string[];
}

export function AddComponentMenu({ mountedComponents }: AddComponentMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const sel = useSelection();

  const allRegistered: string[] = [];
  for (const [name] of getRegisteredComponents()) {
    allRegistered.push(name);
  }

  const mounted = new Set(mountedComponents);

  const mountable = allRegistered.filter((c) => !mounted.has(c));
  const unmountable = allRegistered.filter((c) => mounted.has(c));

  // Sort each group alphabetically.
  mountable.sort();
  unmountable.sort();

  const handleAdd = (comp: string) => {
    if (sel === null) return;
    dispatch({
      kind: 'addComponent',
      entity: sel,
      component: comp,
      value: defaultComponentData(comp),
    });
    setOpen(false);
  };

  return (
    <div
      className="add-comp-menu"
      data-testid="add-comp-menu"
      style={{ marginTop: 8, borderTop: '1px solid var(--border, #333)', paddingTop: 8 }}
    >
      <button
        type="button"
        className="tbtn"
        data-testid="add-comp-toggle"
        onClick={() => setOpen((prev) => !prev)}
      >
        {open ? '−' : '+'} Add Component
      </button>

      {open && (
        <div
          className="add-comp-dropdown"
          data-testid="add-comp-dropdown"
          style={{
            marginTop: 4,
            maxHeight: 300,
            overflowY: 'auto',
            border: '1px solid var(--border, #333)',
            borderRadius: 4,
            background: 'var(--bg2, #1a1a1a)',
          }}
        >
          {/* Mountable group */}
          {mountable.length > 0 && (
            <div data-testid="add-comp-mountable">
              <div
                className="field muted"
                data-testid="add-comp-mountable-header"
                style={{ padding: '4px 8px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}
              >
                Mountable ({mountable.length})
              </div>
              {mountable.map((comp) => (
                <button
                  key={comp}
                  type="button"
                  className="add-comp-item"
                  data-testid={`add-comp-item-${comp}`}
                  disabled={sel === null}
                  onClick={() => handleAdd(comp)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '3px 8px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--fg, #ccc)',
                    cursor: sel !== null ? 'pointer' : 'not-allowed',
                    fontSize: 13,
                  }}
                >
                  {comp}
                </button>
              ))}
            </div>
          )}

          {/* Unmountable group */}
          {unmountable.length > 0 && (
            <div data-testid="add-comp-unmountable">
              <div
                className="field muted"
                data-testid="add-comp-unmountable-header"
                style={{ padding: '4px 8px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' }}
              >
                Already Mounted ({unmountable.length})
              </div>
              {unmountable.map((comp) => (
                <div
                  key={comp}
                  className="add-comp-item-disabled"
                  data-testid={`add-comp-item-disabled-${comp}`}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '3px 8px',
                    color: 'var(--fg3, #555)',
                    fontSize: 13,
                  }}
                >
                  {comp}
                </div>
              ))}
            </div>
          )}

          {allRegistered.length === 0 && (
            <div className="field muted" style={{ padding: 8 }}>
              No components registered. Import or define components first.
            </div>
          )}
        </div>
      )}
    </div>
  );
}