import type { CBSelection } from './types';

interface Props {
  totalItems: number;
  selection: CBSelection;
}

export function CBStatusBar({ totalItems, selection }: Props) {
  const selCount = selection.items.length;
  return (
    <div className="cb-status-bar">
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
