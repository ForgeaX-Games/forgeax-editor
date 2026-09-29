import type { ReactElement } from 'react';
import { AssetRefControl } from './AssetRefControl';
import type { AssetPickerAnchor } from './asset-picker-placement';

export interface MaterialAssetRefRowProps {
  label: string;
  guid: string | null | undefined;
  testId: string;
  readOnly?: boolean;
  onBrowse: (anchor: AssetPickerAnchor) => void;
  onBind: (guid: string) => void;
  onClear?: () => void;
}

/** Single MaterialAsset GUID field — Inspector asset-ref chrome without ECS handles. */
export function MaterialAssetRefRow({
  label,
  guid,
  testId,
  readOnly = false,
  onBrowse,
  onBind,
  onClear,
}: MaterialAssetRefRowProps): ReactElement {
  return (
    <div className="f-row" data-testid={testId}>
      <span className="f-name">{label}</span>
      <span className="f-val">
        <AssetRefControl
          assetType="MaterialAsset"
          guid={guid ?? null}
          testId={testId}
          readOnly={readOnly}
          onBrowse={onBrowse}
          onBind={onBind}
          onClear={onClear ?? (() => {})}
        />
      </span>
    </div>
  );
}
