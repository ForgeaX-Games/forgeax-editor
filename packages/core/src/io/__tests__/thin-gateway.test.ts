import { describe, expect, it } from 'bun:test';
import { createThinGatewayProjection } from '../gateway';

describe('Thin Gateway authoring projection', () => {
  it('collapses a multi-frame gesture into one host ToolClient authority run', async () => {
    const calls: unknown[] = [];
    const gateway = createThinGatewayProjection({ run: async (request) => { calls.push(request); return { ok: true, runId: 'run-1' }; } });
    const gesture = gateway.begin(
      { kind: 'material', guid: 'mat-1' },
      { values: { roughness: 0.5 } },
      { subject: { kind: 'material', guid: 'mat-1' }, revision: 'project-r7', state: { values: { roughness: 0.5, metallic: 0.2 } } },
    );
    gesture.update({ values: { roughness: 0.4 } });
    gesture.update({ values: { roughness: 0.3 } });
    expect(await gesture.commit()).toMatchObject({ ok: true, runId: 'run-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      expectedRevision: 'project-r7',
      subject: { kind: 'material', guid: 'mat-1' },
      snapshot: { revision: 'project-r7', state: { values: { metallic: 0.2, roughness: 0.5 } } },
      patch: { values: { roughness: 0.3 } },
    });
  });

  it('cancel leaves Project untouched and missing operations stay structured unavailable', async () => {
    let called = false;
    const gateway = createThinGatewayProjection({ run: async () => { called = true; return { ok: true, runId: 'never' }; } });
    const gesture = gateway.begin(
      { kind: 'mesh', guid: 'mesh-1' },
      { materialSlots: [] },
      { subject: { kind: 'mesh', guid: 'mesh-1' }, revision: 'project-r2', state: { materialSlots: [] } },
    );
    gesture.cancel();
    expect(await gesture.commit()).toMatchObject({ ok: false, error: { code: 'authoring-gesture-cancelled' } });
    expect(called).toBe(false);
    await expect(gateway.runMissing('unknown.author.update')).rejects.toMatchObject({ code: 'authoring-operation-unavailable' });
  });
});
