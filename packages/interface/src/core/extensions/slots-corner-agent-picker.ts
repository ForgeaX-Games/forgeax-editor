// packages/interface/src/core/extensions/slots-corner-agent-picker.ts
import type React from 'react';
import type { AppExtension } from '../app-shell/types';

export function createSlotsCornerAgentPickerExtension(
  CornerAgentPicker: React.ComponentType<{ preferredAgentExtensionId?: string }>,
): AppExtension {
  return {
    id: 'slots.corner-agent-picker', version: '1.0.0',
    contributes: { panels: { slots: { CornerAgentPicker } } },
  };
}
