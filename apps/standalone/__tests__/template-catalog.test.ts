import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { listGameTemplates } from '../template-catalog';

describe('editor-owned game template catalog', () => {
  test('reads valid projects from engine/templates', async () => {
    const templates = await listGameTemplates(resolve(import.meta.dir, '../../../packages/engine/templates'));

    expect(templates).toEqual(expect.arrayContaining([
      { slug: 'game-default', name: 'Default' },
      { slug: 'game-empty', name: 'Empty' },
    ]));
    expect(templates.map((template) => template.slug)).toEqual(
      [...templates.map((template) => template.slug)].sort(),
    );
  });
});
