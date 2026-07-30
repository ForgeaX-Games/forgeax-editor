import { describe, expect, it } from 'bun:test';
import * as facade from '@forgeax/editor/runtime-ui-diagnostics';

describe('runtime UI diagnostics facade export', () => {
  it('exports only the schema and typed operation contract', () => {
    expect(facade.createRuntimeUiOperations).toBeTypeOf('function');
    expect(facade.parseRuntimeUiDiagnostics).toBeTypeOf('function');
    expect(facade.RUNTIME_UI_OPERATION_MANIFEST).toHaveLength(2);
    expect(Object.keys(facade)).not.toContain('LiveWorldSelectorGraph');
  });
});
