// packages/interface/src/core/plugin-foundation/errors.ts

export interface PluginConflictErrorInfo {
  readonly id: string;
  readonly subRegistryName: string;
  readonly existingOwner: string;
  readonly newOwner: string;
}

export class PluginConflictError extends Error {
  readonly info: PluginConflictErrorInfo;
  constructor(info: PluginConflictErrorInfo) {
    super(
      `[plugin-foundation] "${info.id}" in "${info.subRegistryName}" already owned by "${info.existingOwner}"; new owner "${info.newOwner}" rejected`,
    );
    this.name = 'PluginConflictError';
    this.info = info;
  }
}

export interface PluginSetupErrorInfo {
  readonly pluginId: string;
  readonly phase: 'setup' | 'cleanup';
  readonly cause: unknown;
}

export class PluginSetupError extends Error {
  readonly info: PluginSetupErrorInfo;
  constructor(info: PluginSetupErrorInfo) {
    super(
      `[plugin-foundation] plugin "${info.pluginId}" ${info.phase} threw: ${String(info.cause)}`,
    );
    this.name = 'PluginSetupError';
    this.info = info;
  }
}
