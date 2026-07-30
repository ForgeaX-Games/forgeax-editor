import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CORE_SRC = resolve(import.meta.dir, '..');
const INDEX_SOURCE = readFileSync(join(CORE_SRC, 'index.ts'), 'utf8');
const PUBLIC_GATEWAY_SOURCE = readFileSync(join(CORE_SRC, 'public', 'gateway.ts'), 'utf8');

function sourceFiles(root: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) result.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) result.push(path);
  }
  return result;
}

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').length;
}

describe('core cohesion characterization', () => {
  test('records a stable pre-split source inventory', () => {
    const files = sourceFiles(CORE_SRC);
    const largest = Math.max(...files.map(lineCount));

    expect(files.length).toBeGreaterThan(60);
    expect(largest).toBeGreaterThan(500);
    expect(INDEX_SOURCE).toContain("export * from './public/gateway';");
  });

  test('keeps the catalog/listOps surface owned by the existing registration source', () => {
    expect(PUBLIC_GATEWAY_SOURCE).toContain("export type { ArgsSchema, OpDescriptor } from '../io/catalog';");
    expect(INDEX_SOURCE).not.toContain('const EDITOR_PRODUCT_CATALOG');
    expect(INDEX_SOURCE).not.toContain('const PRODUCT_LIST_OPS');
  });
});
