// SceneInstance read model — the public editor projection of engine-owned
// instance state.
//
// The engine owns the live SceneInstance component, its source handle, member
// mapping, and override map. This file only defines the JSON-safe projection
// consumed by the Gateway/UI; it does not introduce an editor-side identity or
// persistence model.

import { Entity } from '@forgeax/engine-ecs';
import { SceneInstance } from '@forgeax/engine-render';
import { queryEachIncludingDisabled } from '../store/entity-state';
import type { World } from '@forgeax/engine-ecs';
import type { CommandError } from '../types';
import type { EntityHandle } from '../scene/scene-types';

export interface SceneInstanceSourceReadModel {
  readonly handle: number;
  readonly kind: string;
  readonly guid?: string;
  readonly name?: string;
  readonly builtin?: boolean;
  readonly meta?: Record<string, unknown>;
}

export interface SceneInstanceMemberReadModel {
  readonly entity: EntityHandle;
  readonly localId: number;
  readonly name: string;
  readonly detached: boolean;
}

export interface SceneInstanceOverrideReadModel {
  readonly member: EntityHandle;
  readonly localId: number;
  readonly component: string;
  readonly field?: string;
  readonly value: unknown;
}

export interface SceneInstanceReadModel {
  readonly root: EntityHandle;
  readonly source: SceneInstanceSourceReadModel;
  readonly members: readonly SceneInstanceMemberReadModel[];
  readonly overrides: readonly SceneInstanceOverrideReadModel[];
}

export type SceneInstanceReadResult =
  | { readonly ok: true; readonly value: SceneInstanceReadModel }
  | { readonly ok: false; readonly error: CommandError };

/** Enumerate SceneInstance roots directly from the component, including the
 * synthetic root which intentionally has no Name component. Editor-hidden
 * roots (Disabled marker) are included: hiding is a viewport affordance, not
 * a structural removal — the read model must still project the instance. */
export function sceneInstanceRoots(world: unknown): EntityHandle[] {
  const roots: EntityHandle[] = [];
  queryEachIncludingDisabled(world as World, [SceneInstance, Entity], (h) => roots.push(h as EntityHandle));
  return roots;
}

/** Copy engine column values into the same plain JSON-safe shape used by the
 * Gateway query surface. */
export function snapshotSceneInstanceValue(value: unknown): unknown {
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>);
  if (Array.isArray(value)) return value.map(snapshotSceneInstanceValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = snapshotSceneInstanceValue(nested);
    return out;
  }
  return value;
}
