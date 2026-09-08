import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';

const root = new URL('../assets/vfx/', import.meta.url);
const source = JSON.parse(await readFile(0, 'utf8'));

async function modules() {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile() && entry.name.endsWith('.vfx.wgsl')) {
        result[name] = { entry: await readFile(path, 'utf8') };
      }
    }
  }
  await visit(root.pathname);
  return result;
}

const cooked = await cookParticleCodeEffect(source, await modules());
if (!cooked.ok) {
  process.stdout.write(JSON.stringify({ ok: false, error: cooked.error }));
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    product: {
      asset: cooked.value.asset,
      refs: cooked.value.refs,
      artifact: {
        ...cooked.value.artifact,
        bytes: [...cooked.value.artifact.bytes],
      },
    },
  }));
}
