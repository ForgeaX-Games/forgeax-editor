// R1-03 visual workflow: quality presets are one Gateway document op.
// The test proves the op composes existing component writes, preserves the
// normal AI origin/ledger, and collapses to one undo step.

import { beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { EditGateway } from '../io/gateway';
import { querySnapshot } from '../io/query-snapshot';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';
import '../index';

function createGateway(): EditGateway {
  const session: EditSession = createEditSession();
  session.world = new World();
  return new EditGateway(session);
}

function rowFor(gateway: EditGateway, entity: number, component: string): Record<string, unknown> {
  const result = querySnapshot(gateway.doc.world!, { with: [component] });
  if (!result.ok) throw new Error(result.error.hint);
  const row = result.rows.find((candidate) => candidate.entity === entity);
  if (!row) throw new Error(`missing ${component} row for ${entity}`);
  return row[component] as Record<string, unknown>;
}

describe('applyVisualQualityPreset', () => {
  let gateway: EditGateway;
  let entity: number;

  beforeEach(() => {
    gateway = createGateway();
    const spawn = gateway.dispatch({
      kind: 'spawnEntity',
      name: 'Visual rig',
      components: {
        Camera: { bloom: 0, bloomBlurRadius: 2 },
        DirectionalLight: { direction: [-0.4, -1, -0.3], mapSize: 1024, cascadeCount: 2, pcfKernelSize: 1 },
        PointLightShadow: { mapSize: 256, pcfKernelSize: 1 },
      },
    });
    if (!spawn.ok || spawn.result === undefined) throw new Error(spawn.ok ? 'spawn returned no result' : spawn.error.hint);
    entity = spawn.result.created[0]!;
  });

  it('is cataloged with a public preset schema', () => {
    const descriptor = gateway.listOps().find((op) => op.id === 'applyVisualQualityPreset');
    expect(descriptor).toMatchObject({ domain: 'document', source: 'builtin', title: 'Apply Visual Quality Preset' });
    expect(descriptor?.argsSchema?.properties?.preset?.enum).toEqual(['draft', 'balanced', 'cinematic']);
  });

  it('applies one AI operation and undoes the whole composition in one step', () => {
    const beforeUndoDepth = gateway.historySteps().filter((step) => !step.future).length;
    const result = gateway.dispatch({ kind: 'applyVisualQualityPreset', preset: 'cinematic' }, 'ai');
    expect(result.ok).toBe(true);
    expect(rowFor(gateway, entity, 'Camera')).toMatchObject({ bloom: 1, bloomBlurRadius: 8 });
    expect(rowFor(gateway, entity, 'DirectionalLight')).toMatchObject({ mapSize: 4096, cascadeCount: 4, pcfKernelSize: 5 });
    expect(rowFor(gateway, entity, 'PointLightShadow')).toMatchObject({ mapSize: 1024, pcfKernelSize: 5 });
    expect(gateway.historySteps().filter((step) => !step.future)).toHaveLength(beforeUndoDepth + 1);
    expect(gateway.auditLog().at(-1)).toMatchObject({ origin: 'ai', op: { kind: 'applyVisualQualityPreset', preset: 'cinematic' } });

    expect(gateway.undo()).toBe(true);
    expect(rowFor(gateway, entity, 'Camera')).toMatchObject({ bloom: 0, bloomBlurRadius: 2 });
    expect(rowFor(gateway, entity, 'DirectionalLight')).toMatchObject({ mapSize: 1024, cascadeCount: 2, pcfKernelSize: 1 });
    expect(rowFor(gateway, entity, 'PointLightShadow')).toMatchObject({ mapSize: 256, pcfKernelSize: 1 });
  });

  it('rejects an unknown preset through the structured Gateway error', () => {
    const result = gateway.dispatch({ kind: 'applyVisualQualityPreset', preset: 'ultra' } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGS');
  });
});
