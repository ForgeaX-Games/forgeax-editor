// io/query-snapshot.ts — minimal read-only query surface for defineOp plan (M4)
//
// feat-20260706-editor-op-gateway-single-entry-b-catalog-defineop M4:
// Thin forwarder to engine createQueryState / queryRun. Returns plain-object
// value snapshots — NO TypedArray live references, NO World handle leak.
// Entity identity via existing _e2h/_h2e projection (OOS-7 — no rework).
//
// Anchors:
//   plan-strategy §2 D-4: plan signature has querySnapshot, no world
//   research F5: createQueryState + queryRun already exported, read-separated
//   requirements gap #3: minimal query surface, value-snapshot, read-only

import { createQueryState, queryRun } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { Entity } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-runtime';
import type { EntityId } from '../types';

// ── Component token map ─────────────────────────────────────────────────────
// Maps component name strings known by the editor to their engine tokens.
// Thin mapping — no generic metaprogramming needed for the minimal surface.

const COMP_NAME_TO_TOKEN: Record<string, unknown> = {
  'Transform': Transform,
  'Entity': Entity,
};

// ── Query snapshot ──────────────────────────────────────────────────────────
// Returns an array of plain objects. Each object has { entity: EntityId, ...componentFields }.
// Value-snapshot: NO TypedArray references — all fields are JS primitives.

export interface QuerySnapshotDescriptor {
  with: string[];
}

export type QuerySnapshotRow = { entity: EntityId } & Record<string, unknown>;

export type QuerySnapshotFn = (descriptor: QuerySnapshotDescriptor) => QuerySnapshotRow[];

export function querySnapshot(_world: World, descriptor: QuerySnapshotDescriptor): QuerySnapshotRow[] {
  // Always include Entity for row count and identity
  const allNames = descriptor.with.includes('Entity') ? descriptor.with : [...descriptor.with, 'Entity'];
  const tokens = allNames
    .map((name) => COMP_NAME_TO_TOKEN[name])
    .filter(Boolean);

  if (tokens.length === 0) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = createQueryState({ with: tokens as any[] });

  const rows: QuerySnapshotRow[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryRun(state as any, _world as any, (bundle: any) => {
    // Entity self column gives row count
    const entities = bundle.Entity?.self as { length: number; [index: number]: number } | undefined;
    if (!entities) return;
    const entityIds: number[] = [];
    for (let i = 0; i < entities.length; i++) {
      entityIds.push(entities[i] ?? 0);
    }

    for (let i = 0; i < entityIds.length; i++) {
      const row: QuerySnapshotRow = { entity: entityIds[i]! as EntityId };
      // For each queried component (including Entity), extract ith row value
      for (const compName of allNames) {
        if (compName === 'Entity') continue; // Entity is the row key, not a component field
        const compBundle = bundle[compName];
        if (!compBundle) continue;
        // Snapshot: read each field's ith value as JS primitive
        const fields: Record<string, unknown> = {};
        for (const [fieldName, col] of Object.entries(compBundle)) {
          if (col && typeof col === 'object') {
            // TypedArray / ManagedColumnReader access
            const colObj = col as { length?: number; [index: number]: unknown; get?: (i: number) => unknown };
            if (i < (colObj.length ?? 0)) {
              // Managed column (string/ref) has .get(i); TypedArray has [i]
              fields[fieldName] = typeof colObj.get === 'function' ? colObj.get(i) : colObj[i];
            }
          } else {
            fields[fieldName] = col;
          }
        }
        // Store per-component data under component name
        if (Object.keys(fields).length > 0) {
          row[compName] = fields;
        }
      }
      rows.push(row);
    }
  });

  return rows;
}