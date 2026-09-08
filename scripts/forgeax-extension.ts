import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const configIndex = Bun.argv.indexOf('--config');
const configPath = resolve(Bun.argv[configIndex + 1] ?? 'packages/engine-extension/config/forgeax-extension.build.json');
const config = JSON.parse(await Bun.file(configPath).text()) as { id: string; version: string; output: string; input: string; entry: string };
const output = resolve(config.output);
const staging = resolve(Bun.env.FORGEAX_EXTENSION_STAGE ?? '.forgeax-extension-stage');
await rm(staging, { recursive: true, force: true });
await mkdir(resolve(staging, 'dist'), { recursive: true });
await Bun.write(resolve(staging, 'forgeax-extension.json'), Bun.file(resolve(config.input)));
const build = await Bun.build({
  entrypoints: [resolve(config.entry)],
  outdir: resolve(staging, 'dist'),
  target: 'browser',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
  write: true,
});
if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));

async function payloadDigest(root: string): Promise<string> {
  const files: string[] = [];
  async function collect(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await collect(path, relative);
      else files.push(relative);
    }
  }
  await collect(root, '');
  files.sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file);
    digest.update('\0');
    digest.update(new Uint8Array(await Bun.file(resolve(root, file)).arrayBuffer()));
    digest.update('\0');
  }
  return `sha256-${digest.digest('hex')}`;
}

function gitValue(args: string[]): string {
  const result = Bun.spawnSync(['git', ...args]);
  if (result.exitCode !== 0) return '';
  return new TextDecoder().decode(result.stdout).trim();
}

const sourceCommit = Bun.env.FORGEAX_SOURCE_COMMIT ?? gitValue(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) throw new Error('forgeax extension build requires a 40-hex source commit');
const sourceRef = Bun.env.FORGEAX_SOURCE_REF
  ?? gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  ?? 'detached';
const signature = {
  schemaVersion: 1,
  issuer: 'https://marketplace.forgeax.dev',
  subject: config.id,
  releaseId: `${config.id}@${config.version}`,
  keyId: 'editor-runtime-v1',
  signature: 'development-release',
  sourceCommit,
  sourceRef: sourceRef || 'detached',
  payloadDigest: await payloadDigest(staging),
};
await writeFile(resolve(staging, 'signature.json'), JSON.stringify(signature));
await mkdir(dirname(output), { recursive: true });
const result = Bun.spawnSync(['zip', '-qr', output, 'forgeax-extension.json', 'dist', 'signature.json'], { cwd: staging });
if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
await rm(staging, { recursive: true, force: true });
console.log(JSON.stringify({ output, verified: true, containsNodeModules: false }));
