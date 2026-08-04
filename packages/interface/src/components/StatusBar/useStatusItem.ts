// packages/interface/src/components/StatusBar/useStatusItem.ts
//
// ADR-0030 §2.2 — the ergonomic successor to the retired `useStatusBarItem`.
// Same human feel ("drop a chip onto the footer from any component, live data
// flows, auto-cleanup on unmount") but WITHOUT a parallel module store: it
// writes through host.contributeStatusItem → the single panels contribution
// registry. So it is owner-neutral yet reversible, and cross-realm-consistent.
//
// Live data: the render closure is read through a ref, so the chip always
// reflects the owner's latest state WITHOUT re-registering on every render
// (the old store re-`upsert`ed each render — this contributes once per id and
// lets the rendered node re-render itself).
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useHost } from '../../core/app-shell';
import type { StripLocationId } from '../../core/panels';

export interface UseStatusItemOptions {
  /** Higher = anchored; lower = rotates in the carousel on overflow. Default 0. */
  readonly priority?: number;
  /** Conditional visibility, re-evaluated by StripHostView. */
  readonly when?: () => boolean;
}

/** Register a live status-bar chip for this component's lifetime. */
export function useStatusItem(
  id: string,
  location: StripLocationId,
  render: () => ReactNode,
  opts?: UseStatusItemOptions,
): void {
  const host = useHost();
  const renderRef = useRef(render);
  renderRef.current = render;
  const whenRef = useRef(opts?.when);
  whenRef.current = opts?.when;
  const priority = opts?.priority;

  useEffect(() => {
    const off = host.contributeStatusItem({
      kind: 'status-item',
      id,
      location,
      priority,
      when: () => (whenRef.current ? whenRef.current() : true),
      item: { type: 'custom', render: () => renderRef.current() },
    });
    // Cleanup allows void|Promise<void>; useEffect's Destructor does not — wrap.
    return () => { void off(); };
  }, [host, id, location, priority]);
}
