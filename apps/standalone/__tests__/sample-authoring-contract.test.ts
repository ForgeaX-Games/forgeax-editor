import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createToolClient } from '@forgeax/engine-devkit';
import { GameProjectSchema } from '@forgeax/engine-project';

test('sample project exposes authoring commands through cold discovery', async () => {
  const projectRoot = resolve(import.meta.dir, '../../../games/sample');
  const manifest = await Bun.file(resolve(projectRoot, 'forge.json')).json();
  expect(GameProjectSchema.safeParse(manifest).success).toBe(true);
  const client = await createToolClient({ projectRoot });
  for (const id of ['authoring.snapshot.read', 'mesh.author.update', 'material.author.update', 'vfx.author.update']) {
    expect(client.describe(id)?.realm).toBe('build');
  }
}, 15_000);
