import type { CBSelection } from './types';
import { useLastSelectionDomain } from '@forgeax/editor-core';

interface Props {
  totalItems: number;
  selection: CBSelection;
}

// T5-1 / C4-4: a small scope indicator that lights when the panel's selection
// domain is the current Delete-jurisdiction domain. Pure visual clue — the
// routing decision itself lives in the keyboard router (interface submodule).
function DeleteScopeRing({ active, domain }: { active: boolean; domain: 'entity' | 'asset' }) {
  const other = domain === 'entity' ? 'Hierarchy 实体' : 'Content Browser 资产';
  const here = domain === 'entity' ? 'Hierarchy 实体' : 'Content Browser 资产';
  return (
    <span
      data-testid="delete-scope-ring"
      data-domain={domain}
      data-active={active}
      title={active ? `Delete 键当前管辖：${here}` : `Delete 键当前管辖：${other}`}
      style={{
        display: 'inline-block',
        width: 9,
        height: 9,
        borderRadius: '50%',
        border: `2px solid ${active ? '#4ade80' : '#555'}`,
        background: active ? '#4ade80' : 'transparent',
        boxShadow: active ? '0 0 6px 1px #4ade80' : 'none',
        transition: 'all .15s ease',
        marginRight: 6,
      }}
    />
  );
}

export function CBStatusBar({ totalItems, selection }: Props) {
  const selCount = selection.items.length;
  // T5-1 / C4-4: light the ring when asset is the active Delete jurisdiction.
  const delDomain = useLastSelectionDomain();
  return (
    <div className="cb-status-bar">
      <DeleteScopeRing active={delDomain === 'asset'} domain="asset" />
      <span className="cb-status-count">
        {totalItems} item{totalItems !== 1 ? 's' : ''}
      </span>
      {selCount > 0 && (
        <span className="cb-status-selection">
          {' · '}{selCount} selected
        </span>
      )}
    </div>
  );
}
