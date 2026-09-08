import { useState, type ReactNode, type ReactElement } from 'react';
import { ForgeaxIcon } from '@forgeax/editor-ui';

// Shared Inspector shell for the read-only asset property forms rendered in the
// `asset-properties` panel. Every kind (mesh, texture, sampler, …) now renders on
// the canonical `.fx-inspector` primitives — a colored left-border category per
// dimension (dim-type / dim-all / dim-cap) with collapsible `.cat` sections —
// instead of a flat text dump, so every asset editor reads like the Inspector.

export type InspectorDim = 'type' | 'all' | 'cap';

/** Root wrapper: applies `.fx-inspector` and preserves each form's `preview-*` testid. */
export function InspectorForm({
  testId,
  children,
}: {
  testId: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div data-testid={testId} className="fx-inspector">
      {children}
    </div>
  );
}

/** Collapsible category with a dimension-colored left border (self-contained state). */
export function InspectorSection({
  id,
  title,
  dim = 'type',
  defaultCollapsed = false,
  children,
}: {
  id: string;
  title: string;
  dim?: InspectorDim;
  defaultCollapsed?: boolean;
  children: ReactNode;
}): ReactElement {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className={`cat dim-${dim}${collapsed ? ' collapsed' : ''}`} data-testid={`asset-section-${id}`}>
      <div className="cat-head" onClick={() => setCollapsed((value) => !value)}>
        <span className="car">
          <ForgeaxIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        </span>
        <span className="ct">{title}</span>
      </div>
      {!collapsed && <div className="cat-fields">{children}</div>}
    </div>
  );
}
