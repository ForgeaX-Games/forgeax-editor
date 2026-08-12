import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('runtime UI diagnostics naming contract', () => {
  it('uses complete runtime UI terminology in the public facade', () => {
    const source = readFileSync(join(import.meta.dir, '../public/runtime-ui-diagnostics.ts'), 'utf8');
    expect(source).toContain('runtime UI diagnostics');
    expect(source).toContain('createRuntimeUiOperations');
    expect(source).not.toContain('active-world locator');
    expect(source).not.toContain('Playwright locator');
  });

  it('documents selector values as data reads rather than DOM locators', () => {
    const source = readFileSync(join(import.meta.dir, '../public/runtime-ui-diagnostics.ts'), 'utf8');
    expect(source).toContain('selector');
    expect(source).not.toContain('querySelector');
  });
});
