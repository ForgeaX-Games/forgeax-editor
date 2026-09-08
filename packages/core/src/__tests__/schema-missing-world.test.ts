import { describe, expect, it } from 'bun:test';
import type { World } from '@forgeax/engine-ecs';
import {
  defaultComponentData,
  fieldSchema,
  getComponentSchema,
  isComponentHidden,
  listComponentSchemas,
} from '../scene/schema';

describe('component schema reads during the cross-game realm gap', () => {
  it('fail soft when the active World is temporarily absent', () => {
    const missingWorld = undefined as unknown as World;

    expect(listComponentSchemas(missingWorld)).toEqual([]);
    expect(getComponentSchema('Transform', missingWorld)).toBeUndefined();
    expect(fieldSchema('Transform', 'pos', missingWorld)).toBeUndefined();
    expect(defaultComponentData('Transform', missingWorld)).toEqual({});
    expect(isComponentHidden('Entity', missingWorld)).toBe(false);
  });
});
