import {
  authorizeAssetMutation,
  preflightAssetMutation,
  type AssetMutationOperation,
  type AssetMutationRequest,
  type AssetPreflightResult,
  type AssetWorkspaceSnapshot,
} from '@forgeax/editor-core';
import type { CBAsset } from '../types';

export interface SubjectActionRequest {
  readonly operation: AssetMutationOperation;
  readonly asset: CBAsset;
  readonly snapshot: AssetWorkspaceSnapshot;
  readonly payload?: unknown;
  readonly expectedRevision?: string;
}

export interface SubjectActionGate {
  readonly request: AssetMutationRequest;
  readonly preflight: AssetPreflightResult;
}

export function preflightSubjectAction(request: SubjectActionRequest): SubjectActionGate {
  const mutation: AssetMutationRequest = {
    operation: request.operation,
    subjectId: request.asset.guid,
    ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
    ...(request.payload === undefined ? {} : { payload: request.payload }),
  };
  return { request: mutation, preflight: preflightAssetMutation(request.snapshot, mutation) };
}

export function authorizeSubjectAction(
  gate: SubjectActionGate,
  confirmationToken?: string,
): ReturnType<typeof authorizeAssetMutation> {
  return authorizeAssetMutation(gate.preflight, confirmationToken ?? gate.preflight.confirmation.token);
}
