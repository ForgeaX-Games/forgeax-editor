// packages/interface/src/core/plugins/foundation-commands.ts
//
// The commands primitive is already installed as a base capability by
// createAppHost. This plugin exists ONLY so downstream plugins can declare
// `requires: ['commands']` for lifecycle sequencing. setup is empty.
import type { AppPlugin } from '../app-shell/types';

export const foundationCommandsPlugin: AppPlugin = {
  id: 'foundation.commands',
  version: '1.0.0',
  provides: [], // commands is a BASE capability; we do not re-provide.
  setup() { /* no-op */ },
};
