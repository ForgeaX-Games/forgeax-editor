import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverAssetSource } from '../asset-source-recovery';
import { produceSourceMetadata } from '../../../packages/core/src/assets/source-metadata-producer';
import { projectRuntimeDiagnostic, resolveRuntimeDiagnosticAliases } from '../runtime-diagnostic';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'asset-source-recovery-'));
  roots.push(root);
  await mkdir(join(root, 'assets'));
  const path = join(root, 'assets', 'texture.png');
  await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  return { root, path };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('one-source metadata recovery', () => {
  test('reuses canonical simple producer and preserves valid identity while correcting source leaf', async () => {
    const { root, path } = await fixture();
    const original = await produceSourceMetadata({ bytes: new ArrayBuffer(0), sourceName: 'wrong.png' });
    if (!original.ok) throw new Error('fixture failed');
    await writeFile(path + '.meta.json', original.metaJson);
    const result = await recoverAssetSource(root, 'assets/texture.png');
    const meta = JSON.parse(await readFile(path + '.meta.json', 'utf8'));
    expect(meta.source).toBe('texture.png');
    expect(meta.subAssets).toEqual(JSON.parse(original.metaJson).subAssets);
    expect(result).toMatchObject({ sourcePath: 'assets/texture.png', metaPath: 'assets/texture.png.meta.json', metadataRebuilt: true });
    const second = await recoverAssetSource(root, 'assets/texture.png');
    expect(second.subAssets).toEqual(result.subAssets);
  });

  test('does not publish an orphan sidecar, replace corrupt identity, or follow external symlinks', async () => {
    const { root, path } = await fixture();
    await expect(recoverAssetSource(root, 'assets/missing.png')).rejects.toMatchObject({ code: 'asset-recovery-source-unavailable' });
    await expect(readFile(join(root, 'assets/missing.png.meta.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path + '.meta.json', '{broken');
    await expect(recoverAssetSource(root, 'assets/texture.png')).rejects.toMatchObject({ code: 'asset-recovery-identity-unrecoverable' });
    expect(await readFile(path + '.meta.json', 'utf8')).toBe('{broken');
    const other = await fixture();
    await symlink(other.path, join(root, 'assets/external.png'));
    await expect(recoverAssetSource(root, 'assets/external.png')).rejects.toMatchObject({ code: 'asset-recovery-source-unavailable' });
    await expect(recoverAssetSource(root, '../texture.png')).rejects.toMatchObject({ code: 'asset-recovery-path-invalid' });
    await expect(recoverAssetSource(root, 'C:\\outside\\texture.png')).rejects.toMatchObject({ code: 'asset-recovery-path-invalid' });
  });

  test('rejects a symlink sidecar without touching its destination', async () => {
    const { root, path } = await fixture();
    const other = await fixture();
    await writeFile(other.path + '.meta.json', 'preserve');
    await symlink(other.path + '.meta.json', path + '.meta.json');
    await expect(recoverAssetSource(root, 'assets/texture.png')).rejects.toMatchObject({ code: 'asset-recovery-sidecar-invalid' });
    expect(await readFile(other.path + '.meta.json', 'utf8')).toBe('preserve');
  });

  test('reports unsupported sources without sidecar writes', async () => {
    const { root } = await fixture();
    await writeFile(join(root, 'assets/unknown.xyz'), 'source');
    await expect(recoverAssetSource(root, 'assets/unknown.xyz')).rejects.toMatchObject({ code: 'asset-recovery-format-unsupported' });
  });
});

test('diagnostic preserves structured scan causes with project-relative paths and no secret/stack', () => {
  const raw = { code: 'scan-failed', expected: 'valid catalog', hint: 'repair source',
    detail: { cause: { code: 'pack-orphan-meta', detail: { metaPath: '/project/assets/a.png.meta.json', expectedFile: '/project/assets/a.png' } }, token: 'private-token', stack: 'secret stack' },
    cause: { code: 'pack-malformed-meta', hint: 'problem /Users/you/private.json', detail: { ajvErrors: [{ instancePath: '/subAssets', message: 'bad topology' }] } },
  };
  const result = projectRuntimeDiagnostic(raw, '/project');
  expect(result).toMatchObject({ code: 'scan-failed', detail: { cause: { detail: { metaPath: './assets/a.png.meta.json' } } } });
  expect(JSON.stringify(result)).not.toContain('private-token');
  expect(JSON.stringify(result)).not.toContain('secret stack');
  expect(JSON.stringify(result)).not.toContain('/Users/');
  const cycle: Record<string, unknown> = { code: 'cycle' }; cycle.cause = cycle;
  expect(() => projectRuntimeDiagnostic(cycle)).not.toThrow();
});

test('rebuilds a model through canonical glTF metadata and preserves its scene identity', async () => {
  const { root } = await fixture();
  const source = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Root' }] });
  await writeFile(join(root, 'assets/model.gltf'), source);
  const first = await recoverAssetSource(root, 'assets/model.gltf');
  expect(first.subAssets.some((entry) => entry.kind === 'scene')).toBe(true);
  const second = await recoverAssetSource(root, 'assets/model.gltf');
  expect(second.subAssets).toEqual(first.subAssets);
});


test('projects only realpath-verified farm roots and respects physical prefix boundaries', async () => {
  const { root } = await fixture();
  const outside = await fixture();
  const alias = join(outside.root, 'farm-alias');
  await symlink(join(root, 'assets'), alias);
  const aliases = resolveRuntimeDiagnosticAliases(root, [alias, join(outside.root, 'assets')]);
  expect(aliases).toEqual([{ path: alias, projectPath: './assets' }]);
  const diagnostic = projectRuntimeDiagnostic({ code: 'pack-orphan-meta', detail: {
    metaPath: join(alias, 'missing.png.meta.json'),
    expectedFile: join(alias, 'missing.png'),
    unrelated: join(outside.root, 'assets/private.png'),
    samePrefix: root + '-other/assets/private.png',
  } }, root, aliases);
  expect(diagnostic).toMatchObject({ detail: {
    metaPath: './assets/missing.png.meta.json', expectedFile: './assets/missing.png',
    unrelated: '<external-path>', samePrefix: '<external-path>',
  } });
});
