// command-palette.tsx — global command palette overlay (M4, D-3)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// ⌘K global overlay. Data source is the single SSOT gateway.listOps() —
// no second operation list, no EDITOR_PANELS entry.
// Lists all registered ops (builtin + defined), filters by id/title/domain,
// and dispatches selected ops through the gateway.
//
// Anchors:
//   plan-strategy §2 D-3: command palette = global overlay, ⌘K
//   requirements AC-06: catalog UI — list builtin ops, cast ops visible
//   plan-strategy §4 R7: UI is pure renderer because data source is listOps

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { gateway } from '@forgeax/editor-core';
import type { OpDescriptor } from '@forgeax/editor-core';

// ── CommandPalette component ────────────────────────────────────────────────

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): ReactNode {
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fetch ops from the SSOT catalog
  const ops = gateway.listOps();

  // Filter by id / title / domain
  const filtered = filter
    ? ops.filter((o) =>
      o.id.toLowerCase().includes(filter.toLowerCase()) ||
      (o.title ?? '').toLowerCase().includes(filter.toLowerCase()) ||
      o.domain.toLowerCase().includes(filter.toLowerCase()),
    )
    : ops;

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIdx(0);
  }, [filter]);

  // Focus input on open
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
      setFilter('');
      setSelectedIdx(0);
    }
  }, [open]);

  // Keyboard handler
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const op = filtered[selectedIdx];
        if (op) {
          // Dispatch the selected op through the gateway
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          gateway.dispatch({ kind: op.id } as any);
          onClose();
        }
      }
    },
    [filtered, selectedIdx, onClose],
  );

  // Global Escape hook
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const domainLetter: Record<string, string> = { document: 'D', session: 'S', transient: 'T' };

  return (
    <div
      className="cmd-palette-backdrop"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="cmd-palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmd-palette-header">
          <input
            ref={inputRef}
            className="cmd-palette-input"
            type="text"
            placeholder="Type a command..."
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
        </div>
        <div className="cmd-palette-list">
          {filtered.length === 0 ? (
            <div className="cmd-palette-empty">No operations found</div>
          ) : (
            filtered.map((op, idx) => (
              <div
                key={op.id}
                className={`cmd-palette-item${idx === selectedIdx ? ' cmd-palette-item--selected' : ''}`}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  gateway.dispatch({ kind: op.id } as any);
                  onClose();
                }}
              >
                <span className="cmd-palette-item-domain" data-domain={op.domain}>
                  {domainLetter[op.domain] ?? '?'}
                </span>
                <span className="cmd-palette-item-title">{op.title ?? op.id}</span>
                <span className="cmd-palette-item-id">{op.id}</span>
                {op.source === 'defined' && (
                  <span className="cmd-palette-item-badge">cast</span>
                )}
              </div>
            ))
          )}
        </div>
        <div className="cmd-palette-footer">
          <span>{filtered.length} of {ops.length} ops</span>
          <span>↑↓ navigate · enter dispatch · esc close</span>
        </div>
      </div>
    </div>
  );
}