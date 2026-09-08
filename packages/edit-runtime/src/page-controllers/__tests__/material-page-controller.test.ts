import { afterEach, describe, expect, it } from 'bun:test';
import {
  createMaterialPageController,
  getMaterialPageController,
  invokeMaterialPageSave,
  resolveProjectMaterialRevision,
  saveMaterialStagingForGuid,
  trySaveDirtyMaterialStaging,
} from '../material-page-controller';
import {
  closeMaterialStaging,
  isMaterialStagingDirty,
  openMaterialStaging,
  patchMaterialStagingParam,
} from '@forgeax/editor-core';
import type { PageControllerContext } from '@forgeax/interface/core/page-platform';
import type { AuthoringGatewayProjection } from '../../runtime/tool-client-operations';

const GUID = '44444444-4444-4444-8444-444444444444';
const TYPE_ID = '@forgeax/editor#page/material';
const KEY = { cardinality: 'resource' as const, typeId: TYPE_ID, resourceId: GUID };

afterEach(() => {
  closeMaterialStaging(GUID);
});

describe('material-page-controller', () => {
  it('initializes staging and manages dirty / prepareClose lifecycle', () => {
    const context: PageControllerContext = {
      key: KEY,
      context: {},
      resource: {
        canonicalId: GUID,
        uri: 'forgeax://assets/mat_test',
        displayPath: 'assets/mat_test.pack.json',
        metadata: {
          asset: {
            guid: GUID,
            packPath: 'assets/mat_test.pack.json',
            name: 'mat_test',
            payload: { values: { metallic: 0.1 } },
          },
        },
      },
    };

    const controller = createMaterialPageController(context);
    const encodedKey = `page:v1:r:${encodeURIComponent(TYPE_ID)}:${GUID}`;
    expect(getMaterialPageController(encodedKey)).toBe(controller);

    // Initial clean state
    expect(controller.prepareClose('user')).toEqual({ status: 'ready' });

    // Modify parameter
    patchMaterialStagingParam(GUID, { metallic: 0.8 });
    expect(isMaterialStagingDirty(GUID)).toBe(true);

    // Dirty state on close
    const closeRes = controller.prepareClose('user');
    expect((closeRes as { status: string }).status).toBe('dirty');

    // Discard restores clean state
    controller.discard?.();
    expect(isMaterialStagingDirty(GUID)).toBe(false);
    expect(controller.prepareClose('user')).toEqual({ status: 'ready' });

    // Dispose cleans up
    controller.dispose?.();
    expect(getMaterialPageController(encodedKey)).toBeUndefined();
  });

  it('routes material save through the host ToolClient projection with the Project revision', async () => {
    const calls: unknown[] = [];
    const authoringGateway = {
      begin(subject: { kind: 'material'; guid: string }, initial: Record<string, unknown>, snapshot: { subject: { kind: 'material'; guid: string }; revision: string; state: unknown }) {
        return {
          update() {},
          cancel() {},
          async commit() {
            calls.push({ subject, initial, snapshot });
            return { ok: true, runId: 'run-material-1' };
          },
        };
      },
      async runMissing() { throw new Error('not used'); },
    } as unknown as AuthoringGatewayProjection;
    const context: PageControllerContext = {
      key: KEY,
      context: {},
      resource: {
        canonicalId: GUID,
        uri: 'forgeax://assets/mat_test',
        displayPath: 'assets/mat_test.pack.json',
        metadata: {
          asset: {
            guid: GUID,
            kind: 'material',
            packPath: 'assets/mat_test.pack.json',
            name: 'mat_test',
            revision: 'project:r7',
            payload: { values: { metallic: 0.1 } },
          },
        },
      },
    };
    const controller = createMaterialPageController(context, authoringGateway);
    patchMaterialStagingParam(GUID, { metallic: 0.8 });
    await controller.save?.();
    expect(calls).toMatchObject([{
      subject: { kind: 'material', guid: GUID },
      snapshot: { subject: { kind: 'material', guid: GUID }, revision: 'project:r7', state: { values: { metallic: 0.1 } } },
      initial: { values: { metallic: 0.8 } },
    }]);
    controller.dispose?.();
  });

  it('falls back to updateMaterialParams when the opened asset has no Project revision', async () => {
    const packCalls: unknown[] = [];
    const authoringGateway = {
      begin() {
        throw new Error('authoring.begin must not run for pack materials');
      },
      async runMissing() { throw new Error('not used'); },
    } as unknown as AuthoringGatewayProjection;
    const packSave = {
      async save(entry: unknown) {
        packCalls.push(entry);
        return { ok: true };
      },
    };
    const context: PageControllerContext = {
      key: KEY,
      context: {},
      resource: {
        canonicalId: GUID,
        uri: 'forgeax://assets/mat_test',
        displayPath: 'assets/mat_test.pack.json',
        metadata: {
          asset: {
            guid: GUID,
            kind: 'material',
            packPath: 'assets/mat_test.pack.json',
            name: 'mat_test',
            payload: { values: { metallic: 0.1 } },
          },
        },
      },
    };
    const controller = createMaterialPageController(context, authoringGateway, packSave);
    patchMaterialStagingParam(GUID, { metallic: 0.8 });
    await controller.save?.();
    expect(packCalls).toMatchObject([{
      packPath: 'assets/mat_test.pack.json',
      guid: GUID,
      staging: { values: { metallic: 0.8 } },
    }]);
    expect(isMaterialStagingDirty(GUID)).toBe(false);
    controller.dispose?.();
  });

  it('invokeMaterialPageSave keeps Ctrl+S on the material tab when the controller map misses', async () => {
    const packCalls: unknown[] = [];
    const packSave = {
      async save(entry: unknown) {
        packCalls.push(entry);
        return { ok: true };
      },
    };
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/mat_test.pack.json',
      name: 'mat_test',
      payload: { values: { metallic: 0.1 } },
    });
    patchMaterialStagingParam(GUID, { metallic: 0.8 });
    const encodedKey = `page:v1:r:${encodeURIComponent(TYPE_ID)}:${GUID}`;
    expect(getMaterialPageController(encodedKey)).toBeUndefined();
    expect(invokeMaterialPageSave(encodedKey, GUID)).toBe(true);
    expect(await saveMaterialStagingForGuid(GUID, undefined, undefined, packSave)).toBe(true);
    expect(packCalls).toMatchObject([{
      packPath: 'assets/mat_test.pack.json',
      guid: GUID,
      staging: { values: { metallic: 0.8 } },
    }]);
    expect(isMaterialStagingDirty(GUID)).toBe(false);
  });

  it('treats catalog import revisions as pack saves, not Project CAS', async () => {
    const packCalls: unknown[] = [];
    const authoringGateway = {
      begin() {
        throw new Error('authoring.begin must not run for catalog pack materials');
      },
      async runMissing() { throw new Error('not used'); },
    } as unknown as AuthoringGatewayProjection;
    const packSave = {
      async save(entry: unknown) {
        packCalls.push(entry);
        return { ok: true };
      },
    };
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/mat_test.pack.json',
      name: 'mat_test',
      payload: { values: { metallic: 0.1 } },
    });
    patchMaterialStagingParam(GUID, { metallic: 0.8 });
    expect(resolveProjectMaterialRevision('a'.repeat(64))).toBeUndefined();
    expect(await saveMaterialStagingForGuid(GUID, 'a'.repeat(64), authoringGateway, packSave)).toBe(true);
    expect(packCalls.length).toBe(1);
  });

  it('trySaveDirtyMaterialStaging intercepts Ctrl+S when staging is dirty', () => {
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/mat_test.pack.json',
      name: 'mat_test',
      payload: { values: { metallic: 0.1 } },
    });
    patchMaterialStagingParam(GUID, { metallic: 0.8 });
    expect(trySaveDirtyMaterialStaging()).toBe(true);
    expect(trySaveDirtyMaterialStaging()).toBe(true);
  });
});
