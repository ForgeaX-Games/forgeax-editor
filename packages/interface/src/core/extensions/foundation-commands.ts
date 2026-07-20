// packages/interface/src/core/extensions/foundation-commands.ts
//
// The commands primitive is already installed as a base capability by
// createAppHost. This plugin exists ONLY so downstream plugins can declare
// `requires: ['commands']` for lifecycle sequencing. setup is empty.
import type { AppExtension } from '../app-shell/types';

export const foundationCommandsExtension: AppExtension = {
  id: 'foundation.commands',
  version: '1.0.0',
  provides: [], // commands is a BASE capability; we do not re-provide.
  setup() { /* no-op */ },
};
