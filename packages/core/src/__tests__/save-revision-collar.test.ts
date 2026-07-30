// M2-T3: a save proves the revision it committed, not every edit that happens
// while its canonical write is in flight. The collar keeps a later authored
// mutation dirty even when the earlier save succeeds.

import { expect, test } from 'bun:test';

import { createDiskIo, type DiskIoDeps, type PersistenceGateway } from '../store/persistence/disk-io';
import { createScenePersistenceContext } from '../store/scene-persistence';
import type { EditSession } from '../types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

const pack = JSON.stringify({
  schemaVersion: '1.0.0',
  kind: 'internal-text-package',
  assets: [{
    guid: '550e8400-e29b-41d4-a716-446655440000',
    kind: 'scene',
    refs: [],
    payload: { entities: [{ localId: 'root' }] },
  }],
});

function makeFixture(): {
  readonly ctx: ReturnType<typeof createScenePersistenceContext>;
  readonly gateway: PersistenceGateway & { mutableRevision: { value: number } };
  readonly write: Deferred<Response>;
  readonly io: ReturnType<typeof createDiskIo>;
} {
  const ctx = createScenePersistenceContext();
  ctx.currentSceneId = 'shoot';
  ctx.isDirty = true;
  const mutableRevision = { value: 12 };
  const write = deferred<Response>();
  const gateway: PersistenceGateway & { mutableRevision: { value: number } } = {
    doc: { world: null as never },
    rev: mutableRevision.value,
    mutableRevision,
    replaceDoc(_doc: EditSession): void {},
    dispatch(_op): { ok: true } { return { ok: true }; },
  };
  Object.defineProperty(gateway, 'rev', { get: () => mutableRevision.value });
  const deps: DiskIoDeps = {
    ctx,
    gateway,
    fetch: async () => write.promise,
    fetchWithTimeout: async () => new Response('{}', { status: 200 }),
    resolveGamePath: (rel) => `/games/g1/${rel}`,
    notifyDocChanged: () => {},
    serializeForSave: () => pack,
  };
  return { ctx, gateway, write, io: createDiskIo(deps) };
}

test('successful save exposes committed/current revision and keeps later edits dirty', async () => {
  const fixture = makeFixture();
  const saving = fixture.io.doSaveDocToDisk({ acceptedRevision: 12 });
  fixture.gateway.mutableRevision.value = 13;
  fixture.ctx.isDirty = true;
  fixture.write.resolve(new Response('{}', { status: 200 }));
  const result = await saving;
  expect(result).toMatchObject({
    ok: true,
    result: {
      acceptedRevision: 12,
      committedRevision: expect.any(String),
      currentRevision: 13,
      dirty: true,
    },
  });
  expect(fixture.ctx.isDirty).toBe(true);
  expect(fixture.ctx.lastSelfSave).not.toBeNull();
});

test('successful save clears dirty only when the authored revision still matches', async () => {
  const fixture = makeFixture();
  const saving = fixture.io.doSaveDocToDisk({ acceptedRevision: 12 });
  fixture.write.resolve(new Response('{}', { status: 200 }));
  const result = await saving;
  expect(result).toMatchObject({
    ok: true,
    result: { acceptedRevision: 12, currentRevision: 12, dirty: false },
  });
  expect(fixture.ctx.isDirty).toBe(false);
});

test('write failure never clears dirty or publishes a committed revision', async () => {
  const fixture = makeFixture();
  const saving = fixture.io.doSaveDocToDisk({ acceptedRevision: 12 });
  fixture.gateway.mutableRevision.value = 13;
  fixture.write.resolve(new Response('nope', { status: 500 }));
  const result = await saving;
  expect(result).toMatchObject({ ok: false, error: { code: 'save-write-failed' } });
  expect(fixture.ctx.isDirty).toBe(true);
  expect(fixture.ctx.lastSelfSave).toBeNull();
});
