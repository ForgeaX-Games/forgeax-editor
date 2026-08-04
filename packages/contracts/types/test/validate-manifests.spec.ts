/**
 * Focused regression for flat Marketplace extension discovery + validation.
 * Layout: packages/marketplace/extensions/<slug>/forgeax-extension.json
 * User:   ~/.forgeax/extensions/<slug>/forgeax-extension.json
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findRepoRoot, listManifests, validate } from './validate-manifests';

const TMP = `/tmp/forgeax-validate-manifests-flat-${process.pid}`;

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('listManifests · flat extension layout', () => {
  it('discovers real Marketplace forgeax-extension.json under extensions/<slug>/', () => {
    const repoRoot = findRepoRoot(resolve(import.meta.dirname, '..'));
    const files = listManifests(repoRoot);

    expect(files.length).toBeGreaterThan(10);
    const marketplaceFiles = files.filter((f) =>
      f.includes('/packages/marketplace/extensions/')
    );
    expect(marketplaceFiles.length).toBeGreaterThan(10);
    expect(marketplaceFiles.every((f) => f.endsWith('/forgeax-extension.json'))).toBe(true);
    expect(marketplaceFiles.some((f) => f.endsWith('/extensions/admin/forgeax-extension.json'))).toBe(true);
    expect(marketplaceFiles.some((f) => f.includes('/plugins/'))).toBe(false);
    expect(marketplaceFiles.some((f) => f.endsWith('forgeax-plugin.json'))).toBe(false);
  });

  it('discovers only depth-one slug dirs (not nested apps/ fixtures)', () => {
    mkdirSync(join(TMP, 'packages', 'marketplace', 'extensions', 'wb-demo'), { recursive: true });
    writeFileSync(
      join(TMP, 'packages', 'marketplace', 'extensions', 'wb-demo', 'forgeax-extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: '@forgeax-extension/wb-demo',
        version: '0.1.0',
        kind: 'workbench',
        displayName: 'Demo',
        provides: { workbench: { id: 'wb-demo' } },
      }),
    );
    mkdirSync(
      join(TMP, 'packages', 'marketplace', 'extensions', 'node-editor', 'apps', 'nested'),
      { recursive: true },
    );
    writeFileSync(
      join(
        TMP,
        'packages',
        'marketplace',
        'extensions',
        'node-editor',
        'apps',
        'nested',
        'forgeax-extension.json',
      ),
      JSON.stringify({
        schemaVersion: 1,
        id: '@forgeax-extension/nested',
        version: '0.1.0',
        kind: 'workbench',
        displayName: 'Nested',
        provides: { workbench: { id: 'nested' } },
      }),
    );
    writeFileSync(join(TMP, 'AGENTS.md'), '# test\n');
    mkdirSync(join(TMP, 'packages'), { recursive: true });

    const files = listManifests(TMP).filter((file) =>
      file.startsWith(join(TMP, 'packages/marketplace/extensions'))
    );
    expect(files).toEqual([
      join(TMP, 'packages/marketplace/extensions/wb-demo/forgeax-extension.json'),
    ]);
  });
});

describe('validate · malformed extension', () => {
  it('rejects a malformed forgeax-extension.json', () => {
    mkdirSync(join(TMP, 'bad'), { recursive: true });
    const path = join(TMP, 'bad', 'forgeax-extension.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        id: 'not-a-scoped-id',
        version: '0.1.0',
        kind: 'workbench',
        displayName: 'Bad',
        provides: { workbench: { id: 'bad' } },
      }),
    );

    const finding = validate(path);
    expect(finding.ok).toBe(false);
    expect(finding.errors?.length).toBeGreaterThan(0);
  });
});
