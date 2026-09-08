import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../../../..');

describe('authoring owner reverse gate', () => {
  it('has no legacy Editor authoring executor/action owner or alias files', () => {
    for (const relative of [
      'packages/edit-runtime/src/runtime/legacy-authoring-executor.ts',
      'packages/panels/src/asset-inspector/legacy-authoring-actions.ts',
    ]) expect(existsSync(resolve(root, relative))).toBe(false);
  });

  it('keeps the three authoring ids out of Gateway catalog/applier source', () => {
    const gateway = readFileSync(resolve(root, 'packages/core/src/io/gateway.ts'), 'utf8');
    const authoringIds = ['material.author.update', 'mesh.author.update', 'vfx.author.update'];
    for (const id of authoringIds) expect(gateway.includes(id)).toBe(false);
    expect(gateway).not.toMatch(/register(?:Builtin|Defined)Op\([^\n]*author\.update/u);
  });
});
