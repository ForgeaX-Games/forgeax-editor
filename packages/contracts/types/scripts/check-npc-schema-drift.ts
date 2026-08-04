import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageRoot = join(import.meta.dir, '..');
const artifactRoot = join(packageRoot, 'schemas', 'npc');
const generatedRoot = mkdtempSync(join(tmpdir(), 'forgeax-npc-schema-'));

try {
  const result = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'generate-npc-schemas.ts')], {
    cwd: packageRoot,
    env: { ...process.env, NPC_SCHEMA_OUTPUT_DIR: generatedRoot },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const committed = readdirSync(artifactRoot).sort();
  const generated = readdirSync(generatedRoot).sort();
  const failures: string[] = [];
  if (JSON.stringify(committed) !== JSON.stringify(generated)) failures.push('artifact file list differs');
  for (const name of new Set([...committed, ...generated])) {
    const current = committed.includes(name) ? readFileSync(join(artifactRoot, name), 'utf8') : undefined;
    const expected = generated.includes(name) ? readFileSync(join(generatedRoot, name), 'utf8') : undefined;
    if (current !== expected) failures.push(name);
  }
  if (failures.length > 0) {
    console.error(`[npc-schema] drift detected: ${failures.join(', ')}`);
    console.error('Run `bun run generate:npc-schemas` in packages/contracts/types.');
    process.exit(1);
  }
  console.log(`[npc-schema] ${committed.length} artifacts match the Zod SSOT`);
} finally {
  rmSync(generatedRoot, { recursive: true, force: true });
}
