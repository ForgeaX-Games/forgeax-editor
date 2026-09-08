import type { CommandError } from '../types';
import type {
  ArgsSchema,
  GatewayOpAvailability,
  GatewayOpDescriptor,
  GatewayOpSnapshot,
} from './catalog';

export const CAPABILITY_GENERATION_G0 = 'g0' as const;
export const CAPABILITY_GENERATION_G1 = 'g1' as const;
export const CREATE_ASSET_CAPABILITY_ID = 'scene.createAsset' as const;
export const CREATE_ASSET_OWNER = '@forgeax/editor-core OperationRun/applier contract owner' as const;
export const CREATE_ASSET_STAGE = 'preflight' as const;
export const CREATE_ASSET_RECOVERY_ACTION = 'owner.repair' as const;
export const CREATE_ASSET_DIAGNOSTIC_ID = 'q5-create-asset-terminal-run' as const;

const CREATE_ASSET_RECOVERY_ACTIONS = Object.freeze(['owner.repair', 'editor.discover']);

const CREATE_ASSET_ARGS_SCHEMA: ArgsSchema = {
  type: 'object',
  properties: {
    packPath: { type: 'string' },
    guid: { type: 'string' },
    assetKind: {
      type: 'string',
      enum: ['scene', 'material', 'material-instance', 'particle-effect', 'input-map'],
    },
    name: { type: 'string' },
    refs: { type: 'array', items: { type: 'string' } },
  },
  required: ['packPath', 'guid', 'assetKind', 'name'],
  additionalProperties: false,
};

const CREATE_ASSET_CALLABLE_ARGS_SCHEMA: ArgsSchema = {
  ...CREATE_ASSET_ARGS_SCHEMA,
  properties: {
    ...CREATE_ASSET_ARGS_SCHEMA.properties,
    requestId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: [...(CREATE_ASSET_ARGS_SCHEMA.required ?? []), 'requestId'],
};

const CREATE_ASSET_OPERATION_RUN = {
  acceptedStatuses: ['accepted', 'running'],
  terminalStatuses: ['succeeded', 'failed', 'cancelled'],
  read: { get: 'getOperationRun', wait: 'waitOperationRun', subscribe: 'subscribeOperationRun' },
  retry: { requiresNewRequestId: true },
  retention: { kind: 'terminal-only', maxTerminalRuns: 64 },
  cancellable: false,
} as const;

export function createCreateAssetBlockedAvailability(): GatewayOpAvailability {
  return {
    available: false,
    code: 'capability-blocked',
    reason: 'createAsset has no request-correlated terminal OperationRun.',
    resolution: 'Repair the owner seam, then reconnect and rediscover capabilities.',
    capabilityGeneration: CAPABILITY_GENERATION_G0,
    stage: CREATE_ASSET_STAGE,
    owner: CREATE_ASSET_OWNER,
    expected: 'request-correlated terminal OperationRun',
    recoveryAction: CREATE_ASSET_RECOVERY_ACTION,
    diagnosticId: CREATE_ASSET_DIAGNOSTIC_ID,
  };
}

export function createCreateAssetBlockedProjection(): GatewayOpDescriptor {
  return {
    id: 'createAsset',
    domain: 'document',
    argsSchema: CREATE_ASSET_ARGS_SCHEMA,
    source: 'registered',
    title: 'Create Asset',
    capabilityGeneration: CAPABILITY_GENERATION_G0,
    capabilityStatus: 'blocked',
    stage: CREATE_ASSET_STAGE,
    owner: CREATE_ASSET_OWNER,
    recoveryAction: CREATE_ASSET_RECOVERY_ACTION,
    diagnosticId: CREATE_ASSET_DIAGNOSTIC_ID,
    recoveryActions: CREATE_ASSET_RECOVERY_ACTIONS,
    availability: createCreateAssetBlockedAvailability(),
  };
}

export function createCreateAssetCallableProjection(): GatewayOpDescriptor {
  return {
    id: 'createAsset',
    domain: 'document',
    argsSchema: CREATE_ASSET_CALLABLE_ARGS_SCHEMA,
    source: 'registered',
    title: 'Create Asset',
    capabilityGeneration: CAPABILITY_GENERATION_G1,
    capabilityStatus: 'callable',
    operationRun: CREATE_ASSET_OPERATION_RUN,
    completion: { kind: 'asset-write', guidField: 'guid' },
    availability: { available: true },
  };
}

export function createCapabilitySnapshot(
  revision: number,
  ops: readonly GatewayOpDescriptor[],
  capabilityGeneration: string = CAPABILITY_GENERATION_G0,
): GatewayOpSnapshot {
  return Object.freeze({
    revision,
    capabilityGeneration,
    ops: Object.freeze([...ops]),
  });
}

export function createCapabilityBlockedError(operationId: string): CommandError {
  return {
    code: 'capability-blocked' as CommandError['code'],
    hint: `Operation "${operationId}" is blocked until its owner publishes a terminal OperationRun contract.`,
    owner: CREATE_ASSET_OWNER,
    category: 'state',
    operationId,
    retryable: false,
    recoveryActions: [...CREATE_ASSET_RECOVERY_ACTIONS],
    stage: CREATE_ASSET_STAGE,
    expected: 'request-correlated terminal OperationRun',
    recoveryAction: CREATE_ASSET_RECOVERY_ACTION,
    diagnosticId: CREATE_ASSET_DIAGNOSTIC_ID,
    capabilityGeneration: CAPABILITY_GENERATION_G0,
  } as unknown as CommandError;
}
