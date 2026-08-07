// OverrideFieldRow — UE-style "override checkbox + inherited/disabled value".
//
// Unchecked: control disabled, shows inheritedValue (grey).
// Checked: control enabled, edits local override value.

import type { ReactElement, ReactNode } from 'react';
import { Checkbox } from '@forgeax/editor-ui';

export interface OverrideFieldRowProps {
  readonly label: string;
  readonly enabled: boolean;
  readonly testId?: string;
  readonly children: ReactNode;
  readonly onEnabledChange: (enabled: boolean) => void;
}

export function OverrideFieldRow({
  label,
  enabled,
  testId,
  children,
  onEnabledChange,
}: OverrideFieldRowProps): ReactElement {
  return (
    <div
      className={`f-row mi-override-row${enabled ? '' : ' mi-override-inherited'}`}
      data-testid={testId}
      data-override-enabled={enabled ? 'true' : 'false'}
    >
      <span className="f-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Checkbox
          size="menu"
          checked={enabled}
          data-testid={testId ? `${testId}-override` : undefined}
          onCheckedChange={(value) => onEnabledChange(value === true)}
          aria-label={`Override ${label}`}
        />
        {label}
      </span>
      <span className="f-val" style={{ opacity: enabled ? 1 : 0.55 }}>
        {children}
      </span>
    </div>
  );
}
