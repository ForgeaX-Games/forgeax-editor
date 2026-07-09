// packages/interface/src/core/plugins/slots-corner-agent-picker.ts
import type React from 'react';
import type { AppPlugin } from '../app-shell/types';

export function createSlotsCornerAgentPickerPlugin(
  CornerAgentPicker: React.ComponentType<{ preferredAgentPluginId?: string }>,
): AppPlugin {
  return {
    id: 'slots.corner-agent-picker', version: '1.0.0',
    requires: ['panels'],
    setup(ctx) { return ctx.contributePanels({ slots: { CornerAgentPicker } }); },
  };
}
