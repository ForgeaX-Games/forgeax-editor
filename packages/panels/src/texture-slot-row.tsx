import type { ReactElement } from 'react';
import { AssetRefControl } from './AssetRefControl';
import { DROPPABLE_TEXTURE_KINDS } from './asset-ref-drop';
import { inspectorFieldLabel } from './inspector-field-label';
import type { AssetPickerAnchor } from './asset-picker-placement';

export interface TextureSlotRowProps {
  label: string;
  guid: string | null;
  canEdit: boolean;
  onAssign: (textureGuid: string) => void;
  onClear: () => void;
  onBrowse: (anchor: AssetPickerAnchor) => void;
}

/** Material texture parameter row — Inspector asset-ref chrome with texture kind filter. */
export function TextureSlotRow({
  label,
  guid,
  canEdit,
  onAssign,
  onClear,
  onBrowse,
}: TextureSlotRowProps): ReactElement {
  return (
    <div className="f-row" data-testid={`mat-${label}`}>
      <span className="f-name" title={label}>{inspectorFieldLabel(label)}</span>
      <span className="f-val">
        <AssetRefControl
          assetType="TextureAsset"
          guid={guid}
          testId={`mat-${label}`}
          readOnly={!canEdit}
          acceptKinds={DROPPABLE_TEXTURE_KINDS}
          onBrowse={onBrowse}
          onBind={onAssign}
          onClear={onClear}
        />
      </span>
    </div>
  );
}
