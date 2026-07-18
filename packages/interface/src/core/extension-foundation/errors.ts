// packages/interface/src/core/extension-foundation/errors.ts

export interface ExtensionConflictErrorInfo {
  readonly id: string;
  readonly subRegistryName: string;
  readonly existingOwner: string;
  readonly newOwner: string;
}

export class ExtensionConflictError extends Error {
  readonly info: ExtensionConflictErrorInfo;
  constructor(info: ExtensionConflictErrorInfo) {
    super(
      `[extension-foundation] "${info.id}" in "${info.subRegistryName}" already owned by "${info.existingOwner}"; new owner "${info.newOwner}" rejected`,
    );
    this.name = 'ExtensionConflictError';
    this.info = info;
  }
}

export interface ExtensionSetupErrorInfo {
  readonly extensionId: string;
  readonly phase: 'setup' | 'cleanup';
  readonly cause: unknown;
}

export class ExtensionSetupError extends Error {
  readonly info: ExtensionSetupErrorInfo;
  constructor(info: ExtensionSetupErrorInfo) {
    super(
      `[extension-foundation] plugin "${info.extensionId}" ${info.phase} threw: ${String(info.cause)}`,
    );
    this.name = 'ExtensionSetupError';
    this.info = info;
  }
}
